const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const renameCalls = [];
const originalRename = fs.rename;
fs.rename = async function trackedRename(source, target) {
  renameCalls.push({ source: String(source), target: String(target) });
  return originalRename.call(this, source, target);
};

const { MultiRepoAgenticRunStatusWriter } = require("../dist/docs/multiRepoAgenticRunStatus");

async function main() {
  try {
    await testRunningCompletedAndAtomicMirrors();
    await testFailureRetainsCompletedArtifacts();
    await testCancellationIsDistinctFromFailure();
    await testResumeReusesValidPrefixAndPreservesAttempts();
    await testMissingArtifactInvalidatesPhaseAndFollowingPhases();
    await testCopilotReuseRequiresGeneratedOutput();
    await testSkippedPhaseAndArtifactBoundaries();
    await testLegacyStatusLoadsSafelyAndWorkspaceIsRecomputed();
    console.log("Agentic run-status tests passed (lifecycle, atomic mirrors, resumable attempts, artifact validation, legacy compatibility).");
  } finally {
    fs.rename = originalRename;
  }
}

async function testRunningCompletedAndAtomicMirrors() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-completed-"));
  const runId = "20260711T220000Z";
  renameCalls.length = 0;
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), runId);

  assert.strictEqual(writer.runId, runId);
  assert.strictEqual(
    writer.workspaceRoot,
    path.join(multiRepoRoot, "copilot-workspace", "agentic-ui-bff-be", runId)
  );
  await assertState(writer, multiRepoRoot, "running");
  assertAtomicStatusWrites(renameCalls, writer.workspaceRoot, multiRepoRoot);

  renameCalls.length = 0;
  await writer.startPhase("local-ui-analysis");
  let status = await assertState(writer, multiRepoRoot, "running");
  assert.strictEqual(phase(status, "local-ui-analysis").status, "running");
  assertAtomicStatusWrites(renameCalls, writer.workspaceRoot, multiRepoRoot);

  const uiArtifact = path.join(writer.workspaceRoot, "ui-index.jsonl");
  await fs.writeFile(uiArtifact, '{"page":"CustomerSearch"}\n', "utf8");
  await writer.completePhase("local-ui-analysis", {
    details: { summary: "One selected page indexed." },
    artifacts: [uiArtifact]
  });
  await writer.skipPhase("qwen-semantics", "Qwen is disabled in settings.");

  const finalDocumentPath = path.join(multiRepoRoot, "generated-docs", "agentic", "final.md");
  await fs.mkdir(path.dirname(finalDocumentPath), { recursive: true });
  await fs.writeFile(finalDocumentPath, "# Final technical analysis\n", "utf8");
  await writer.finishSuccess({ finalDocumentPath, estimatedTotalTokens: 321, requestCount: 7 });

  status = await assertState(writer, multiRepoRoot, "completed");
  assert.strictEqual(phase(status, "local-ui-analysis").status, "completed");
  assertArtifactRecorded(phase(status, "local-ui-analysis"), uiArtifact);
  assert.strictEqual(phase(status, "qwen-semantics").status, "skipped");
  assert.match(JSON.stringify(phase(status, "qwen-semantics")), /Qwen is disabled/);
  assert.strictEqual(resultValue(status, "finalDocumentPath"), finalDocumentPath);
  assert.strictEqual(resultValue(status, "estimatedTotalTokens"), 321);
  assert.strictEqual(resultValue(status, "requestCount"), 7);
  assert.ok(status.completedAt, "completed status must include completedAt");
  await fs.access(uiArtifact);
  await fs.access(finalDocumentPath);
  await assertNoTemporaryStatusFiles(multiRepoRoot);
}

