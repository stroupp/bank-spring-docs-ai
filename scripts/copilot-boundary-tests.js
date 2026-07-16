const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");

let languageModelSelections = 0;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue })
      },
      lm: {
        selectChatModels: async () => {
          languageModelSelections += 1;
          throw new Error("Copilot boundary test attempted vscode.lm access");
        }
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

const { CopilotPageDraftGenerator } = require("../dist/pageanalysis/copilotPageDraftGenerator");
const { FinalPageDocumentBuilder } = require("../dist/pageanalysis/finalPageDocumentBuilder");
const { PageDocumentQualityScorer } = require("../dist/pageanalysis/quality/pageDocumentQualityScorer");
const { maskSecretsWithStats } = require("../dist/ai/safeContextFilter");
const { MultiRepoCopilotAgenticDocumentationGenerator } = require("../dist/docs/multiRepoCopilotAgenticDocumentationGenerator");
const { MultiRepoAgenticRunStatusWriter } = require("../dist/docs/multiRepoAgenticRunStatus");

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

async function main() {
  testSecretMaskingDirectly();
  await testContextBudgetEvidenceSemanticsAndSuccessAudit();
  await testLargeContextBudgetPreservesLateCrossLayerEvidence();
  await testMarkdownBalancingIgnoresHeadingsInsideSourceFences();
  await testSemanticArtifactInclusionCanBeDisabled();
  await testFailureAndCancellationAudits();
  await testAgenticEmptyResponsePersistsFailureStatusAndAudit();
  await testAgenticResumeReusesCompletedPrefix();
  assert.strictEqual(languageModelSelections, 0, "automated Copilot tests must not access vscode.lm");
  console.log("Copilot boundary tests passed (mock only; vscode.lm calls: 0).");
}

async function testAgenticResumeReusesCompletedPrefix() {
  const multiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-agentic-resume-"));
  const manifest = agenticManifest(multiRoot, "agentic-resume-project");
  await Promise.all(Object.values(manifest.repos).map((repo) => fs.mkdir(repo.localPath, { recursive: true })));
  const writer = await MultiRepoAgenticRunStatusWriter.create(multiRoot, manifest, "20260711T231000Z");
  const localArtifact = path.join(multiRoot, "resume-local-artifact.json");
  await fs.writeFile(localArtifact, "{}\n", "utf8");
  for (const phaseId of ["local-ui-analysis", "local-bff-analysis", "local-be-analysis", "local-traceability"]) {
    await writer.startPhase(phaseId);
    await writer.completePhase(phaseId, { artifacts: [localArtifact] });
  }
  await writer.skipPhase("qwen-semantics", "Qwen is disabled in this resume fixture.");
  for (const phaseId of ["knowledge-graph", "quality-report", "manifest-update"]) {
    await writer.startPhase(phaseId);
    await writer.completePhase(phaseId, { artifacts: [localArtifact] });
  }

  const completedSteps = [
    ["cross-layer-plan", "copilot-cross-layer-plan"],
    ["ui-analysis", "copilot-ui-analysis"],
    ["bff-analysis", "copilot-bff-analysis"],
    ["be-analysis", "copilot-be-analysis"],
    ["traceability-analysis", "copilot-traceability-analysis"]
  ];
  for (const [step, phaseId] of completedSteps) {
    const output = path.join(writer.workspaceRoot, `${step}.md`);
    await fs.writeFile(output, `# reused-${step}\n`, "utf8");
    await writer.startPhase(phaseId);
    await writer.completePhase(phaseId, {
      artifacts: [output],
      details: { requestStarted: true, responseReceived: true, estimatedTotalTokens: 100, outputCharacters: 20 }
    });
  }

  const failedPrompt = path.join(writer.workspaceRoot, "cross-layer-diagrams-prompt.md");
  const failedContext = path.join(writer.workspaceRoot, "cross-layer-diagrams-context.md");
  await fs.writeFile(failedPrompt, "original failed prompt\n", "utf8");
  await fs.writeFile(failedContext, "original failed context\n", "utf8");
  await writer.startPhase("copilot-cross-layer-diagrams");
  await writer.updatePhase("copilot-cross-layer-diagrams", {
    artifacts: [failedPrompt, failedContext],
    details: { requestStarted: true, responseReceived: true, estimatedTotalTokens: 50, outputCharacters: 0, selectedModelVendor: "copilotcli" }
  });
  await writer.finishFailure(new Error("Copilot returned an empty diagrams response."), false);

  const resumed = await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRoot, manifest);
  assert.ok(resumed, "failed run must be resumable");
  await resumed.prepareResume();
  assert.strictEqual(resumed.currentAttempt("copilot-cross-layer-diagrams"), 2);
  assert.strictEqual(resumed.isPhaseReusable("copilot-traceability-analysis"), true);

  const requests = [];
  const resumeMock = {
    async send(prompt) {
      requests.push(prompt);
      const text = requests.length === 1 ? "# resumed-diagrams\n" : "# resumed-final-synthesis\n";
      return {
        text,
        usage: {
          inputCharacters: prompt.combinedText.length,
          outputCharacters: text.length,
          estimatedInputTokens: 10,
          estimatedOutputTokens: 10,
          estimatedTotalTokens: 20,
          modelCountedInputTokens: 10
        },
        model: { id: "mock-standard", name: "Mock Standard Copilot", vendor: "copilot", family: "mock", version: "1", maxInputTokens: 32000 }
      };
    }
  };

  const result = await new MultiRepoCopilotAgenticDocumentationGenerator(undefined, resumeMock)
    .generate(multiRoot, manifest, token, undefined, resumed);
  assert.strictEqual(requests.length, 2, "resume must request only diagrams and final synthesis");
  assert.match(requests[0].combinedText, /reused-cross-layer-plan/);
  assert.match(requests[0].combinedText, /reused-traceability-analysis/);
  assert.match(requests[1].combinedText, /resumed-diagrams/);
  assert.strictEqual(result.requestCount, 8);
  assert.strictEqual(result.newRequestCount, 2);
  assert.strictEqual(result.reusedStepCount, 5);
  assert.strictEqual(result.estimatedTotalTokens, 590);
  assert.ok(await exists(result.finalDocumentPath));
  assert.strictEqual(await fs.readFile(failedPrompt, "utf8"), "original failed prompt\n");
  assert.strictEqual(await fs.readFile(failedContext, "utf8"), "original failed context\n");
  assert.ok(await exists(path.join(writer.workspaceRoot, "cross-layer-diagrams-attempt-2-prompt.md")));
  assert.ok(await exists(path.join(writer.workspaceRoot, "cross-layer-diagrams-attempt-2-context.md")));
  assert.ok(await exists(path.join(writer.workspaceRoot, "cross-layer-diagrams-attempt-2.md")));
  const finalStatus = JSON.parse(await fs.readFile(writer.runStatusJsonPath, "utf8"));
  assert.strictEqual(finalStatus.status, "completed");
  assert.strictEqual(finalStatus.resumeCount, 1);
  assert.strictEqual(finalStatus.phases.find((item) => item.id === "copilot-cross-layer-diagrams").attempt, 2);
  const audits = await readAudit(multiRoot);
  assert.strictEqual(audits.length, 2, "reused Copilot steps must not create duplicate audit entries");
  assert.ok(audits.every((entry) => entry.selectedModelVendor === "copilot"));
}

