const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const settings = {
  "ai.provider": "copilot",
  "pageAnalysis.qwenOnly": false,
  "pageAnalysis.copilotQwenSemanticPrepassEnabled": false,
  "qwen.interRequestDelaySeconds": 21,
  "qwen.contextWindowTokens": 32768,
  "qwen.generationMaxTokens": 8192,
  "pageAnalysis.qwenAnalysisMaxOutputTokens": 1536,
  "pageAnalysis.qwenReduceMaxOutputTokens": 2560,
  "pageAnalysis.qwenSynthesisMaxOutputTokens": 3584
};
const commandCalls = [];
const configurationUpdates = [];
let networkCalls = 0;

const vscodeMock = {
  ConfigurationTarget: { Global: "global" },
  workspace: {
    getConfiguration: () => ({
      get(key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue;
      },
      async update(key, value, target) {
        configurationUpdates.push({ key, value, target });
        settings[key] = value;
      }
    }),
    onDidChangeConfiguration() {
      return { dispose() {} };
    }
  },
  commands: {
    async executeCommand(command, ...args) {
      commandCalls.push({ command, args });
      return undefined;
    }
  },
  lm: {
    async selectChatModels() {
      return [];
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeMock;
  }
  return originalLoad.apply(this, arguments);
};

global.fetch = async () => {
  networkCalls += 1;
  throw new Error("Qwen-only panel tests attempted a network call");
};

const { BankSpringDocsViewProvider } = require("../dist/views/bankSpringDocsViewProvider");

async function main() {
  const postedMessages = [];
  let receiveMessage;
  const webviewView = {
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage(handler) {
        receiveMessage = handler;
        return { dispose() {} };
      },
      postMessage(message) {
        postedMessages.push(message);
        return Promise.resolve(true);
      }
    },
    onDidDispose() {
      return { dispose() {} };
    }
  };
  const context = {
    extensionUri: { fsPath: "C:\\mock-extension" },
    subscriptions: [],
    globalState: {
      get() { return undefined; },
      async update() {}
    },
    secrets: {
      async get() { return undefined; }
    }
  };
  const analyzeCommand = {
    async analyzeRepository() {
      throw new Error("Repository analysis must not run in panel contract tests");
    }
  };

  const provider = new BankSpringDocsViewProvider(context, analyzeCommand);
  provider.resolveWebviewView(webviewView);
  assert.strictEqual(typeof receiveMessage, "function", "the provider must register a webview message handler");

  const html = webviewView.webview.html;
  const viewProviderSource = fs.readFileSync(
    path.join(__dirname, "../src/views/bankSpringDocsViewProvider.ts"),
    "utf8"
  );
  const standalonePanelSource = fs.readFileSync(
    path.join(__dirname, "../src/views/bankSpringDocsPanel.ts"),
    "utf8"
  );
  assert.match(html, /id="pageAnalysisQwenOnly"[^>]*type="checkbox"/);
  assert.match(html, /id="runFullSelectedPageAnalysisButton"/);
  assert.match(html, /type: "savePageAnalysisQwenOnly"/);
  assert.match(html, /type: "runFullSelectedPageAnalysis", qwenOnly: pageAnalysisQwenOnly\.checked/);
  assert.match(html, /id="qwenBankingEnvironment"[^>]*type="checkbox"/);
  assert.match(html, /Banking environment \(ONIKS \/ internal vLLM\)/);
  assert.match(html, /bankingEnvironment: qwenBankingEnvironment\.checked/);
  assert.match(html, /qwenBankingEnvironment\.checked = Boolean\(message\.qwen\.bankingEnvironment\)/);
  assert.match(html, /qwenBankingEnvironment\.addEventListener\("change"/);
  assert.match(html, /qwenModel\.value = "ONIKS"/);
  assert.match(html, /qwenEnabled\.checked = true/);
  assert.match(html, /qwenUseApiKey\.checked = false/);
  assert.match(html, /qwenModel\.disabled = enabled/);
  assert.match(html, /qwenUseApiKey\.disabled = enabled/);
  assert.match(html, /qwenApiKey\.disabled = enabled/);
  for (const viewMarkup of [html, standalonePanelSource]) {
    assert.match(viewMarkup, /id="copilotQwenSemanticPrepassEnabled"[^>]*type="checkbox"/);
    assert.match(viewMarkup, /type: "saveCopilotQwenSemanticPrepass"/);
    assert.match(viewMarkup, /Qwen-only akışı semantic ön adımı ve eski semantic artifact'leri her zaman atlar/);
    assert.match(viewMarkup, /copilotQwenSemanticPrepassEnabled\.checked = Boolean\(message\.pageAnalysis\.copilotQwenSemanticPrepassEnabled\)/);
    assert.match(viewMarkup, /id="qwenContextWindowTokens"[^>]*type="number"/);
    assert.match(viewMarkup, /id="qwenGenerationMaxTokens"[^>]*type="number"/);
    assert.match(viewMarkup, /id="qwenAnalysisMaxOutputTokens"[^>]*type="number"/);
    assert.match(viewMarkup, /id="qwenReduceMaxOutputTokens"[^>]*type="number"/);
    assert.match(viewMarkup, /id="qwenSynthesisMaxOutputTokens"[^>]*type="number"/);
    assert.match(viewMarkup, /id="qwenInterRequestDelaySeconds"[^>]*type="number"[^>]*min="0"[^>]*max="300"/);
    assert.match(viewMarkup, /Qwen-only context ve aşama limitleri/);
    assert.match(viewMarkup, /Bu alanlar Copilot'u etkilemez/);
    assert.match(viewMarkup, /qwenContextWindowTokens: Number\(qwenContextWindowTokens\.value/);
    assert.match(viewMarkup, /qwenContextWindowTokens\.value = String\(message\.qwen\.qwenContextWindowTokens/);
    assert.match(viewMarkup, /interRequestDelaySeconds: Number\(qwenInterRequestDelaySeconds\.value/);
    assert.match(viewMarkup, /qwenInterRequestDelaySeconds\.value = String\(message\.qwen\.interRequestDelaySeconds \?\? 15\)/);
    assert.match(viewMarkup, /qwenMaxTokens\.value = "16384"/);
    assert.match(viewMarkup, /qwenContextWindowTokens\.value = "131072"/);
    assert.match(viewMarkup, /qwenGenerationMaxTokens\.value = "16384"/);
    assert.match(viewMarkup, /qwenAnalysisMaxOutputTokens\.value = "16384"/);
    assert.match(viewMarkup, /qwenReduceMaxOutputTokens\.value = "16384"/);
    assert.match(viewMarkup, /qwenSynthesisMaxOutputTokens\.value = "16384"/);
  }
  for (const viewSource of [viewProviderSource, standalonePanelSource]) {
    assert.match(viewSource, /"pageAnalysis\.copilotQwenSemanticPrepassEnabled"[\s\S]*vscode\.ConfigurationTarget\.Global/);
  }
  const fullRunButton = html.match(/<button\s+id="runFullSelectedPageAnalysisButton"[^>]*>/)?.[0] ?? "";
  assert.ok(fullRunButton, "the dedicated full-page analysis button must exist");
  assert.doesNotMatch(fullRunButton, /data-command=/, "the dedicated run button must not also use the generic command handler");

  await receiveMessage({ type: "runFullSelectedPageAnalysis", qwenOnly: true });
  assert.deepStrictEqual(commandCalls, [{
    command: "bankSpringDocs.runFullSelectedPageAnalysis",
    args: [{ qwenOnly: true }]
  }]);
  assert.deepStrictEqual(
    postedMessages.filter((message) => message.type === "pageAnalysisRunState").map((message) => message.running),
    [true, false],
    "the panel must disable and re-enable the full-run action around command execution"
  );
  assert.strictEqual(configurationUpdates.length, 0, "running the page pipeline must not mutate configuration");

  await receiveMessage({ type: "savePageAnalysisQwenOnly", enabled: true });
  assert.deepStrictEqual(configurationUpdates, [{
    key: "pageAnalysis.qwenOnly",
    value: true,
    target: "global"
  }]);
  assert.strictEqual(settings["ai.provider"], "copilot", "saving Qwen-only mode must preserve the configured Copilot provider");
  assert.ok(!configurationUpdates.some((update) => update.key === "ai.provider"), "Qwen-only mode must never update ai.provider");
  const settingsMessage = postedMessages.filter((message) => message.type === "settings").at(-1);
  assert.deepStrictEqual(settingsMessage?.pageAnalysis, {
    qwenOnly: true,
    copilotQwenSemanticPrepassEnabled: false
  }, "persisted page-analysis controls must be posted back to the panel independently");
  assert.deepStrictEqual({
    context: settingsMessage?.qwen?.qwenContextWindowTokens,
    generation: settingsMessage?.qwen?.qwenGenerationMaxTokens,
    analysis: settingsMessage?.qwen?.qwenAnalysisMaxOutputTokens,
    reduce: settingsMessage?.qwen?.qwenReduceMaxOutputTokens,
    synthesis: settingsMessage?.qwen?.qwenSynthesisMaxOutputTokens,
    interRequestDelaySeconds: settingsMessage?.qwen?.interRequestDelaySeconds
  }, {
    context: 32768,
    generation: 8192,
    analysis: 1536,
    reduce: 2560,
    synthesis: 3584,
    interRequestDelaySeconds: 21
  }, "opening/hydrating Qwen settings must preserve explicitly configured phase limits");

  await receiveMessage({ type: "saveCopilotQwenSemanticPrepass", enabled: true });
  assert.deepStrictEqual(configurationUpdates[1], {
    key: "pageAnalysis.copilotQwenSemanticPrepassEnabled",
    value: true,
    target: "global"
  }, "the Copilot semantic pre-pass toggle must persist at global scope");
  assert.strictEqual(settings["pageAnalysis.qwenOnly"], true, "saving the Copilot pre-pass must preserve Qwen-only mode");
  assert.strictEqual(settings["ai.provider"], "copilot", "saving the Copilot pre-pass must preserve the AI provider");
  assert.deepStrictEqual(
    postedMessages.filter((message) => message.type === "settings").at(-1)?.pageAnalysis,
    { qwenOnly: true, copilotQwenSemanticPrepassEnabled: true },
    "the newly persisted pre-pass value must be hydrated back to the panel"
  );

  commandCalls.length = 0;
  await receiveMessage({ type: "command", command: "bankSpringDocs.analyzeSelectedPage" });
  await receiveMessage({ type: "command", command: "bankSpringDocs.generateSelectedPageCopilotDraft" });
  assert.deepStrictEqual(commandCalls, [
    { command: "bankSpringDocs.analyzeSelectedPage", args: [] },
    { command: "bankSpringDocs.generateSelectedPageCopilotDraft", args: [] }
  ], "generic page commands must remain argument-free");

  const bankingSettings = {
    enabled: true,
    bankingEnvironment: true,
    endpoint: "https://bank-qwen.internal.example/v1/chat/completions",
    model: "ONIKS",
    temperature: 0.6,
    maxTokens: 16384,
    timeoutSeconds: 120,
    interRequestDelaySeconds: 15,
    qwenContextWindowTokens: 131072,
    qwenGenerationMaxTokens: 16384,
    qwenAnalysisMaxOutputTokens: 16384,
    qwenReduceMaxOutputTokens: 16384,
    qwenSynthesisMaxOutputTokens: 16384,
    useApiKey: false
  };
  commandCalls.length = 0;
  await receiveMessage({ type: "saveQwenSettings", settings: bankingSettings });
  await receiveMessage({ type: "testQwenConnection", settings: bankingSettings });
  assert.deepStrictEqual(commandCalls, [
    { command: "bankSpringDocs.saveQwenSettings", args: [bankingSettings] },
    { command: "bankSpringDocs.testQwenConnection", args: [bankingSettings] }
  ], "the side panel must forward the banking checkbox and pasted endpoint to both save and connection-test actions");
  const qwenLimitUpdates = configurationUpdates.slice(2);
  assert.deepStrictEqual(qwenLimitUpdates, [
    { key: "qwen.contextWindowTokens", value: 131072, target: "global" },
    { key: "qwen.generationMaxTokens", value: 16384, target: "global" },
    { key: "pageAnalysis.qwenAnalysisMaxOutputTokens", value: 16384, target: "global" },
    { key: "pageAnalysis.qwenReduceMaxOutputTokens", value: 16384, target: "global" },
    { key: "pageAnalysis.qwenSynthesisMaxOutputTokens", value: 16384, target: "global" },
    { key: "qwen.contextWindowTokens", value: 131072, target: "global" },
    { key: "qwen.generationMaxTokens", value: 16384, target: "global" },
    { key: "pageAnalysis.qwenAnalysisMaxOutputTokens", value: 16384, target: "global" },
    { key: "pageAnalysis.qwenReduceMaxOutputTokens", value: 16384, target: "global" },
    { key: "pageAnalysis.qwenSynthesisMaxOutputTokens", value: 16384, target: "global" }
  ], "Qwen-only limits must be persisted globally for save and connection-test actions");

  const updatesBeforeInvalid = configurationUpdates.length;
  const commandsBeforeInvalid = commandCalls.length;
  await receiveMessage({
    type: "saveQwenSettings",
    settings: { ...bankingSettings, qwenSynthesisMaxOutputTokens: 32768 }
  });
  assert.strictEqual(configurationUpdates.length, updatesBeforeInvalid, "invalid cross-field budgets must not partially persist");
  assert.strictEqual(commandCalls.length, commandsBeforeInvalid, "invalid Qwen limits must reject before the base Qwen save command");
  assert.match(postedMessages.at(-1)?.message ?? "", /çıktı bütçeleri.*üst sınırını aşamaz/i);

  await receiveMessage({
    type: "saveQwenSettings",
    settings: { ...bankingSettings, interRequestDelaySeconds: 301 }
  });
  assert.strictEqual(configurationUpdates.length, updatesBeforeInvalid, "an out-of-range cooldown must not persist limits");
  assert.strictEqual(commandCalls.length, commandsBeforeInvalid, "an out-of-range cooldown must reject before the base Qwen save command");
  assert.match(postedMessages.at(-1)?.message ?? "", /bekleme.*0-300/i);

  assert.strictEqual(networkCalls, 0, "panel contract tests must stay fully offline");
  console.log("Qwen-only panel tests passed (mocked VS Code; no network or live AI calls).");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
