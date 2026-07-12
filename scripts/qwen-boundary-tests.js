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

async function main() {
  testPromptBuilders();
  testStrictJsonParsing();
  testContextBudgetAndSecretMasking();
  await testPageContextEvidenceCacheAndArtifacts();
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
