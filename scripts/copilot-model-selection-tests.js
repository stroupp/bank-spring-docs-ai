const assert = require("assert");
const Module = require("module");

const configuredModelId = "claude-sonnet-4.6";
const selectors = [];
let standardRequests = 0;
let cliRequests = 0;

function responseText(value) {
  return (async function* stream() {
    yield value;
  })();
}

function createModel(vendor, onRequest) {
  return {
    id: configuredModelId,
    name: `${vendor} test model`,
    vendor,
    family: "claude-sonnet",
    version: "4.6",
    maxInputTokens: 100000,
    countTokens: async () => 7,
    sendRequest: async () => {
      onRequest();
      return { text: responseText(vendor) };
    }
  };
}

const cliModel = createModel("copilotcli", () => { cliRequests += 1; });
const standardModel = createModel("copilot", () => { standardRequests += 1; });

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (key, defaultValue) => key === "copilot.modelId" ? configuredModelId : defaultValue
        })
      },
      lm: {
        selectChatModels: async (selector) => {
          selectors.push(selector);
          // Deliberately return the CLI model first and ignore the selector. The
          // client must verify provider metadata instead of trusting ordering.
          return [cliModel, standardModel];
        }
      },
      LanguageModelChatMessage: {
        User: (content, name) => ({ role: "user", content, name })
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

const { RealCopilotClient, askCopilotWithUsage } = require("../dist/ai/copilotClient");
const token = { isCancellationRequested: false };

async function main() {
  const client = new RealCopilotClient();
  const first = await client.send("first request", token);
  const second = await client.send("second request", token);

  assert.deepStrictEqual(selectors, [{ vendor: "copilot", id: configuredModelId }]);
  assert.strictEqual(standardRequests, 2, "the pinned standard model should handle both sends");
  assert.strictEqual(cliRequests, 0, "the copilotcli provider must never receive a request");
  assert.strictEqual(first.model.vendor, "copilot");
  assert.strictEqual(second.model.vendor, "copilot");
  assert.strictEqual(first.text, "copilot");
  assert.strictEqual(second.text, "copilot");

  const helperResponse = await askCopilotWithUsage("compatibility request", token);
  assert.deepStrictEqual(selectors[1], { vendor: "copilot", id: configuredModelId });
  assert.strictEqual(selectors.length, 2, "the compatibility helper should use a fresh filtered client");
  assert.strictEqual(standardRequests, 3);
  assert.strictEqual(cliRequests, 0);
  assert.strictEqual(helperResponse.model.vendor, "copilot");

  console.log("Copilot model selection tests passed (standard vendor selected, pinned, and used by compatibility helper).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
