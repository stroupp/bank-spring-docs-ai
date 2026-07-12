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
const { maskSecretsWithStats } = require("../dist/ai/safeContextFilter");
const { MultiRepoCopilotAgenticDocumentationGenerator } = require("../dist/docs/multiRepoCopilotAgenticDocumentationGenerator");
const { MultiRepoAgenticRunStatusWriter } = require("../dist/docs/multiRepoAgenticRunStatus");

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

async function main() {
  testSecretMaskingDirectly();
  await testContextBudgetEvidenceSemanticsAndSuccessAudit();
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
        model: { id: "mock", name: "Mock Copilot", vendor: "test", family: "mock", version: "1", maxInputTokens: 32000 }
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
  assert.strictEqual(audits[0].selectedModelId, "mock");
  assert.ok(audits[0].includedIndexes.includes("page-evidence-pack.md"));
}

async function testFailureAndCancellationAudits() {
  const failed = await createPage("copilot-failed");
  const throwingMock = { async send() { throw new Error("deterministic mock failure"); } };
  await assert.rejects(
    new CopilotPageDraftGenerator(throwingMock, 2000).generate(failed.multiRoot, failed.pageRoot, token),
    /deterministic mock failure/
  );
  const failedAudits = await readAudit(failed.multiRoot);
  assert.strictEqual(failedAudits[0].status, "failed");
  assert.match(failedAudits[0].error, /deterministic mock failure/);

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