async function testAgenticEmptyResponsePersistsFailureStatusAndAudit() {
  const multiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-agentic-empty-"));
  const manifest = agenticManifest(multiRoot, "agentic-boundary-project");
  await Promise.all(Object.values(manifest.repos).map((repo) => fs.mkdir(repo.localPath, { recursive: true })));
  const runStatus = await MultiRepoAgenticRunStatusWriter.create(multiRoot, manifest, "20260711T230000Z");
  const emptyMock = {
    async send(prompt) {
      const inputCharacters = prompt.combinedText.length;
      return {
        text: "",
        usage: {
          inputCharacters,
          outputCharacters: 0,
          estimatedInputTokens: Math.ceil(inputCharacters / 4),
          estimatedOutputTokens: 0,
          estimatedTotalTokens: Math.ceil(inputCharacters / 4),
          modelCountedInputTokens: 123
        },
        model: { id: "mock-empty", name: "Mock Empty Copilot", vendor: "test", family: "mock", version: "1", maxInputTokens: 32000 }
      };
    }
  };

  await assert.rejects(
    new MultiRepoCopilotAgenticDocumentationGenerator(undefined, emptyMock).generate(multiRoot, manifest, token, undefined, runStatus),
    /empty response.*cross-layer-plan/i
  );

  const status = JSON.parse(await fs.readFile(runStatus.runStatusJsonPath, "utf8"));
  const phase = status.phases.find((item) => item.id === "copilot-cross-layer-plan");
  assert.strictEqual(status.status, "failed");
  assert.strictEqual(phase.status, "failed");
  assert.strictEqual(phase.details.requestStarted, true);
  assert.strictEqual(phase.details.responseReceived, true);
  assert.strictEqual(phase.details.outputCharacters, 0);
  assert.strictEqual(phase.details.selectedModelId, "mock-empty");
  assert.ok(phase.artifacts.some((item) => item.endsWith("cross-layer-plan-prompt.md")));
  assert.ok(phase.artifacts.some((item) => item.endsWith("cross-layer-plan-context.md")));
  const agenticAudits = await readAudit(multiRoot);
  assert.strictEqual(agenticAudits.length, 1);
  assert.strictEqual(agenticAudits[0].status, "failed");
  assert.strictEqual(agenticAudits[0].copilotResponseReceived, true);
  assert.strictEqual(agenticAudits[0].selectedModelId, "mock-empty");
}

