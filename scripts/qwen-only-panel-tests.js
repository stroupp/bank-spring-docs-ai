const assert = require("assert");
const Module = require("module");

const settings = {
  "ai.provider": "copilot",
  "pageAnalysis.qwenOnly": false
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
  assert.deepStrictEqual(settingsMessage?.pageAnalysis, { qwenOnly: true }, "persisted Qwen-only state must be posted back to the panel");

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
    maxTokens: 163849,
    timeoutSeconds: 120,
    useApiKey: false
  };
  commandCalls.length = 0;
  await receiveMessage({ type: "saveQwenSettings", settings: bankingSettings });
  await receiveMessage({ type: "testQwenConnection", settings: bankingSettings });
  assert.deepStrictEqual(commandCalls, [
    { command: "bankSpringDocs.saveQwenSettings", args: [bankingSettings] },
    { command: "bankSpringDocs.testQwenConnection", args: [bankingSettings] }
  ], "the side panel must forward the banking checkbox and pasted endpoint to both save and connection-test actions");

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
