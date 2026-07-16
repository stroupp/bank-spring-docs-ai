const assert = require("assert");
const Module = require("module");

const qwenClient = { provider: "qwen", id: "explicit-qwen3-client" };
const copilotClient = { provider: "copilot", id: "configured-copilot-client" };
const configuredQwenClient = { provider: "qwen", id: "configured-qwen-client" };
const selectedPage = {
  pageName: "ComplexPage",
  route: "/complex",
  file: "src/pages/ComplexPage.tsx",
  apiCallCount: 2,
  bffMatchStatus: "matched",
  beMatchStatus: "matched",
  confidence: "high"
};
const manifest = {
  projectName: "Command Test",
  branch: "main",
  repos: {
    ui: { type: "react", url: "https://example.invalid/ui.git", localPath: "/mock/ui", status: "analyzed" },
    bff: { type: "spring-bff", url: "https://example.invalid/bff.git", localPath: "/mock/bff", status: "analyzed" },
    be: { type: "spring-be", url: "https://example.invalid/be.git", localPath: "/mock/be", status: "analyzed" }
  },
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const settings = {
  "ai.provider": "copilot",
  "pageAnalysis.qwenOnly": false,
  "qwen.enabled": true,
  "qwen.bankingEnvironment": false,
  "qwen.contextWindowTokens": 131072,
  "qwen.generationMaxTokens": 16384
};
let currentRun;
let networkCalls = 0;
let languageModelSelections = 0;
const errors = [];
const warnings = [];
let progressBarrier;

function record(event) {
  assert.ok(currentRun, `unexpected pipeline event outside a run: ${event}`);
  currentRun.events.push(event);
}

const dependencyMocks = {
  "../ai/documentationModelClientFactory": {
    createDocumentationModelClient() {
      currentRun.configuredFactoryCalls += 1;
      return settings["ai.provider"] === "qwen" ? configuredQwenClient : copilotClient;
    },
    createQwenDocumentationModelClient() {
      currentRun.explicitQwenFactoryCalls += 1;
      return qwenClient;
    },
    getResumableQwenPageModelIdentity() {
      currentRun.qwenIdentityCalls += 1;
      return settings["qwen.bankingEnvironment"]
        ? { provider: "qwen", model: "ONIKS", family: "qwen3", configurationFingerprint: "banking-test-fingerprint" }
        : { provider: "qwen", model: "qwen3", configurationFingerprint: "qwen3-test-fingerprint" };
    }
  },
  "../evidence/evidencePackBuilder": {
    EvidencePackBuilder: class {
      async build() { record("evidence"); return { evidencePackPath: "/mock/page/page-evidence-pack.md", includedFiles: [] }; }
    }
  },
  "../multirepo/multiRepoManifestService": {
    MultiRepoManifestService: class {
      async readManifest() { return manifest; }
      getMultiRepoRoot() { return "/mock/multi-repo"; }
    }
  },
  "../pageanalysis/copilotPageDraftGenerator": {
    CopilotPageDraftGenerator: class {
      constructor(client) {
        currentRun.copilotDraftClients.push(client);
      }
      async generate() {
        record("copilot-draft");
        return { draftPath: "/mock/page/copilot-draft.md", estimatedTotalTokens: 10 };
      }
    }
  },
  "../pageanalysis/pageContextPackBuilder": {
    PageContextPackBuilder: class {
      async build() {
        record("context");
        return { pageRoot: "/mock/page", contextPackPath: "/mock/page/page-context-pack.md" };
      }
    }
  },
  "../pageanalysis/gapDetection/pageDocGapDetector": {
    PageDocGapDetector: class {
      async detect() { record("gap"); return [{ id: "gap-1", section: "Backend" }]; }
    }
  },
  "../pageanalysis/finalPageDocumentBuilder": {
    FinalPageDocumentBuilder: class {
      async build() { record("final"); return { finalDocumentPath: "/mock/page/final-page-technical-analysis.md" }; }
    }
  },
  "../pageanalysis/pageListService": {
    PageListService: class {
      async list() { throw new Error("page picker must not run when a selected page exists"); }
    }
  },
  "../pageanalysis/pageOutputFreshnessService": {
    PageOutputFreshnessService: class {}
  },
  "../pageanalysis/pagePipelineFreshnessService": {
    PagePipelineFreshnessService: class {
      async ensure() { record("freshness"); return { issues: [], reportPath: "/mock/freshness.md" }; }
    }
  },
  "../pageanalysis/qwenPageSemanticAnalyzer": {
    QwenPageSemanticAnalyzer: class {
      constructor(...args) { currentRun.semanticConstructorArgs.push(args); }
      async analyze() {
        record("qwen-semantics");
        if (currentRun.semanticError) { throw currentRun.semanticError; }
        return { analyzedInteractions: 0, cacheHits: 0, failures: 0 };
      }
    }
  },
  "../pageanalysis/qwenIterativePageDraftGenerator": {
    QwenIterativePageDraftGenerator: class {
      constructor(client, options) {
        currentRun.iterativeClients.push(client);
        currentRun.iterativeOptions.push(options);
      }
      async generate(input) {
        record("qwen-iterative-draft");
        assert.strictEqual(input.pageRoot, "/mock/page");
        assert.strictEqual(input.manifest, manifest);
        return {
          draftPath: "/mock/page/copilot-draft.md",
          chunkCount: 3,
          newModelCallCount: 4,
          reusedStepCount: 0
        };
      }
    }
  },
  "../pageanalysis/gapRepair/pageSectionRegenerator": {
    PageSectionRegenerator: class {
      constructor(client, options) {
        currentRun.repairClients.push(client);
        currentRun.repairOptions.push(options);
      }
      async repair() { record("repair"); return { repairedGapCount: 1 }; }
    }
  },
  "../pageanalysis/quality/pageDocumentQualityScorer": {
    PageDocumentQualityScorer: class {
      async score() { record("quality"); return { score: 98, grade: "A" }; }
    }
  },
  "../pageanalysis/quality/pageDocumentQualityReportWriter": {
    PageDocumentQualityReportWriter: class {
      async write() { record("quality-write"); return "/mock/page/quality.md"; }
      async writeAggregate() { record("quality-aggregate"); }
    }
  },
  "../pageanalysis/selectedPageStateService": {
    SelectedPageStateService: class {
      getSelectedPage() { return selectedPage; }
    }
  },
  "../pageanalysis/artifactFreshnessService": {
    ArtifactFreshnessService: class {}
  },
  "../utils/pathUtils": {
    safePathSegment(value) { return value; }
  }
};

const vscodeMock = {
  ProgressLocation: { Notification: 15 },
  workspace: {
    getConfiguration: () => ({
      get(key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue;
      }
    }),
    async openTextDocument(filePath) { return { filePath }; },
    fs: {
      async stat() { return {}; }
    }
  },
  window: {
    async withProgress(_options, task) {
      if (progressBarrier) {
        progressBarrier.entered();
        await progressBarrier.releasePromise;
      }
      return task({ report() {} }, {
        isCancellationRequested: false,
        onCancellationRequested() { return { dispose() {} }; }
      });
    },
    async showTextDocument() {},
    showInformationMessage() {},
    showWarningMessage(message) { warnings.push(message); },
    showErrorMessage(message) { errors.push(message); }
  },
  lm: {
    async selectChatModels() {
      languageModelSelections += 1;
      throw new Error("Qwen-only command tests attempted vscode.lm access");
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeMock;
  }
  if (Object.prototype.hasOwnProperty.call(dependencyMocks, request)) {
    return dependencyMocks[request];
  }
  return originalLoad.apply(this, arguments);
};

global.fetch = async () => {
  networkCalls += 1;
  throw new Error("Qwen-only command tests attempted a network call");
};

const { runFullSelectedPageAnalysisCommand } = require("../dist/commands/pageAnalysisCommands");

function newRun(name) {
  return {
    name,
    configuredFactoryCalls: 0,
    explicitQwenFactoryCalls: 0,
    qwenIdentityCalls: 0,
    copilotDraftClients: [],
    iterativeClients: [],
    iterativeOptions: [],
    semanticConstructorArgs: [],
    semanticError: undefined,
    repairClients: [],
    repairOptions: [],
    events: []
  };
}

async function execute(options, run) {
  currentRun = run;
  try {
    await runFullSelectedPageAnalysisCommand({}, options);
  } finally {
    currentRun = undefined;
  }
}

async function main() {
  const qwenRun = newRun("qwen-only");
  await execute({ qwenOnly: true }, qwenRun);
  assert.strictEqual(qwenRun.explicitQwenFactoryCalls, 1);
  assert.strictEqual(qwenRun.configuredFactoryCalls, 0, "Qwen-only mode must not use the configured/Copilot factory");
  assert.strictEqual(qwenRun.qwenIdentityCalls, 1);
  assert.strictEqual(qwenRun.semanticConstructorArgs.length, 1);
  assert.strictEqual(qwenRun.semanticConstructorArgs[0][3].client, qwenClient, "Qwen-only semantics must reuse the explicit client snapshot");
  assert.strictEqual(qwenRun.semanticConstructorArgs[0][3].expectedModelMarker, "qwen3");
  assert.match(qwenRun.semanticConstructorArgs[0][3].cacheIdentity, /qwen3/i);
  assert.deepStrictEqual(qwenRun.iterativeClients, [qwenClient]);
  assert.deepStrictEqual(qwenRun.copilotDraftClients, [], "Qwen-only mode must not construct the existing Copilot draft generator");
  assert.deepStrictEqual(qwenRun.repairClients, [qwenClient], "Qwen-only gap repair must receive the explicit Qwen client");
  assert.strictEqual(qwenRun.repairOptions[0].mode, "qwen3", "Qwen-only gap repair must enable its hardened Qwen3 mode");
  assert.strictEqual(qwenRun.repairOptions[0].maxInputCharacters, qwenRun.iterativeOptions[0].maxInputCharacters, "repair must reuse the provider-derived Qwen input budget");
  assert.strictEqual(qwenRun.repairOptions[0].expectedModelMarker, "qwen3");
  assert.deepStrictEqual(qwenRun.events, [
    "freshness", "context", "evidence", "qwen-semantics", "qwen-iterative-draft",
    "gap", "repair", "final", "quality", "quality-write", "quality-aggregate"
  ]);

  settings["qwen.bankingEnvironment"] = true;
  const bankingQwenRun = newRun("banking-qwen-only");
  await execute({ qwenOnly: true }, bankingQwenRun);
  assert.strictEqual(bankingQwenRun.explicitQwenFactoryCalls, 1);
  assert.strictEqual(bankingQwenRun.iterativeOptions.length, 1);
  assert.match(bankingQwenRun.iterativeOptions[0].modelIdentity, /ONIKS/i);
  assert.match(
    bankingQwenRun.iterativeOptions[0].modelIdentity,
    /(?:^|[^a-z0-9])qwen3(?:$|[^a-z0-9])/i,
    "an exact-validated banking alias must carry a trusted Qwen3 marker into the iterative constructor identity"
  );
  assert.strictEqual(bankingQwenRun.iterativeOptions[0].expectedModelMarker, "qwen3");
  assert.match(bankingQwenRun.semanticConstructorArgs[0][3].cacheIdentity, /qwen3/i);
  assert.strictEqual(bankingQwenRun.semanticConstructorArgs[0][3].client, qwenClient);
  assert.deepStrictEqual(bankingQwenRun.repairClients, [qwenClient]);
  settings["qwen.bankingEnvironment"] = false;

  const qwenBoundaryRun = newRun("qwen3-semantic-boundary");
  qwenBoundaryRun.semanticError = Object.assign(new Error("unexpected model notqwen3fake"), {
    name: "Qwen3PageSemanticBoundaryError"
  });
  await execute({ qwenOnly: true }, qwenBoundaryRun);
  assert.deepStrictEqual(
    qwenBoundaryRun.events,
    ["freshness", "context", "evidence", "qwen-semantics"],
    "a Qwen3 semantic boundary violation must stop before draft generation"
  );
  assert.ok(errors.some((message) => /unexpected model notqwen3fake/i.test(message)));
  errors.length = 0;

  // Explicit false must override a persisted true setting and preserve the old path.
  settings["pageAnalysis.qwenOnly"] = true;
  const copilotRun = newRun("configured-copilot");
  await execute({ qwenOnly: false }, copilotRun);
  assert.strictEqual(copilotRun.configuredFactoryCalls, 1);
  assert.strictEqual(copilotRun.explicitQwenFactoryCalls, 0, "the existing path must not use the explicit Qwen factory");
  assert.strictEqual(copilotRun.qwenIdentityCalls, 0);
  assert.deepStrictEqual(copilotRun.semanticConstructorArgs, [[]], "the existing path must retain the optionless semantic analyzer");
  assert.deepStrictEqual(copilotRun.copilotDraftClients, [copilotClient]);
  assert.deepStrictEqual(copilotRun.iterativeClients, [], "the existing path must not construct the iterative Qwen generator");
  assert.deepStrictEqual(copilotRun.repairClients, [copilotClient], "existing gap repair must receive the configured Copilot client");
  assert.deepStrictEqual(copilotRun.repairOptions, [undefined], "the existing Copilot path must retain legacy repair behavior");
  assert.deepStrictEqual(copilotRun.events, [
    "freshness", "context", "evidence", "qwen-semantics", "copilot-draft",
    "gap", "repair", "final", "quality", "quality-write", "quality-aggregate"
  ]);

  settings["ai.provider"] = "copilot";
  settings["pageAnalysis.qwenOnly"] = false;
  const persistedFalseRun = newRun("persisted-false");
  await execute(undefined, persistedFalseRun);
  assert.deepStrictEqual(persistedFalseRun.copilotDraftClients, [copilotClient], "no-argument command must preserve the default Copilot path when the checkbox is off");
  assert.strictEqual(persistedFalseRun.explicitQwenFactoryCalls, 0);

  settings["pageAnalysis.qwenOnly"] = true;
  const persistedTrueRun = newRun("persisted-true");
  await execute(undefined, persistedTrueRun);
  assert.deepStrictEqual(persistedTrueRun.iterativeClients, [qwenClient], "no-argument command must honor the persisted Qwen3-only checkbox");
  assert.strictEqual(persistedTrueRun.configuredFactoryCalls, 0);

  settings["ai.provider"] = "qwen";
  const configuredQwenRun = newRun("legacy-configured-qwen");
  await execute({ qwenOnly: false }, configuredQwenRun);
  assert.strictEqual(configuredQwenRun.configuredFactoryCalls, 1);
  assert.deepStrictEqual(configuredQwenRun.copilotDraftClients, [configuredQwenClient], "explicit false must preserve the legacy configured-Qwen single-shot path");
  assert.deepStrictEqual(configuredQwenRun.repairClients, [configuredQwenClient]);
  assert.deepStrictEqual(configuredQwenRun.repairOptions, [undefined], "legacy configured-Qwen mode must not silently opt into Qwen3-only repair rules");
  assert.deepStrictEqual(configuredQwenRun.iterativeClients, []);

  settings["ai.provider"] = "copilot";
  settings["pageAnalysis.qwenOnly"] = false;
  let enterProgress;
  let releaseProgress;
  const enteredPromise = new Promise((resolve) => { enterProgress = resolve; });
  const releasePromise = new Promise((resolve) => { releaseProgress = resolve; });
  progressBarrier = { entered: enterProgress, releasePromise };
  const concurrentRun = newRun("concurrency-lock");
  currentRun = concurrentRun;
  const firstRunPromise = runFullSelectedPageAnalysisCommand({}, { qwenOnly: false });
  await enteredPromise;
  await runFullSelectedPageAnalysisCommand({}, { qwenOnly: false });
  releaseProgress();
  await firstRunPromise;
  progressBarrier = undefined;
  currentRun = undefined;
  assert.strictEqual(concurrentRun.configuredFactoryCalls, 1, "a concurrent duplicate must be rejected before creating a second model client");
  assert.ok(warnings.some((message) => /zaten calisiyor/i.test(message)), "a concurrent duplicate must show an active-run warning");

  assert.deepStrictEqual(errors, [], "all command matrix runs must finish without VS Code error messages");
  assert.strictEqual(languageModelSelections, 0, "the mocked command test must not access VS Code LM");
  assert.strictEqual(networkCalls, 0, "the mocked command test must stay fully offline");
  console.log("Qwen-only command tests passed (explicit Qwen and configured Copilot paths mocked; no live AI calls).");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
