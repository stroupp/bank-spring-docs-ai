const assert = require("assert");
const { createHash } = require("crypto");
const Module = require("module");

let settings = {};
let workspaceTrusted = true;
let languageModelSelections = 0;
let networkCalls = 0;
const requestBodies = [];
const requestOptions = [];
const requestUrls = [];
const responses = [];
const configurationUpdates = [];
const secretStores = [];
const TEST_BANKING_HOST = "bank-qwen.internal.example";
const TEST_BANKING_ENDPOINT = `https://${TEST_BANKING_HOST}/v1/chat/completions`;
const UNAPPROVED_BANKING_HOST = "unapproved-bank-qwen.internal.example";
const UNAPPROVED_BANKING_ENDPOINT = `https://${UNAPPROVED_BANKING_HOST}/v1/chat/completions`;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      ConfigurationTarget: { Global: "global" },
      workspace: {
        get isTrusted() { return workspaceTrusted; },
        getConfiguration: () => ({
          get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue,
          async update(key, value, target) {
            configurationUpdates.push({ key, value, target });
            settings[key] = value;
          }
        })
      },
      lm: {
        selectChatModels: async () => {
          languageModelSelections += 1;
          throw new Error("AI provider boundary test attempted vscode.lm access");
        }
      },
      LanguageModelChatMessage: {
        User: (content, name) => ({ role: "user", content, name })
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

global.fetch = async (url, options) => {
  networkCalls += 1;
  requestUrls.push(String(url));
  requestBodies.push(JSON.parse(options.body));
  requestOptions.push(options);
  const body = responses.shift();
  if (!body) {
    throw new Error("No mocked Qwen response was queued");
  }
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
};

const {
  assertQwen3ModelName,
  createDocumentationModelClient,
  createQwenDocumentationModelClient,
  getConfiguredDocumentationModelIdentity,
  getConfiguredDocumentationModelProvider,
  getQwenDocumentationModelIdentity,
  getResumableQwenPageModelIdentity
} = require("../dist/ai/documentationModelClientFactory");
const {
  assertBankingQwenEndpoint,
  normalizeChatCompletionsEndpoint,
  QwenClient
} = require("../dist/ai/qwenClient");
const {
  BANKING_QWEN_MODEL_ALIAS,
  normalizeBankingQwenEndpoint,
  QwenSettingsService
} = require("../dist/ai/qwenSettingsService");

const context = {
  secrets: {
    async get() { return undefined; },
    async store(key, value) { secretStores.push({ key, value }); }
  }
};
const token = {
  isCancellationRequested: false,
  onCancellationRequested() { return { dispose() {} }; }
};

async function main() {
  testQwenDefaultWithoutLanguageModelAccess();
  testQwen36SettingsDefaults();
  testExplicitQwenFactoryKeepsConfiguredCopilot();
  testResumableQwenIdentityIgnoresOperationalCeilings();
  testExplicitQwen3ModelPreflight();
  testExplicitQwenSecurityPreflights();
  testQwenEndpointNormalization();
  testBankingEndpointContract();
  await testBankingApprovalRequiresTrust();
  await testBankingPastedEndpointApproval();
  testBankingQwen3AliasPreflight();
  testQwenDisabledPreflight();
  testIncompleteQwenConfigurationRejected();
  testQwenEndpointPolicyPreflight();
  testUntrustedWorkspacePreflight();
  await testQwenStructuredGeneration();
  await testBankingQwenStructuredGeneration();
  await testBankingUnexpectedResponseModelRejected();
  await testBankingConnectionProbeMatchesWireContract();
  await testTruncatedQwenResponseRejected();
  await testQwenContextPreflight();
  await testConservativeQwenContextPreflight();
  await testPerRequestQwenOutputBudget();
  await testQwen36PhaseSamplingWireContract();
  await testGlobalQwenRequestSerializationAndCooldown();
  await testQwenQueueRecoversAfterFailureAndQueuedCancellation();
  testInvalidProviderRejected();

  assert.strictEqual(languageModelSelections, 0, "provider selection must not call vscode.lm until a Copilot request is sent");
  console.log("AI provider boundary tests passed (Qwen mocked; no live AI calls).");
}

function testQwenEndpointNormalization() {
  assert.strictEqual(
    normalizeChatCompletionsEndpoint("http://127.0.0.1:8000"),
    "http://127.0.0.1:8000/v1/chat/completions"
  );
}

function testBankingEndpointContract() {
  assert.strictEqual(BANKING_QWEN_MODEL_ALIAS, "ONIKS");
  assert.strictEqual(
    normalizeChatCompletionsEndpoint(`  ${TEST_BANKING_ENDPOINT}/  `),
    TEST_BANKING_ENDPOINT,
    "a pasted banking URL must tolerate whitespace and a trailing slash"
  );
  assert.deepStrictEqual(
    normalizeBankingQwenEndpoint(`  ${TEST_BANKING_ENDPOINT}/  `),
    { endpoint: TEST_BANKING_ENDPOINT, hostname: TEST_BANKING_HOST }
  );
  assert.doesNotThrow(() => assertBankingQwenEndpoint(TEST_BANKING_ENDPOINT));

  for (const endpoint of [
    TEST_BANKING_ENDPOINT.replace("https://", "http://"),
    TEST_BANKING_ENDPOINT.replace(TEST_BANKING_HOST, `${TEST_BANKING_HOST}:8443`),
    `https://${TEST_BANKING_HOST}/v1`,
    `${TEST_BANKING_ENDPOINT}?route=other`,
    `https://user:secret@${TEST_BANKING_HOST}/v1/chat/completions`
  ]) {
    assert.throws(() => assertBankingQwenEndpoint(endpoint), /bank|onayl|HTTPS/i);
  }

  settings = { ...bankingQwenSettings(), "qwen.endpoint": `https://${TEST_BANKING_HOST}/v1` };
  assert.throws(
    () => createQwenDocumentationModelClient(context),
    /bank|onayl|chat\/completions/i,
    "banking mode must not widen a shorter raw path through general endpoint normalization"
  );

  settings = { ...bankingQwenSettings(), "qwen.endpoint": UNAPPROVED_BANKING_ENDPOINT };
  assert.throws(
    () => createQwenDocumentationModelClient(context),
    /izin listesinde/i,
    "a valid banking-shaped endpoint must still be rejected until its pasted host is machine-approved"
  );
}

async function testBankingPastedEndpointApproval() {
  settings = {
    ...qwenSettings(),
    "qwen.allowedHosts": ["localhost"]
  };
  configurationUpdates.length = 0;
  secretStores.length = 0;

  const service = new QwenSettingsService(context);
  await service.saveSettings({
    enabled: false,
    bankingEnvironment: true,
    endpoint: `  ${TEST_BANKING_ENDPOINT}/  `,
    model: "must-be-overridden",
    temperature: 0.6,
    maxTokens: 4096,
    timeoutSeconds: 120,
    interRequestDelaySeconds: 23,
    useApiKey: true,
    apiKey: "must-not-be-stored"
  });

  assert.strictEqual(settings["qwen.endpoint"], TEST_BANKING_ENDPOINT);
  assert.strictEqual(settings["qwen.enabled"], true);
  assert.strictEqual(settings["qwen.bankingEnvironment"], true);
  assert.strictEqual(settings["qwen.model"], BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(settings["qwen.interRequestDelaySeconds"], 23);
  assert.strictEqual(settings["qwen.useApiKey"], false);
  assert.deepStrictEqual(settings["qwen.allowedHosts"], ["localhost", TEST_BANKING_HOST]);
  assert.ok(
    configurationUpdates.every((update) => update.target === "global"),
    "banking approval and settings must remain machine-scoped"
  );
  assert.deepStrictEqual(secretStores, [], "banking mode must not store a pasted API key");
}

async function testBankingApprovalRequiresTrust() {
  settings = {
    ...qwenSettings(),
    "qwen.allowedHosts": ["localhost"]
  };
  const originalSettings = JSON.parse(JSON.stringify(settings));
  configurationUpdates.length = 0;
  workspaceTrusted = false;

  try {
    const service = new QwenSettingsService(context);
    await assert.rejects(
      () => service.saveSettings({
        enabled: false,
        bankingEnvironment: true,
        endpoint: TEST_BANKING_ENDPOINT,
        model: "must-be-overridden",
        temperature: 0.6,
        maxTokens: 4096,
        timeoutSeconds: 120,
        interRequestDelaySeconds: 15,
        useApiKey: false
      }),
      /trusted VS Code workspace/i
    );
    assert.deepStrictEqual(settings, originalSettings, "untrusted banking approval must not mutate settings");
    assert.deepStrictEqual(configurationUpdates, [], "untrusted banking approval must fail before configuration writes");
  } finally {
    workspaceTrusted = true;
  }
}

function testBankingQwen3AliasPreflight() {
  assert.strictEqual(assertQwen3ModelName(BANKING_QWEN_MODEL_ALIAS, true), BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(assertQwen3ModelName(" oniks ", true), "oniks");
  assert.throws(() => assertQwen3ModelName(BANKING_QWEN_MODEL_ALIAS), /Qwen3/i);

  settings = { ...qwenSettings(), "qwen.model": BANKING_QWEN_MODEL_ALIAS };
  assert.throws(
    () => createQwenDocumentationModelClient(context),
    /Qwen3/i,
    "ONIKS must not attest Qwen3 identity outside the exact banking mode"
  );

  settings = bankingQwenSettings();
  assert.strictEqual(createQwenDocumentationModelClient(context).provider, "qwen");
  const identity = getResumableQwenPageModelIdentity(context);
  assert.strictEqual(identity.model, BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(identity.family, "qwen3");
  assert.match(identity.configurationFingerprint, /^[a-f0-9]{64}$/);

  settings = {
    ...bankingQwenSettings(),
    "qwen.bankingEnvironment": false,
    "qwen.model": BANKING_QWEN_MODEL_ALIAS,
    "qwen.allowedHosts": [TEST_BANKING_HOST]
  };
  const nonBankingIdentity = getResumableQwenPageModelIdentity(context);
  assert.strictEqual(nonBankingIdentity.family, undefined);
  assert.notStrictEqual(
    nonBankingIdentity.configurationFingerprint,
    identity.configurationFingerprint,
    "banking attestation must be part of resumable identity while established non-banking identities stay unchanged"
  );
}

function testIncompleteQwenConfigurationRejected() {
  settings = { ...qwenSettings(), "qwen.model": "" };
  assert.throws(() => createDocumentationModelClient(context), /model adı boş/i);
  settings = { ...qwenSettings(), "qwen.endpoint": "" };
  assert.throws(() => createDocumentationModelClient(context), /endpoint adresi boş/i);
}

function testQwenEndpointPolicyPreflight() {
  settings = { ...qwenSettings(), "qwen.endpoint": "not-a-url" };
  assert.throws(() => createDocumentationModelClient(context), /HTTP\(S\) URL/i);

  settings = { ...qwenSettings(), "qwen.endpoint": "https://unapproved.example/v1/chat/completions" };
  assert.throws(() => createDocumentationModelClient(context), /izin listesinde değil/i);

  settings = {
    ...qwenSettings(),
    "qwen.endpoint": "https://qwen.bank.internal/v1/chat/completions",
    "qwen.allowedHosts": ["qwen.bank.internal"]
  };
  assert.strictEqual(createDocumentationModelClient(context).provider, "qwen");
  assert.strictEqual(networkCalls, 0);
}

function testUntrustedWorkspacePreflight() {
  settings = qwenSettings();
  workspaceTrusted = false;
  assert.throws(() => createDocumentationModelClient(context), /çalışma alanına güvenilmelidir/i);
  workspaceTrusted = true;
}

function testQwenDefaultWithoutLanguageModelAccess() {
  settings = {};
  const client = createDocumentationModelClient(context);
  assert.strictEqual(getConfiguredDocumentationModelProvider(), "qwen");
  assert.strictEqual(client.provider, "qwen");
  const identity = getConfiguredDocumentationModelIdentity(context);
  assert.strictEqual(identity.provider, "qwen");
  assert.strictEqual(identity.model, "Qwen/Qwen3.6-27B");
  assert.match(identity.configurationFingerprint, /^[a-f0-9]{64}$/);
  assert.strictEqual(networkCalls, 0);
}

function testQwen36SettingsDefaults() {
  settings = {};
  const defaults = new QwenSettingsService(context).getSettings();
  assert.strictEqual(defaults.enabled, true);
  assert.strictEqual(defaults.bankingEnvironment, false);
  assert.strictEqual(defaults.model, "Qwen/Qwen3.6-27B");
  assert.strictEqual(defaults.temperature, 0.6);
  assert.strictEqual(defaults.maxTokens, 16384);
  assert.strictEqual(defaults.interRequestDelaySeconds, 15);
}

function testExplicitQwenFactoryKeepsConfiguredCopilot() {
  settings = { ...qwenSettings(), "ai.provider": "copilot" };
  const networkCallsBefore = networkCalls;
  const languageModelSelectionsBefore = languageModelSelections;

  assert.strictEqual(getConfiguredDocumentationModelProvider(), "copilot");
  assert.strictEqual(createQwenDocumentationModelClient(context).provider, "qwen");
  const explicitIdentity = getQwenDocumentationModelIdentity(context);
  assert.strictEqual(explicitIdentity.provider, "qwen");
  assert.strictEqual(explicitIdentity.model, "qwen3-30b-a3b-instruct");
  assert.match(explicitIdentity.configurationFingerprint, /^[a-f0-9]{64}$/);
  assert.strictEqual(getConfiguredDocumentationModelProvider(), "copilot");
  assert.strictEqual(networkCalls, networkCallsBefore, "explicit Qwen creation must not call the network");
  assert.strictEqual(
    languageModelSelections,
    languageModelSelectionsBefore,
    "explicit Qwen creation must not select a Copilot language model"
  );
}

function testResumableQwenIdentityIgnoresOperationalCeilings() {
  settings = {
    ...qwenSettings(),
    "ai.provider": "copilot",
    "qwen.generationTimeoutSeconds": 600
  };
  const baselineGeneral = getQwenDocumentationModelIdentity(context).configurationFingerprint;
  const baselinePage = getResumableQwenPageModelIdentity(context).configurationFingerprint;
  assert.strictEqual(
    baselineGeneral,
    createHash("sha256").update(JSON.stringify({
      provider: "qwen",
      endpoint: "http://127.0.0.1:8000/v1/chat/completions",
      model: "qwen3-30b-a3b-instruct",
      temperature: 0.1,
      generationTimeoutSeconds: 600,
      generationMaxTokens: 12000,
      contextWindowTokens: 131072
    })).digest("hex"),
    "the established configured-Qwen fingerprint must remain byte-compatible"
  );

  settings = { ...settings, "qwen.generationTimeoutSeconds": 900 };
  assert.notStrictEqual(
    getQwenDocumentationModelIdentity(context).configurationFingerprint,
    baselineGeneral,
    "the general provider identity must continue to pin generation timeout"
  );
  assert.strictEqual(
    getResumableQwenPageModelIdentity(context).configurationFingerprint,
    baselinePage,
    "changing only the retry timeout must preserve selected-page resume identity"
  );

  const timeoutGeneral = getQwenDocumentationModelIdentity(context).configurationFingerprint;
  settings = { ...settings, "qwen.generationMaxTokens": 16000 };
  assert.notStrictEqual(
    getQwenDocumentationModelIdentity(context).configurationFingerprint,
    timeoutGeneral,
    "the general provider identity must continue to pin the global generation ceiling"
  );
  assert.strictEqual(
    getResumableQwenPageModelIdentity(context).configurationFingerprint,
    baselinePage,
    "changing only the global ceiling must preserve page-map resume identity because per-step phase budgets remain hashed"
  );

  settings = { ...settings, "qwen.temperature": 0.2 };
  assert.notStrictEqual(
    getResumableQwenPageModelIdentity(context).configurationFingerprint,
    baselinePage,
    "model-output settings must still invalidate selected-page resume identity"
  );
}

function testExplicitQwen3ModelPreflight() {
  assert.strictEqual(assertQwen3ModelName(" Qwen/Qwen3-8B "), "Qwen/Qwen3-8B");
  for (const invalidModel of ["", "qwen2.5-72b", "qwq-32b", "myqwen3fake"]) {
    assert.throws(() => assertQwen3ModelName(invalidModel), /Qwen3/i);
  }

  settings = { ...qwenSettings(), "ai.provider": "copilot", "qwen.model": "qwen2.5-72b" };
  const networkCallsBefore = networkCalls;
  const languageModelSelectionsBefore = languageModelSelections;
  assert.throws(() => createQwenDocumentationModelClient(context), /Qwen3/i);
  assert.strictEqual(networkCalls, networkCallsBefore, "invalid Qwen3 model must reject before network access");
  assert.strictEqual(
    languageModelSelections,
    languageModelSelectionsBefore,
    "invalid Qwen3 model must reject without selecting a Copilot language model"
  );
  assert.strictEqual(getConfiguredDocumentationModelProvider(), "copilot");
}

function testExplicitQwenSecurityPreflights() {
  settings = { ...qwenSettings(), "ai.provider": "copilot" };
  const networkCallsBefore = networkCalls;

  workspaceTrusted = false;
  assert.throws(() => createQwenDocumentationModelClient(context), /VS Code/i);
  workspaceTrusted = true;

  settings = {
    ...qwenSettings(),
    "ai.provider": "copilot",
    "qwen.endpoint": "https://unapproved.example/v1/chat/completions"
  };
  assert.throws(() => createQwenDocumentationModelClient(context), /izin listesinde/i);
  assert.strictEqual(networkCalls, networkCallsBefore, "Qwen trust and allowlist failures must reject before network access");
  assert.strictEqual(getConfiguredDocumentationModelProvider(), "copilot");
}

function testQwenDisabledPreflight() {
  settings = { "ai.provider": "qwen", "qwen.enabled": false };
  assert.throws(() => createDocumentationModelClient(context), /Qwen.*etkin değil/i);
  assert.strictEqual(networkCalls, 0);
}

async function testQwenStructuredGeneration() {
  settings = qwenSettings();
  responses.push({
    id: "qwen-request-1",
    model: "qwen3-30b-a3b-instruct",
    choices: [{ message: { content: "# Grounded document", reasoning_content: "must not be used" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 }
  });

  const client = createDocumentationModelClient(context);
  assert.strictEqual(client.provider, "qwen");
  const identity = getConfiguredDocumentationModelIdentity(context);
  assert.strictEqual(identity.provider, "qwen");
  assert.strictEqual(identity.model, "qwen3-30b-a3b-instruct");
  assert.match(identity.configurationFingerprint, /^[a-f0-9]{64}$/);

  const result = await client.send({
    instructions: "Use only evidence.",
    userPrompt: "Write the document from bounded evidence.",
    combinedText: "Use only evidence.\n\nWrite the document from bounded evidence."
  }, token);

  assert.strictEqual(result.text, "# Grounded document");
  assert.strictEqual(result.provider, "qwen");
  assert.strictEqual(result.model.id, "qwen3-30b-a3b-instruct");
  assert.strictEqual(result.finishReason, "stop");
  assert.strictEqual(result.requestId, "qwen-request-1");
  assert.strictEqual(result.usage.promptTokens, 123);
  assert.strictEqual(result.usage.completionTokens, 45);
  assert.strictEqual(result.usage.totalTokens, 168);

  const request = requestBodies.at(-1);
  assert.deepStrictEqual(request.messages, [
    { role: "system", content: "Use only evidence." },
    { role: "user", content: "Write the document from bounded evidence." }
  ]);
  assert.strictEqual(request.max_tokens, 12000);
  assert.strictEqual(request.stream, false);
  assert.strictEqual(requestOptions.at(-1).redirect, "error", "Qwen HTTP requests must reject redirects");
  assert.strictEqual(languageModelSelections, 0);
}

async function testBankingQwenStructuredGeneration() {
  settings = bankingQwenSettings();
  responses.push({
    id: "banking-qwen-request-1",
    model: BANKING_QWEN_MODEL_ALIAS,
    choices: [{ message: { content: "# Banking Qwen3 document" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 }
  });

  const client = createQwenDocumentationModelClient(context);
  const result = await client.send({
    instructions: "Use only bounded banking evidence.",
    userPrompt: "Write the selected-page document.",
    combinedText: "Use only bounded banking evidence.\n\nWrite the selected-page document."
  }, token);

  assert.strictEqual(result.provider, "qwen");
  assert.strictEqual(result.model.id, BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(result.model.name, BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(result.model.family, "qwen3", "the exact approved banking alias must attest Qwen3 to selected-page validators");
  assert.strictEqual(result.requestId, "banking-qwen-request-1");

  const request = requestBodies.at(-1);
  const options = requestOptions.at(-1);
  assert.strictEqual(requestUrls.at(-1), TEST_BANKING_ENDPOINT);
  assert.strictEqual(request.model, BANKING_QWEN_MODEL_ALIAS);
  assert.deepStrictEqual(request.messages, [
    { role: "system", content: "Use only bounded banking evidence." },
    { role: "user", content: "Write the selected-page document." }
  ]);
  assert.strictEqual(options.method, "POST");
  assert.strictEqual(options.redirect, "error");
  assert.deepStrictEqual(options.headers, { "Content-Type": "application/json" });
  assert.ok(!Object.keys(options.headers).some((name) => name.toLowerCase() === "authorization"));
}

async function testBankingUnexpectedResponseModelRejected() {
  settings = bankingQwenSettings();
  responses.push({
    model: "qwen2.5-unexpected",
    choices: [{ message: { content: "must not be accepted" }, finish_reason: "stop" }]
  });

  const client = createQwenDocumentationModelClient(context);
  await assert.rejects(
    () => client.send("bounded banking prompt", token),
    /unexpected Qwen model response/i,
    "banking family attestation must not hide a conflicting server-reported model"
  );
}

async function testBankingConnectionProbeMatchesWireContract() {
  settings = bankingQwenSettings();
  const directSettings = {
    enabled: true,
    bankingEnvironment: true,
    endpoint: `  ${TEST_BANKING_ENDPOINT}  `,
    model: BANKING_QWEN_MODEL_ALIAS,
    temperature: 0.6,
    maxTokens: 4096,
    timeoutSeconds: 120,
    interRequestDelaySeconds: 0,
    useApiKey: true
  };
  let apiKeyReads = 0;
  const client = new QwenClient({
    getSettings: () => ({ ...directSettings }),
    async getApiKey() {
      apiKeyReads += 1;
      return "must-not-be-sent-in-banking-mode";
    }
  });
  responses.push({
    id: "banking-qwen-connection-test",
    model: BANKING_QWEN_MODEL_ALIAS,
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }]
  });

  const result = await client.testConnection();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.model, BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(result.endpoint, TEST_BANKING_ENDPOINT);
  assert.strictEqual(apiKeyReads, 0, "banking mode must never read or send a stored bearer secret");

  const request = requestBodies.at(-1);
  const options = requestOptions.at(-1);
  assert.strictEqual(requestUrls.at(-1), TEST_BANKING_ENDPOINT);
  assert.strictEqual(request.model, BANKING_QWEN_MODEL_ALIAS);
  assert.strictEqual(request.temperature, 0.6);
  assert.strictEqual(request.max_tokens, 64, "connection probes must not inherit a huge configured generation cap");
  assert.strictEqual(request.stream, false);
  assert.deepStrictEqual(request.messages, [
    {
      role: "system",
      content: "You are a Qwen connection test. Return only the exact JSON requested by the user, without explanation."
    },
    { role: "user", content: 'Return exactly this JSON: {"ok":true}' }
  ]);
  assert.strictEqual(options.method, "POST");
  assert.strictEqual(options.redirect, "error");
  assert.deepStrictEqual(options.headers, { "Content-Type": "application/json" });
}

async function testTruncatedQwenResponseRejected() {
  settings = qwenSettings();
  responses.push({
    model: "qwen3-30b-a3b-instruct",
    choices: [{ message: { content: "incomplete" }, finish_reason: "length" }]
  });
  const client = createDocumentationModelClient(context);
  await assert.rejects(() => client.send("bounded prompt", token), /maksimum token|kesildi/i);
}

async function testQwen36PhaseSamplingWireContract() {
  settings = {
    ...qwenSettings(),
    "qwen.model": "Qwen/Qwen3.6-27B",
    "qwen.temperature": 0.6
  };
  responses.push(
    {
      model: "Qwen/Qwen3.6-27B",
      choices: [{ message: { content: '{"sections":[]}' }, finish_reason: "stop" }]
    },
    {
      model: "Qwen/Qwen3.6-27B",
      choices: [{ message: { content: "## Sayfa Amacı\nGrounded." }, finish_reason: "stop" }]
    }
  );
  const client = createQwenDocumentationModelClient(context);
  await client.send({
    instructions: "Return JSON.",
    userPrompt: "Extract evidence.",
    combinedText: "Return JSON.\n\nExtract evidence.",
    profile: "qwen3-page-chunk-analysis",
    maxOutputTokens: 2048
  }, token);
  const analysisRequest = requestBodies.at(-1);
  assert.strictEqual(analysisRequest.temperature, 0.7);
  assert.strictEqual(analysisRequest.top_p, 0.8);
  assert.strictEqual(analysisRequest.top_k, 20);
  assert.strictEqual(analysisRequest.presence_penalty, 1.5);
  assert.deepStrictEqual(analysisRequest.chat_template_kwargs, { enable_thinking: false });

  await client.send({
    instructions: "Return Markdown.",
    userPrompt: "Synthesize grounded sections.",
    combinedText: "Return Markdown.\n\nSynthesize grounded sections.",
    profile: "qwen3-page-final-synthesis",
    maxOutputTokens: 8192
  }, token);
  const synthesisRequest = requestBodies.at(-1);
  assert.strictEqual(synthesisRequest.temperature, 0.6);
  assert.strictEqual(synthesisRequest.top_p, 0.95);
  assert.strictEqual(synthesisRequest.top_k, 20);
  assert.strictEqual(synthesisRequest.presence_penalty, 0);
  assert.deepStrictEqual(synthesisRequest.chat_template_kwargs, { enable_thinking: true });
}

async function testGlobalQwenRequestSerializationAndCooldown() {
  settings = { "qwen.allowedHosts": ["127.0.0.1"] };
  const directSettings = directQwen36Settings(0.04);
  const firstClient = directQwenClient(directSettings);
  const secondClient = directQwenClient(directSettings);
  const originalFetch = global.fetch;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let requestCount = 0;
  let firstParsedAt = 0;
  let secondStartedAt = 0;

  global.fetch = async () => {
    requestCount += 1;
    const current = requestCount;
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    if (current === 1) {
      markFirstStarted();
      await firstRelease;
    } else {
      secondStartedAt = Date.now();
    }
    activeRequests -= 1;
    return successfulResponse("Qwen/Qwen3.6-27B", `response-${current}`, () => {
      if (current === 1) {
        firstParsedAt = Date.now();
      }
    });
  };

  try {
    const first = firstClient.complete([{ role: "user", content: "first" }]);
    await firstStarted;
    let secondSettled = false;
    const second = secondClient.complete([{ role: "user", content: "second" }]).finally(() => {
      secondSettled = true;
    });
    await delay(10);
    assert.strictEqual(requestCount, 1, "a second QwenClient instance must not overlap the active request");
    assert.strictEqual(secondSettled, false, "the queued request must remain pending until the first response completes");
    releaseFirst();
    await Promise.all([first, second]);
    assert.strictEqual(maximumActiveRequests, 1, "the shared coordinator must enforce Qwen concurrency=1");
    assert.ok(
      secondStartedAt - firstParsedAt >= 30,
      `the next request must observe the configured response cooldown (observed ${secondStartedAt - firstParsedAt}ms)`
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testQwenQueueRecoversAfterFailureAndQueuedCancellation() {
  settings = { "qwen.allowedHosts": ["127.0.0.1"] };
  const directSettings = directQwen36Settings(0);
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("fetch failed");
    }
    return successfulResponse("Qwen/Qwen3.6-27B", "recovered");
  };
  try {
    const firstClient = directQwenClient(directSettings);
    const secondClient = directQwenClient(directSettings);
    const [failed, recovered] = await Promise.allSettled([
      firstClient.complete([{ role: "user", content: "fail once" }]),
      secondClient.complete([{ role: "user", content: "recover" }])
    ]);
    assert.strictEqual(failed.status, "rejected");
    assert.strictEqual(recovered.status, "fulfilled", "a failed request must not poison the shared Qwen queue");
    assert.strictEqual(calls, 2);

    let releaseActive;
    let markActiveStarted;
    const activeStarted = new Promise((resolve) => { markActiveStarted = resolve; });
    const activeRelease = new Promise((resolve) => { releaseActive = resolve; });
    calls = 0;
    global.fetch = async () => {
      calls += 1;
      markActiveStarted();
      await activeRelease;
      return successfulResponse("Qwen/Qwen3.6-27B", "active-complete");
    };
    const active = firstClient.complete([{ role: "user", content: "active" }]);
    await activeStarted;
    const cancellable = cancellationToken();
    const queued = secondClient.complete([{ role: "user", content: "queued" }], {}, cancellable.token);
    cancellable.cancel();
    await assert.rejects(
      () => Promise.race([queued, delay(150).then(() => { throw new Error("queued cancellation timed out"); })]),
      /iptal|cancel/i
    );
    assert.strictEqual(calls, 1, "a request cancelled while queued must never reach fetch");
    releaseActive();
    await active;
  } finally {
    global.fetch = originalFetch;
  }
}

async function testQwenContextPreflight() {
  settings = {
    ...qwenSettings(),
    "qwen.contextWindowTokens": 8192,
    "qwen.generationMaxTokens": 12000
  };
  const before = networkCalls;
  const client = createDocumentationModelClient(context);
  await assert.rejects(() => client.send("bounded prompt", token), /bağlam bütçesi|context/i);
  assert.strictEqual(networkCalls, before, "context preflight must reject before network access");
}

async function testConservativeQwenContextPreflight() {
  settings = {
    ...qwenSettings(),
    "qwen.contextWindowTokens": 1700,
    "qwen.generationMaxTokens": 1000
  };
  const before = networkCalls;
  const client = createDocumentationModelClient(context);
  await assert.rejects(() => client.send("x".repeat(1800), token), /bağlam bütçesi|context/i);
  assert.strictEqual(networkCalls, before, "conservative context preflight must include dense-token and chat-template safety margin");
}

async function testPerRequestQwenOutputBudget() {
  settings = {
    ...qwenSettings(),
    "qwen.contextWindowTokens": 16384,
    "qwen.generationMaxTokens": 16384
  };
  responses.push({
    model: "qwen3-30b-a3b-instruct",
    choices: [{ message: { content: "bounded output" }, finish_reason: "stop" }]
  });
  const client = createDocumentationModelClient(context);
  await client.send({
    userPrompt: "x".repeat(1800),
    combinedText: "x".repeat(1800),
    maxOutputTokens: 4096
  }, token);
  assert.strictEqual(requestBodies.at(-1).max_tokens, 4096, "a phase budget must make a truthful 16K context usable");

  settings = qwenSettings();
  responses.push({
    model: "qwen3-30b-a3b-instruct",
    choices: [{ message: { content: "configured cap" }, finish_reason: "stop" }]
  });
  const cappedClient = createDocumentationModelClient(context);
  await cappedClient.send({ userPrompt: "bounded prompt", maxOutputTokens: 50000 }, token);
  assert.strictEqual(
    requestBodies.at(-1).max_tokens,
    12000,
    "per-request output budget must not exceed configured generationMaxTokens"
  );

  const beforeInvalid = networkCalls;
  await assert.rejects(
    () => cappedClient.send({ userPrompt: "bounded prompt", maxOutputTokens: 0 }, token),
    /maxOutputTokens.*sıfırdan büyük/i
  );
  assert.strictEqual(networkCalls, beforeInvalid, "invalid request output budget must reject before network access");
}

function testInvalidProviderRejected() {
  settings = { "ai.provider": "unexpected-provider" };
  assert.throws(() => getConfiguredDocumentationModelProvider(), /Desteklenmeyen/i);
}

function qwenSettings() {
  return {
    "ai.provider": "qwen",
    "qwen.enabled": true,
    "qwen.bankingEnvironment": false,
    "qwen.endpoint": "http://127.0.0.1:8000/v1/chat/completions",
    "qwen.model": "qwen3-30b-a3b-instruct",
    "qwen.temperature": 0.1,
    "qwen.maxTokens": 4096,
    "qwen.timeoutSeconds": 120,
    "qwen.interRequestDelaySeconds": 0,
    "qwen.useApiKey": false,
    "qwen.generationTimeoutSeconds": 600,
    "qwen.generationMaxTokens": 12000,
    "qwen.contextWindowTokens": 131072
  };
}

function bankingQwenSettings() {
  return {
    ...qwenSettings(),
    "ai.provider": "copilot",
    "qwen.bankingEnvironment": true,
    "qwen.endpoint": `  ${TEST_BANKING_ENDPOINT}  `,
    "qwen.model": "ignored-wire-model",
    "qwen.temperature": 0.6,
    "qwen.maxTokens": 4096,
    "qwen.useApiKey": true,
    "qwen.allowedHosts": [TEST_BANKING_HOST]
  };
}

function directQwen36Settings(interRequestDelaySeconds) {
  return {
    enabled: true,
    bankingEnvironment: false,
    endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    model: "Qwen/Qwen3.6-27B",
    temperature: 0.6,
    maxTokens: 512,
    timeoutSeconds: 2,
    interRequestDelaySeconds,
    useApiKey: false
  };
}

function directQwenClient(directSettings) {
  return new QwenClient({
    getSettings: () => ({ ...directSettings }),
    async getApiKey() { return undefined; }
  });
}

function successfulResponse(model, content, onJson) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      onJson?.();
      return {
        model,
        choices: [{ message: { content }, finish_reason: "stop" }]
      };
    }
  };
}

function cancellationToken() {
  let cancelled = false;
  const listeners = new Set();
  return {
    token: {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose() { listeners.delete(listener); } };
      }
    },
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
