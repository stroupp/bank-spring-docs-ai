const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");

let networkCalls = 0;
global.fetch = async () => {
  networkCalls += 1;
  throw new Error("Qwen boundary test attempted a network call");
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (key, defaultValue) => key === "qwen.model" ? "mock-qwen" : defaultValue
        })
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

const { QwenPageSemanticAnalyzer, prepareQwenContext } = require("../dist/pageanalysis/qwenPageSemanticAnalyzer");
const { buildPageSemanticPrompt, buildInteractionSemanticPrompt } = require("../dist/pageanalysis/pageSemanticPrompts");
const { parseStrictJson } = require("../dist/semantic/semanticCacheService");
const token = {
  isCancellationRequested: false,
  onCancellationRequested() { return { dispose() {} }; }
};

async function main() {
  testPromptBuilders();
  testStrictJsonParsing();
  testContextBudgetAndSecretMasking();
  await testPageContextEvidenceCacheAndArtifacts();
  await testVerifiedQwen3SemanticClientAndSanitation();
  await testVerifiedQwen3SemanticTransientRetry();
  await testVerifiedQwen3SemanticOutageCircuitBreaker();
  await testApprovedBankingAliasAcceptedViaQwen3Family();
  await testVerifiedQwen3SemanticBoundaryRejection();
  await testVerifiedQwen3DebugSanitation();
  await testInvalidJsonDebugAndGracefulFailure();
  await testClientFailureDoesNotCrashAnalyzer();
  assert.strictEqual(networkCalls, 0, "automated Qwen tests must not use fetch");
  console.log("Qwen boundary tests passed (mock only; network calls: 0).");
}

function testContextBudgetAndSecretMasking() {
  const safe = prepareQwenContext(`api_key=boundary-qwen-secret\n${"x".repeat(3000)}`, 500);
  assert.ok(safe.length <= 500);
  assert.doesNotMatch(safe, /boundary-qwen-secret/);
  assert.match(safe, /\[MASKED_SECRET\]/);
  assert.match(safe, /PAGE_CONTEXT_TRUNCATED_FOR_QWEN_TOKEN_LIMIT/);

  const quoted = prepareQwenContext(
    `password: "two \\"quoted\\" words"\napi_key='two \\'quoted\\' words'`,
    1000
  );
  assert.doesNotMatch(quoted, /two|quoted|words/);
  assert.match(quoted, /password: "\[MASKED_SECRET\]"/);
  assert.match(quoted, /api_key='\[MASKED_SECRET\]'/);
}

function testPromptBuilders() {
  const pagePrompt = buildPageSemanticPrompt("PAGE_CONTEXT_SENTINEL\nEVIDENCE_SENTINEL");
  const interactionPrompt = buildInteractionSemanticPrompt("INTERACTION_SENTINEL");
  assert.match(pagePrompt, /PAGE_CONTEXT_SENTINEL/);
  assert.match(pagePrompt, /EVIDENCE_SENTINEL/);
  assert.match(pagePrompt, /Return strict JSON only/);
  assert.match(interactionPrompt, /INTERACTION_SENTINEL/);
  assert.match(interactionPrompt, /Return strict JSON only/);
}

function testStrictJsonParsing() {
  assert.deepStrictEqual(parseStrictJson('{"ok":true}'), { ok: true });
  assert.throws(() => parseStrictJson("not-json"), /parse edilemedi/i);
}