function agenticManifest(multiRoot, projectName) {
  return {
    projectName,
    branch: "test",
    updatedAt: new Date().toISOString(),
    repos: {
      ui: { type: "react", url: "https://example.invalid/ui.git", localPath: path.join(multiRoot, "repos", "ui"), status: "analyzed" },
      bff: { type: "spring-bff", url: "https://example.invalid/bff.git", localPath: path.join(multiRoot, "repos", "bff"), status: "analyzed" },
      be: { type: "spring-be", url: "https://example.invalid/be.git", localPath: path.join(multiRoot, "repos", "be"), status: "analyzed" }
    }
  };
}

function testSecretMaskingDirectly() {
  const masked = maskSecretsWithStats("password=bank123\nAuthorization: Bearer abc.def\napi_key=secret-key");
  assert.strictEqual(masked.maskedSecrets, 3);
  assert.doesNotMatch(masked.text, /bank123|abc\.def|secret-key/);
  assert.match(masked.text, /\[MASKED_SECRET\]/);
}

async function testContextBudgetEvidenceSemanticsAndSuccessAudit() {
  const { multiRoot, pageRoot } = await createPage("copilot-success");
  const requests = [];
  const mock = {
    provider: "qwen",
    async send(prompt) {
      requests.push(prompt);
      return {
        text: "# Sayfa Amacı\nMüşteri arama akışı.\n\n# Kaynak Referansları\n- src/pages/CustomerSearch.tsx",
        usage: {
          inputCharacters: prompt.combinedText.length,
          outputCharacters: 94,
          estimatedInputTokens: Math.ceil(prompt.combinedText.length / 4),
          estimatedOutputTokens: 24,
          estimatedTotalTokens: Math.ceil(prompt.combinedText.length / 4) + 24
        },
        model: { id: "mock-qwen", name: "Mock Qwen", vendor: "qwen", family: "qwen", version: "1", maxInputTokens: 131072 },
        provider: "qwen",
        finishReason: "stop"
      };
    }
  };
  const budget = 1800;
  const result = await new CopilotPageDraftGenerator(mock, budget).generate(multiRoot, pageRoot, token);
  const context = await fs.readFile(result.contextPath, "utf8");
  assert.ok(context.length <= budget, `context length ${context.length} exceeded budget ${budget}`);
  assert.match(context, /CustomerSearch/);
  assert.match(context, /React Page Evidence/);
  assert.match(context, /Qwen Page Semantics/);
  assert.match(context, /POST \/api\/customers\/search/);
  assert.doesNotMatch(context, /boundary-secret-value/);
  assert.match(context, /\[MASKED_SECRET\]/);
  assert.strictEqual(requests.length, 1);
  assert.ok(await exists(result.draftPath));

  const audits = await readAudit(multiRoot);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0].status, "success");
  assert.strictEqual(audits[0].maskedSecrets, 1);
  assert.strictEqual(audits[0].selectedModelId, "mock-qwen");
  assert.strictEqual(audits[0].provider, "qwen");
  assert.strictEqual(audits[0].modelFamily, "qwen");
  assert.strictEqual(audits[0].finishReason, "stop");
  assert.ok(audits[0].includedIndexes.includes("page-evidence-pack.md"));
}