async function testFailureRetainsCompletedArtifacts() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-failed-"));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), "20260711T220100Z");

  await writer.startPhase("copilot-cross-layer-plan");
  const retainedArtifact = path.join(writer.workspaceRoot, "cross-layer-plan.md");
  await fs.writeFile(retainedArtifact, "# Retained partial Copilot output\n", "utf8");
  await writer.completePhase("copilot-cross-layer-plan", {
    details: { summary: "First Copilot step completed." },
    artifacts: [retainedArtifact]
  });
  await writer.startPhase("copilot-ui-analysis");
  await writer.finishFailure(new Error("Copilot returned an empty response."), false);

  const status = await assertState(writer, multiRepoRoot, "failed");
  assert.match(errorText(status), /empty response/i);
  assert.strictEqual(phase(status, "copilot-cross-layer-plan").status, "completed");
  assertArtifactRecorded(phase(status, "copilot-cross-layer-plan"), retainedArtifact);
  assert.strictEqual(phase(status, "copilot-ui-analysis").status, "failed");
  assert.match(errorText(phase(status, "copilot-ui-analysis")), /empty response/i);
  assert.ok(status.completedAt, "failed status must include completedAt");
  assert.strictEqual(await fs.readFile(retainedArtifact, "utf8"), "# Retained partial Copilot output\n");
  await assertNoTemporaryStatusFiles(multiRepoRoot);
}

async function testCancellationIsDistinctFromFailure() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-cancelled-"));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), "20260711T220200Z");

  await writer.startPhase("local-bff-analysis");
  await writer.finishFailure(new Error("User cancelled the Agentic pipeline."), true);

  const status = await assertState(writer, multiRepoRoot, "cancelled");
  assert.match(errorText(status), /cancelled/i);
  assert.strictEqual(phase(status, "local-bff-analysis").status, "cancelled");
  assert.ok(status.completedAt, "cancelled status must include completedAt");
  await assertNoTemporaryStatusFiles(multiRepoRoot);
}

async function testResumeReusesValidPrefixAndPreservesAttempts() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-resume-"));
  const runId = "20260711T220300Z";
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), runId);
  const uiArtifact = await createArtifact(writer.workspaceRoot, "ui-manifest.json", "{}\n");
  const bffArtifact = await createArtifact(writer.workspaceRoot, "bff-manifest.json", "{}\n");

  await writer.startPhase("local-ui-analysis");
  await writer.completePhase("local-ui-analysis", { artifacts: [uiArtifact], details: { files: 12 } });
  await writer.startPhase("local-bff-analysis");
  await writer.completePhase("local-bff-analysis", { artifacts: [bffArtifact], details: { endpoints: 6 } });
  await writer.startPhase("local-be-analysis");
  await writer.updatePhase("local-be-analysis", { details: { filesVisited: 3 } });
  await writer.finishFailure(new Error("Backend extraction stopped."), false);

  const resumed = await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest());
  assert.ok(resumed, "failed latest run should be loadable for resume");
  assert.strictEqual(resumed.runId, runId, "resume must retain the original run id");
  assert.strictEqual(resumed.workspaceRoot, writer.workspaceRoot, "resume must retain the run workspace");
  await resumed.prepareResume();

  const status = await assertState(resumed, multiRepoRoot, "running");
  assert.strictEqual(status.attempt, 2);
  assert.strictEqual(status.resumeCount, 1);
  assert.ok(status.resumedAt);
  assert.strictEqual(resumed.isPhaseReusable("local-ui-analysis"), true);
  assert.strictEqual(resumed.isPhaseReusable("local-bff-analysis"), true);
  assert.strictEqual(resumed.isPhaseReusable("local-be-analysis"), false);
  assert.strictEqual(resumed.currentAttempt("local-be-analysis"), 2);
  assert.strictEqual(phase(status, "local-be-analysis").status, "pending");
  assert.strictEqual(phase(status, "local-traceability").status, "pending");
  assert.strictEqual(resumed.currentAttempt("local-traceability"), 1, "never-started downstream phase remains on first attempt");

  const beHistory = resumed.phaseSnapshot("local-be-analysis").history;
  assert.strictEqual(beHistory.length, 1);
  assert.strictEqual(beHistory[0].attempt, 1);
  assert.strictEqual(beHistory[0].status, "failed");
  assert.match(beHistory[0].error, /Backend extraction stopped/);
  assert.deepStrictEqual(beHistory[0].details, { filesVisited: 3 });
  assert.strictEqual(status.history.length, 1);
  assert.strictEqual(status.history[0].status, "failed");

  const markdown = await fs.readFile(resumed.runStatusMarkdownPath, "utf8");
  assert.match(markdown, /Attempt: 2/);
  assert.match(markdown, /Previous attempts/);
  assert.match(markdown, /Backend extraction stopped/);

  await resumed.startPhase("local-be-analysis");
  await resumed.updatePhase("local-be-analysis", { details: { filesVisited: 8, retry: true } });
  await resumed.finishFailure(new Error("Backend extraction retry also stopped."), false);
  const secondResume = await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest());
  assert.ok(secondResume);
  await secondResume.prepareResume();
  assert.strictEqual(secondResume.currentAttempt("local-be-analysis"), 3);
  const repeatedHistory = secondResume.phaseSnapshot("local-be-analysis").history;
  assert.deepStrictEqual(repeatedHistory.map((item) => item.attempt), [1, 2]);
  assert.deepStrictEqual(repeatedHistory.map((item) => item.status), ["failed", "failed"]);
  assert.match(repeatedHistory[1].error, /retry also stopped/);
  assert.strictEqual(secondResume.snapshot().history.length, 2, "each failed run attempt remains auditable");
}