async function testPageContextEvidenceCacheAndArtifacts() {
  const pageRoot = await createPageRoot("qwen-cache", true);
  const responses = [
    JSON.stringify({ page: "CustomerSearch", confidence: "high", uncertainties: [] }),
    JSON.stringify({ interaction: "submit", confidence: "high", uncertainties: [] })
  ];
  const prompts = [];
  const mock = {
    async ask(prompt) {
      prompts.push(prompt);
      return responses.shift();
    }
  };
  const first = await new QwenPageSemanticAnalyzer(mock, "mock-qwen").analyze(pageRoot, {});
  assert.strictEqual(first.failures, 0);
  assert.strictEqual(first.cacheHits, 0);
  assert.strictEqual(prompts.length, 2);
  assert.match(prompts[0], /PAGE_CONTEXT_SENTINEL/);
  assert.match(prompts[0], /EVIDENCE_SENTINEL/);
  assert.doesNotMatch(prompts[0], /boundary-qwen-secret/);
  assert.match(prompts[0], /\[MASKED_SECRET\]/);
  assert.match(prompts[1], /EVIDENCE_SENTINEL/);
  assert.ok(await exists(first.pageSemanticsPath));
  assert.ok(await exists(first.interactionSemanticsPath));

  const cacheOnlyMock = { async ask() { throw new Error("cache miss unexpectedly called Qwen"); } };
  const second = await new QwenPageSemanticAnalyzer(cacheOnlyMock, "mock-qwen").analyze(pageRoot, {});
  assert.strictEqual(second.failures, 0);
  assert.strictEqual(second.cacheHits, 2);
}

async function testInvalidJsonDebugAndGracefulFailure() {
  const pageRoot = await createPageRoot("qwen-invalid", false);
  const mock = { async ask() { return "this is not JSON"; } };
  const result = await new QwenPageSemanticAnalyzer(mock, "mock-qwen").analyze(pageRoot, {});
  assert.strictEqual(result.failures, 1);
  const semantics = JSON.parse(await fs.readFile(result.pageSemanticsPath, "utf8"));
  assert.strictEqual(semantics.confidence, "low");
  assert.match(semantics.error, /parse edilemedi/i);
  const debugFiles = await fs.readdir(path.join(pageRoot, ".cache", "qwen", "debug"));
  assert.strictEqual(debugFiles.length, 1);
  assert.strictEqual(await fs.readFile(path.join(pageRoot, ".cache", "qwen", "debug", debugFiles[0]), "utf8"), "this is not JSON");
}

async function testClientFailureDoesNotCrashAnalyzer() {
  const pageRoot = await createPageRoot("qwen-client-failure", false);
  const mock = { async ask() { throw new Error("deterministic mock outage"); } };
  const result = await new QwenPageSemanticAnalyzer(mock, "mock-qwen").analyze(pageRoot, {});
  assert.strictEqual(result.failures, 1);
  const semantics = JSON.parse(await fs.readFile(result.pageSemanticsPath, "utf8"));
  assert.match(semantics.error, /deterministic mock outage/);
}