async function testLargeContextBudgetPreservesLateCrossLayerEvidence() {
  const { multiRoot, pageRoot } = await createPage("copilot-cross-layer-budget");
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), [
    "# Page Context Pack",
    "## Component Kayitlari",
    "UI_COMPONENT_FILLER_START",
    "U".repeat(12000),
    "## UI -> BFF Eslesmeleri",
    "UI_TO_BFF_LATE_SENTINEL",
    "## BFF -> BE Eslesmeleri",
    "BFF_TO_BE_LATE_SENTINEL"
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), [
    "# Page Evidence Pack",
    "## React Page Evidence",
    "REACT_FILLER_START",
    "R".repeat(10000),
    "## BFF Endpoint Evidence",
    "BFF_ENDPOINT_LATE_SENTINEL",
    "## BFF Outbound Client Evidence",
    "FEIGN_CLIENT_LATE_SENTINEL",
    "## Backend Endpoint Evidence",
    "BE_ENDPOINT_LATE_SENTINEL"
  ].join("\n"), "utf8");
  await fs.rm(path.join(pageRoot, "qwen-page-semantics.json"), { force: true });

  const requests = [];
  const mock = successfulPageDraftClient(requests);
  const budget = 6000;
  const result = await new CopilotPageDraftGenerator(mock, budget).generate(multiRoot, pageRoot, token);
  const context = await fs.readFile(result.contextPath, "utf8");

  assert.ok(context.length <= budget, `cross-layer context length ${context.length} exceeded budget ${budget}`);
  for (const sentinel of [
    "UI_TO_BFF_LATE_SENTINEL",
    "BFF_TO_BE_LATE_SENTINEL",
    "BFF_ENDPOINT_LATE_SENTINEL",
    "FEIGN_CLIENT_LATE_SENTINEL",
    "BE_ENDPOINT_LATE_SENTINEL"
  ]) {
    assert.match(context, new RegExp(sentinel), `${sentinel} must survive unrelated leading UI content`);
    assert.match(requests[0].userPrompt, new RegExp(sentinel), `${sentinel} must be present in the request sent to Copilot`);
  }

  const audits = await readAudit(multiRoot);
  assert.ok(audits[0].includedIndexes.includes("page-context-pack.md"));
  assert.ok(audits[0].includedIndexes.includes("page-evidence-pack.md"));
  assert.strictEqual(audits[0].contextSelectionPath, path.relative(multiRoot, result.contextSelectionPath));
  const selection = JSON.parse(await fs.readFile(result.contextSelectionPath, "utf8"));
  assert.strictEqual(selection.maxCharacters, budget);
  assert.match(selection.draftHash, /^[a-f0-9]{64}$/);
  for (const fileName of ["page-context-pack.md", "page-evidence-pack.md"]) {
    const part = selection.parts.find((item) => item.fileName === fileName);
    assert.ok(part?.sentCharacters > 0, `${fileName} must receive a non-zero balanced context allocation`);
    assert.ok(part.sentCharacters <= part.safeCharacters, `${fileName} sentCharacters must describe the final masked selection`);
    assert.strictEqual(part.truncated, true, `${fileName} truncation must be auditable`);
  }
  assert.strictEqual(selection.parts.find((item) => item.fileName === "qwen-page-semantics.json").status, "missing");
}