async function testMissingArtifactInvalidatesPhaseAndFollowingPhases() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-missing-artifact-"));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), "20260711T220400Z");
  const uiArtifact = await createArtifact(writer.workspaceRoot, "ui.json", "{}\n");
  const missingBffArtifact = await createArtifact(writer.workspaceRoot, "bff.json", "{}\n");
  const beArtifact = await createArtifact(writer.workspaceRoot, "be.json", "{}\n");

  await writer.startPhase("local-ui-analysis");
  await writer.completePhase("local-ui-analysis", { artifacts: [uiArtifact] });
  await writer.startPhase("local-bff-analysis");
  await writer.completePhase("local-bff-analysis", { artifacts: [missingBffArtifact] });
  await writer.startPhase("local-be-analysis");
  await writer.completePhase("local-be-analysis", { artifacts: [beArtifact] });
  await writer.startPhase("local-traceability");
  await writer.finishFailure(new Error("Traceability failed."), false);
  await fs.rm(missingBffArtifact);

  const resumed = await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest());
  assert.ok(resumed);
  const validation = await resumed.validatePhaseArtifacts("local-bff-analysis");
  assert.strictEqual(validation.valid, false);
  assert.deepStrictEqual(validation.missingArtifacts.map((artifact) => path.basename(artifact)), ["bff.json"]);
  await resumed.prepareResume();

  assert.strictEqual(resumed.isPhaseReusable("local-ui-analysis"), true);
  assert.strictEqual(resumed.isPhaseReusable("local-bff-analysis"), false);
  assert.strictEqual(resumed.isPhaseReusable("local-be-analysis"), false, "valid downstream artifacts cannot cross an invalid phase boundary");
  assert.strictEqual(resumed.phaseSnapshot("local-bff-analysis").status, "pending");
  assert.strictEqual(resumed.phaseSnapshot("local-bff-analysis").history[0].status, "completed");
  assert.strictEqual(resumed.phaseSnapshot("local-be-analysis").status, "pending");
  assert.strictEqual(resumed.phaseSnapshot("local-be-analysis").history[0].status, "completed");
}