async function testVerifiedQwen3SemanticClientAndSanitation() {
  const pageRoot = await createPageRoot("qwen3-verified", true);
  const responses = [
    '<think>api_key=private-page-reasoning</think>\n```json\n{"page":"CustomerSearch","api_key":"raw-page-secret","confidence":"high","uncertainties":[]}\n```',
    '<think>private interaction reasoning</think>\n```json\n{"interaction":"submit","client_secret":"raw-interaction-secret","confidence":"high","uncertainties":[]}\n```'
  ];
  let calls = 0;
  const client = {
    provider: "qwen",
    async send() {
      const text = responses[calls++];
      return documentationResponse(text, "local/qwen3-32b", "qwen");
    }
  };
  const options = {
    client,
    cacheIdentity: "qwen3-32b@verified-fingerprint",
    expectedModelMarker: "qwen3"
  };
  const first = await new QwenPageSemanticAnalyzer(undefined, "qwen3-32b", undefined, options)
    .analyze(pageRoot, {}, token);
  assert.strictEqual(first.failures, 0);
  assert.strictEqual(calls, 2);
  const persisted = [
    await fs.readFile(first.pageSemanticsPath, "utf8"),
    await fs.readFile(first.interactionSemanticsPath, "utf8")
  ].join("\n");
  assert.doesNotMatch(persisted, /<think>|```|private-page-reasoning|raw-page-secret|raw-interaction-secret/i);
  assert.match(persisted, /\[MASKED_SECRET\]/);

  const cacheOnly = {
    provider: "qwen",
    async send() { throw new Error("verified cache unexpectedly missed"); }
  };
  const second = await new QwenPageSemanticAnalyzer(undefined, "qwen3-32b", undefined, {
    ...options,
    client: cacheOnly
  }).analyze(pageRoot, {}, token);
  assert.strictEqual(second.cacheHits, 2, "verified Qwen3 cache entries must remain reusable only under their pinned identity");
}

async function testApprovedBankingAliasAcceptedViaQwen3Family() {
  const pageRoot = await createPageRoot("qwen3-banking-family", false);
  const client = {
    provider: "qwen",
    async send() {
      return documentationResponse(
        '{"page":"CustomerSearch","confidence":"high","uncertainties":[]}',
        "ONIKS",
        "qwen",
        "qwen3"
      );
    }
  };
  const result = await new QwenPageSemanticAnalyzer(undefined, "ONIKS", undefined, {
    client,
    cacheIdentity: "ONIKS@approved-banking-qwen3",
    expectedModelMarker: "qwen3"
  }).analyze(pageRoot, {}, token);
  assert.strictEqual(result.failures, 0, "the approved banking alias must pass selected-page validation via response family=qwen3");
  assert.strictEqual(result.analyzedInteractions, 0);
}

async function testVerifiedQwen3SemanticTransientRetry() {
  const pageRoot = await createPageRoot("qwen3-semantic-retry", false);
  let calls = 0;
  const prompts = [];
  const client = {
    provider: "qwen",
    async send(prompt) {
      calls += 1;
      prompts.push(prompt);
      if (calls === 1) {
        throw new Error("Qwen bağlantısı kurulamadı. Endpoint çalışıyor mu kontrol edin.");
      }
      return documentationResponse(
        '{"page":"CustomerSearch","confidence":"high","uncertainties":[]}',
        "qwen3-32b",
        "qwen"
      );
    }
  };
  const result = await new QwenPageSemanticAnalyzer(undefined, "qwen3-32b", undefined, {
    client,
    cacheIdentity: "qwen3-32b@semantic-retry",
    expectedModelMarker: "qwen3",
    maxOutputTokens: 1536,
    maxGatewayRetries: 1,
    retryBaseDelayMs: 1
  }).analyze(pageRoot, {}, token);
  assert.strictEqual(result.failures, 0);
  assert.strictEqual(calls, 2, "normalized transient connection errors must be retried once");
  assert.ok(prompts.every((prompt) => prompt.maxOutputTokens === 1536));
}

async function testVerifiedQwen3SemanticOutageCircuitBreaker() {
  const pageRoot = await createPageRoot("qwen3-semantic-circuit", true);
  let calls = 0;
  const client = {
    provider: "qwen",
    async send() {
      calls += 1;
      throw new Error("Qwen HTTP hatası: 504 Gateway Time-out. Sunucu hata gövdesi güvenlik nedeniyle kaydedilmedi.");
    }
  };
  const result = await new QwenPageSemanticAnalyzer(undefined, "qwen3-32b", undefined, {
    client,
    cacheIdentity: "qwen3-32b@semantic-circuit",
    expectedModelMarker: "qwen3",
    maxGatewayRetries: 2,
    retryBaseDelayMs: 1
  }).analyze(pageRoot, {}, token);
  assert.strictEqual(calls, 3, "page probe must exhaust only its own bounded retry sequence");
  assert.strictEqual(result.failures, 1);
  assert.strictEqual(result.skippedInteractions, 1, "page-level transport failure must circuit-break interaction fan-out");
  assert.strictEqual(result.analyzedInteractions, 0);
}

async function testVerifiedQwen3SemanticBoundaryRejection() {
  const pageRoot = await createPageRoot("qwen3-wrong-model", false);
  const wrongModel = {
    provider: "qwen",
    async send() { return documentationResponse('{"page":"wrong"}', "notqwen3fake", "qwen"); }
  };
  await assert.rejects(
    () => new QwenPageSemanticAnalyzer(undefined, "qwen3", undefined, {
      client: wrongModel,
      cacheIdentity: "qwen3@wrong-model-test",
      expectedModelMarker: "qwen3"
    }).analyze(pageRoot, {}, token),
    (error) => error?.name === "Qwen3PageSemanticBoundaryError" && /unexpected model/i.test(error.message)
  );

  const unattestedBankAlias = {
    provider: "qwen",
    async send() { return documentationResponse('{"page":"wrong"}', "ONIKS", "qwen"); }
  };
  await assert.rejects(
    () => new QwenPageSemanticAnalyzer(undefined, "ONIKS", undefined, {
      client: unattestedBankAlias,
      cacheIdentity: "ONIKS@non-banking",
      expectedModelMarker: "qwen3"
    }).analyze(pageRoot, {}, token),
    (error) => error?.name === "Qwen3PageSemanticBoundaryError" && /unexpected model/i.test(error.message),
    "ONIKS without a trusted response family=qwen3 attestation must remain rejected"
  );

  let sends = 0;
  const wrongProvider = {
    provider: "copilot",
    async send() { sends += 1; throw new Error("must not send"); }
  };
  await assert.rejects(
    () => new QwenPageSemanticAnalyzer(undefined, "qwen3", undefined, {
      client: wrongProvider,
      cacheIdentity: "qwen3@wrong-provider-test"
    }).analyze(pageRoot, {}, token),
    /provider=qwen/i
  );
  assert.strictEqual(sends, 0);
}

async function testVerifiedQwen3DebugSanitation() {
  const pageRoot = await createPageRoot("qwen3-debug-sanitized", false);
  const client = {
    provider: "qwen",
    async send() {
      return documentationResponse(
        "<think>private semantic reasoning</think>\nnot-json api_key=raw-debug-secret",
        "qwen3-32b",
        "qwen"
      );
    }
  };
  const result = await new QwenPageSemanticAnalyzer(undefined, "qwen3-32b", undefined, {
    client,
    cacheIdentity: "qwen3-32b@debug-test"
  }).analyze(pageRoot, {}, token);
  assert.strictEqual(result.failures, 1);
  const debugRoot = path.join(pageRoot, ".cache", "qwen", "debug");
  const debugFiles = await fs.readdir(debugRoot);
  const debug = await fs.readFile(path.join(debugRoot, debugFiles[0]), "utf8");
  assert.doesNotMatch(debug, /<think>|private semantic reasoning|raw-debug-secret/i);
  assert.match(debug, /\[MASKED_SECRET\]/);
}

function documentationResponse(text, modelId, provider, family = modelId) {
  return {
    text,
    usage: {
      inputCharacters: 100,
      outputCharacters: text.length,
      estimatedInputTokens: 25,
      estimatedOutputTokens: 25,
      estimatedTotalTokens: 50
    },
    model: {
      id: modelId,
      name: modelId,
      vendor: provider,
      family,
      version: "test",
      maxInputTokens: 131072
    },
    provider
  };
}

async function createPageRoot(prefix, includeInteraction) {
  const pageRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), "# Selected Page\nPAGE_CONTEXT_SENTINEL\nRoute: /customers/search\napi_key=boundary-qwen-secret", "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), "# Source Evidence\nEVIDENCE_SENTINEL\nPOST /api/customers/search", "utf8");
  await fs.writeFile(path.join(pageRoot, "page-flow.json"), JSON.stringify({
    projectName: "boundary-project",
    branch: "test",
    selectedPage: { pageName: "CustomerSearch", route: "/customers/search" },
    interactions: includeInteraction ? [{ event: "submit", handler: "handleSearch" }] : [],
    uiApiCalls: includeInteraction ? [{ method: "POST", path: "/api/customers/search" }] : [],
    uiToBffMatches: [{ confidence: "high" }],
    bffToBeMatches: [{ confidence: "high" }]
  }, null, 2), "utf8");
  return pageRoot;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