async function testMarkdownBalancingIgnoresHeadingsInsideSourceFences() {
  const { multiRoot, pageRoot } = await createPage("copilot-fenced-headings");
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), [
    "# Page Context Pack",
    "## Secili Sayfa Ozeti",
    "api_key=x",
    "C".repeat(9000),
    "## BFF -> BE Eslesmeleri",
    "REAL_CONTEXT_BE_SENTINEL"
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), [
    "# Page Evidence Pack",
    "## React Page Evidence",
    "```markdown",
    "## Metadata",
    "FENCED_METADATA_SENTINEL",
    "## BFF Outbound Client Evidence",
    "F".repeat(9000),
    "```",
    "## Backend Endpoint Evidence",
    "REAL_BACKEND_SENTINEL"
  ].join("\n"), "utf8");
  await fs.rm(path.join(pageRoot, "qwen-page-semantics.json"), { force: true });

  const budget = 4000;
  const result = await new CopilotPageDraftGenerator(
    successfulPageDraftClient([]),
    budget
  ).generate(multiRoot, pageRoot, token);
  const context = await fs.readFile(result.contextPath, "utf8");
  assert.ok(context.length <= budget, "secret masking must not expand the packed context beyond its exact ceiling");
  assert.match(context, /api_key=\[MASKED_SECRET\]/);
  assert.match(context, /FENCED_METADATA_SENTINEL/, "a source line named Metadata inside a fence must not drop its enclosing evidence section");
  assert.match(context, /REAL_CONTEXT_BE_SENTINEL/);
  assert.match(context, /REAL_BACKEND_SENTINEL/);
}