async function testCopilotReuseRequiresGeneratedOutput() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-copilot-artifacts-"));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), "20260711T220500Z");
  const prompt = await createArtifact(writer.workspaceRoot, "cross-layer-plan-prompt.md", "prompt\n");
  const context = await createArtifact(writer.workspaceRoot, "cross-layer-plan-context.md", "context\n");

  await writer.startPhase("copilot-cross-layer-plan");
  await writer.completePhase("copilot-cross-layer-plan", { artifacts: [prompt, context] });
  let validation = await writer.validatePhaseArtifacts("copilot-cross-layer-plan");
  assert.strictEqual(validation.valid, false);
  assert.match(validation.reason, /no generated output Markdown/i);

  const output = await createArtifact(writer.workspaceRoot, "cross-layer-plan-attempt-2.md", "");
  await writer.updatePhase("copilot-cross-layer-plan", { artifacts: [output] });
  validation = await writer.validatePhaseArtifacts("copilot-cross-layer-plan");
  assert.strictEqual(validation.valid, false, "an empty Markdown file is not reusable Copilot output");
  await fs.writeFile(output, "# Generated plan\n", "utf8");
  validation = await writer.validatePhaseArtifacts("copilot-cross-layer-plan");
  assert.strictEqual(validation.valid, true);
  assert.strictEqual(validation.copilotOutputArtifact, output);
}

async function testSkippedPhaseAndArtifactBoundaries() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-boundaries-"));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), "20260711T220550Z");
  await writer.skipPhase("qwen-semantics", "Qwen is disabled.");
  const skippedValidation = await writer.validatePhaseArtifacts("qwen-semantics");
  assert.strictEqual(skippedValidation.valid, true, "a deliberately skipped phase does not require an artifact");

  const externalOutput = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-external-")), "ui-analysis.md");
  await fs.writeFile(externalOutput, "# External file must never be reused\n", "utf8");
  await writer.startPhase("copilot-ui-analysis");
  await writer.completePhase("copilot-ui-analysis", { artifacts: [externalOutput] });
  const externalValidation = await writer.validatePhaseArtifacts("copilot-ui-analysis");
  assert.strictEqual(externalValidation.valid, false);
  assert.deepStrictEqual(externalValidation.unsafeArtifacts, [externalOutput]);
  assert.match(externalValidation.reason, /outside the allowed run roots/i);
}

async function testLegacyStatusLoadsSafelyAndWorkspaceIsRecomputed() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-agentic-status-legacy-"));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest(), "20260711T220600Z");
  await writer.startPhase("local-ui-analysis");
  await writer.finishFailure(new Error("Legacy failure."), false);

  const paths = statusPaths(writer.workspaceRoot, multiRepoRoot);
  const legacy = JSON.parse(await fs.readFile(paths.latestJson, "utf8"));
  delete legacy.attempt;
  delete legacy.resumeCount;
  delete legacy.history;
  legacy.workspaceRoot = path.join(os.tmpdir(), "untrusted-status-workspace");
  for (const item of legacy.phases) {
    delete item.attempt;
    delete item.history;
  }
  await fs.writeFile(paths.latestJson, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const loaded = await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest());
  assert.ok(loaded, "version 1 status without attempt metadata must remain resumable");
  assert.strictEqual(loaded.workspaceRoot, writer.workspaceRoot, "serialized workspace path must not be trusted");
  assert.strictEqual(loaded.currentAttempt("local-ui-analysis"), 1);

  const differentManifest = { ...manifest(), branch: "different-branch" };
  assert.strictEqual(
    await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, differentManifest),
    undefined,
    "a run from another branch must not be resumed"
  );

  const unsupported = { ...legacy, schemaVersion: 2 };
  await fs.writeFile(paths.latestJson, `${JSON.stringify(unsupported, null, 2)}\n`, "utf8");
  assert.strictEqual(
    await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest()),
    undefined,
    "an unknown status schema must not be guessed or rewritten"
  );
  await fs.writeFile(paths.latestJson, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  await loaded.prepareResume();
  assert.strictEqual(loaded.currentAttempt("local-ui-analysis"), 2);
  assert.strictEqual(
    await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest()),
    undefined,
    "a running attempt must not be loaded concurrently as resumable"
  );
}