async function testSemanticArtifactInclusionCanBeDisabled() {
  const defaultFixture = await createPage("copilot-semantics-default");
  await writeSemanticSentinels(defaultFixture.pageRoot);
  const defaultRequests = [];
  const defaultResult = await new CopilotPageDraftGenerator(
    successfulPageDraftClient(defaultRequests),
    8000
  ).generate(defaultFixture.multiRoot, defaultFixture.pageRoot, token);
  const defaultContext = await fs.readFile(defaultResult.contextPath, "utf8");
  assert.match(defaultContext, /QWEN_PAGE_SEMANTIC_SENTINEL/, "the default constructor must retain page semantics");
  assert.match(defaultContext, /QWEN_INTERACTION_SEMANTIC_SENTINEL/, "the default constructor must retain interaction semantics");
  const defaultAudit = (await readAudit(defaultFixture.multiRoot))[0];
  assert.ok(defaultAudit.includedIndexes.includes("qwen-page-semantics.json"));
  assert.ok(defaultAudit.includedIndexes.includes("qwen-interaction-semantics.jsonl"));

  const disabledFixture = await createPage("copilot-semantics-disabled");
  await writeSemanticSentinels(disabledFixture.pageRoot);
  const disabledRequests = [];
  const disabledResult = await new CopilotPageDraftGenerator(
    successfulPageDraftClient(disabledRequests),
    8000,
    false
  ).generate(disabledFixture.multiRoot, disabledFixture.pageRoot, token);
  const disabledContext = await fs.readFile(disabledResult.contextPath, "utf8");
  assert.doesNotMatch(disabledContext, /QWEN_PAGE_SEMANTIC_SENTINEL|QWEN_INTERACTION_SEMANTIC_SENTINEL/);
  assert.doesNotMatch(disabledContext, /## Qwen Page Semantics|## Qwen Interaction Semantics/);
  assert.match(disabledContext, /CustomerSearch/, "disabling semantics must not remove the deterministic page context");
  assert.match(disabledContext, /React Page Evidence/, "disabling semantics must not remove source evidence");
  assert.doesNotMatch(disabledRequests[0].userPrompt, /QWEN_PAGE_SEMANTIC_SENTINEL|QWEN_INTERACTION_SEMANTIC_SENTINEL/);

  const disabledAudit = (await readAudit(disabledFixture.multiRoot))[0];
  assert.ok(disabledAudit.includedIndexes.includes("page-context-pack.md"));
  assert.ok(disabledAudit.includedIndexes.includes("page-evidence-pack.md"));
  assert.ok(!disabledAudit.includedIndexes.includes("qwen-page-semantics.json"));
  assert.ok(!disabledAudit.includedIndexes.includes("qwen-interaction-semantics.jsonl"));
  const disabledSelection = JSON.parse(await fs.readFile(disabledResult.contextSelectionPath, "utf8"));
  assert.strictEqual(disabledSelection.qwenSemanticArtifactsEnabled, false);
  assert.ok(disabledSelection.parts
    .filter((item) => item.fileName.startsWith("qwen-"))
    .every((item) => item.status === "disabled"));
  await fs.appendFile(path.join(disabledFixture.pageRoot, "qwen-page-semantics.json"), "\n", "utf8");
  const disabledScore = await new PageDocumentQualityScorer().score(
    disabledFixture.multiRoot,
    disabledFixture.pageRoot
  );
  assert.strictEqual(disabledScore.qwenSemanticCoverage, 0, "disabled semantics must not earn existence-only quality credit");
  assert.ok(disabledScore.metricExplanations.some((item) =>
    item.metric === "qwen-semantic-coverage" && /intentionally disabled/i.test(item.reason)
  ));
  await fs.writeFile(path.join(disabledFixture.pageRoot, "detected-gaps.json"), "[]", "utf8");
  const finalResult = await new FinalPageDocumentBuilder().build(disabledFixture.pageRoot);
  const finalDocument = await fs.readFile(finalResult.finalDocumentPath, "utf8");
  assert.match(finalDocument, /Qwen semantik kullanimi: devre disi/);
  assert.ok(await exists(path.join(disabledFixture.pageRoot, "qwen-page-semantics.json")), "the option must not delete semantic artifacts");
  assert.ok(await exists(path.join(disabledFixture.pageRoot, "qwen-interaction-semantics.jsonl")), "the option must not delete semantic artifacts");
}

function successfulPageDraftClient(requests) {
  return {
    provider: "copilot",
    async send(prompt) {
      requests.push(prompt);
      return {
        text: "# Sayfa Amaci\nDeterministic Copilot boundary response.",
        usage: {
          inputCharacters: prompt.combinedText.length,
          outputCharacters: 52,
          estimatedInputTokens: Math.ceil(prompt.combinedText.length / 4),
          estimatedOutputTokens: 13,
          estimatedTotalTokens: Math.ceil(prompt.combinedText.length / 4) + 13
        },
        model: { id: "mock-copilot", name: "Mock Copilot", vendor: "copilot", family: "mock", version: "1", maxInputTokens: 32000 },
        provider: "copilot",
        finishReason: "stop"
      };
    }
  };
}

async function writeSemanticSentinels(pageRoot) {
  await fs.writeFile(
    path.join(pageRoot, "qwen-page-semantics.json"),
    JSON.stringify({ businessPurpose: "QWEN_PAGE_SEMANTIC_SENTINEL", confidence: "high" }),
    "utf8"
  );
  await fs.writeFile(
    path.join(pageRoot, "qwen-interaction-semantics.jsonl"),
    `${JSON.stringify({ interaction: "QWEN_INTERACTION_SEMANTIC_SENTINEL", confidence: "high" })}\n`,
    "utf8"
  );
}

async function testFailureAndCancellationAudits() {
  const failed = await createPage("copilot-failed");
  const throwingMock = { async send() { throw new Error("api_key=boundary-audit-secret deterministic mock failure"); } };
  await assert.rejects(
    new CopilotPageDraftGenerator(throwingMock, 2000).generate(failed.multiRoot, failed.pageRoot, token),
    /deterministic mock failure/
  );
  const failedAudits = await readAudit(failed.multiRoot);
  assert.strictEqual(failedAudits[0].status, "failed");
  assert.strictEqual(failedAudits[0].contextSelectionPath, undefined);
  assert.ok(!await exists(path.join(failed.pageRoot, "copilot-draft-context-selection.json")));
  assert.match(failedAudits[0].error, /deterministic mock failure/);
  assert.doesNotMatch(failedAudits[0].error, /boundary-audit-secret/);
  assert.match(failedAudits[0].error, /\[MASKED_SECRET\]/);

  const retained = await createPage("copilot-failed-after-success");
  await new CopilotPageDraftGenerator(successfulPageDraftClient([]), 2000)
    .generate(retained.multiRoot, retained.pageRoot, token);
  const retainedSelectionPath = path.join(retained.pageRoot, "copilot-draft-context-selection.json");
  const selectionBeforeFailure = await fs.readFile(retainedSelectionPath, "utf8");
  await assert.rejects(
    new CopilotPageDraftGenerator(throwingMock, 2000, false).generate(retained.multiRoot, retained.pageRoot, token),
    /deterministic mock failure/
  );
  assert.strictEqual(
    await fs.readFile(retainedSelectionPath, "utf8"),
    selectionBeforeFailure,
    "a failed attempt must not pair its context-selection metadata with the retained older draft"
  );
  assert.strictEqual((await readAudit(retained.multiRoot)).at(-1).contextSelectionPath, undefined);

  const mismatchedSelection = JSON.parse(selectionBeforeFailure);
  mismatchedSelection.draftHash = "0".repeat(64);
  await fs.writeFile(retainedSelectionPath, `${JSON.stringify(mismatchedSelection)}\n`, "utf8");
  const unknownUsageScore = await new PageDocumentQualityScorer().score(retained.multiRoot, retained.pageRoot);
  assert.strictEqual(unknownUsageScore.qwenSemanticCoverage, null, "unbound selection metadata must not earn existence-only Qwen credit");
  assert.ok(unknownUsageScore.metricExplanations.some((item) =>
    item.metric === "qwen-semantic-coverage" && /usage is unknown/i.test(item.reason)
  ));
  await fs.writeFile(path.join(retained.pageRoot, "detected-gaps.json"), "[]", "utf8");
  const unknownUsageFinal = await new FinalPageDocumentBuilder().build(retained.pageRoot);
  assert.match(await fs.readFile(unknownUsageFinal.finalDocumentPath, "utf8"), /Qwen semantik kullanimi: bilinmiyor/);

  const cancelled = await createPage("copilot-cancelled");
  const cancelledToken = { ...token, isCancellationRequested: true };
  await assert.rejects(
    new CopilotPageDraftGenerator(throwingMock, 2000).generate(cancelled.multiRoot, cancelled.pageRoot, cancelledToken),
    /deterministic mock failure/
  );
  const cancelledAudits = await readAudit(cancelled.multiRoot);
  assert.strictEqual(cancelledAudits[0].status, "cancelled");
}

async function createPage(prefix) {
  const multiRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const pageRoot = path.join(multiRoot, "pages", "CustomerSearch");
  await fs.mkdir(pageRoot, { recursive: true });
  await fs.writeFile(path.join(pageRoot, "page-flow.json"), JSON.stringify({
    projectName: "boundary-project",
    branch: "test",
    selectedPage: { pageName: "CustomerSearch", route: "/customers/search" }
  }), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), [
    "# Selected Page: CustomerSearch",
    "Route: /customers/search",
    "POST /api/customers/search",
    "password=boundary-secret-value",
    "UI -> BFF -> BE traceability confirmed"
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), "# React Page Evidence\nsrc/pages/CustomerSearch.tsx\n# BFF Endpoint Evidence\nPOST /api/customers/search\n# Backend Endpoint Evidence\nPOST /customers/search", "utf8");
  await fs.writeFile(path.join(pageRoot, "qwen-page-semantics.json"), JSON.stringify({ businessPurpose: "Qwen Page Semantics", confidence: "high" }), "utf8");
  return { multiRoot, pageRoot };
}

async function readAudit(multiRoot) {
  const text = await fs.readFile(path.join(multiRoot, "audit", "copilot-requests.jsonl"), "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