async function assertState(writer, multiRepoRoot, expectedStatus) {
  const snapshot = writer.snapshot();
  assert.strictEqual(snapshot.status, expectedStatus);

  const paths = statusPaths(writer.workspaceRoot, multiRepoRoot);
  const runJson = JSON.parse(await fs.readFile(paths.runJson, "utf8"));
  const latestJson = JSON.parse(await fs.readFile(paths.latestJson, "utf8"));
  const runMarkdown = await fs.readFile(paths.runMarkdown, "utf8");
  const latestMarkdown = await fs.readFile(paths.latestMarkdown, "utf8");

  assert.deepStrictEqual(runJson, snapshot, "run-local JSON must match the in-memory snapshot");
  assert.deepStrictEqual(latestJson, runJson, "latest JSON must mirror the run-local JSON");
  assert.strictEqual(latestMarkdown, runMarkdown, "latest Markdown must mirror the run-local Markdown");
  assert.match(runMarkdown, new RegExp(escapeRegExp(writer.runId)));
  assert.match(runMarkdown, new RegExp(expectedStatus, "i"));
  assert.match(runMarkdown, /boundary-project/);
  return runJson;
}

function assertAtomicStatusWrites(calls, workspaceRoot, multiRepoRoot) {
  const targets = new Set(calls.map((call) => path.normalize(call.target)));
  const expected = Object.values(statusPaths(workspaceRoot, multiRepoRoot)).map(path.normalize);
  for (const target of expected) {
    assert.ok(targets.has(target), `status file was not finalized with an atomic rename: ${target}`);
    const call = calls.find((entry) => path.normalize(entry.target) === target);
    assert.notStrictEqual(path.normalize(call.source), target, "atomic write source and target must differ");
  }
}

async function createArtifact(root, name, content) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

async function assertNoTemporaryStatusFiles(root) {
  const files = await walk(root);
  const leftovers = files.filter((file) => /run-status.*\.(tmp|partial)$/i.test(file) || /\.tmp-[^\\/]+$/i.test(file));
  assert.deepStrictEqual(leftovers, [], `temporary status files were left behind: ${leftovers.join(", ")}`);
}

async function walk(root) {
  const output = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await walk(fullPath));
    } else {
      output.push(fullPath);
    }
  }
  return output;
}

function statusPaths(workspaceRoot, multiRepoRoot) {
  const parent = path.join(multiRepoRoot, "copilot-workspace", "agentic-ui-bff-be");
  return {
    runJson: path.join(workspaceRoot, "run-status.json"),
    runMarkdown: path.join(workspaceRoot, "run-status.md"),
    latestJson: path.join(parent, "latest-run-status.json"),
    latestMarkdown: path.join(parent, "latest-run-status.md")
  };
}

function phase(status, id) {
  const value = status.phases.find((candidate) => candidate.id === id);
  assert.ok(value, `missing phase in run status: ${id}`);
  return value;
}

function assertArtifactRecorded(phaseStatus, artifactPath) {
  assert.ok(Array.isArray(phaseStatus.artifacts), "completed phase must have an artifacts array");
  assert.ok(
    phaseStatus.artifacts.some((artifact) => path.normalize(String(artifact)) === path.normalize(artifactPath)
      || path.basename(String(artifact)) === path.basename(artifactPath)),
    `phase did not retain artifact reference: ${artifactPath}`
  );
}

function resultValue(status, key) {
  return status[key] ?? (status.result && status.result[key]);
}

function errorText(value) {
  const error = value.error ?? value.failure;
  return typeof error === "string" ? error : JSON.stringify(error ?? "");
}

function manifest() {
  return {
    projectName: "boundary-project",
    branch: "test",
    updatedAt: "2026-07-11T22:00:00.000Z",
    repos: {
      ui: { type: "react", url: "https://example.invalid/ui.git", localPath: "C:\\fixtures\\ui", status: "ready" },
      bff: { type: "spring-bff", url: "https://example.invalid/bff.git", localPath: "C:\\fixtures\\bff", status: "ready" },
      be: { type: "spring-be", url: "https://example.invalid/be.git", localPath: "C:\\fixtures\\be", status: "ready" }
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
