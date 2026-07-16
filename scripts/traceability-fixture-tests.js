const assert = require("assert");
const fs = require("fs/promises");
const Module = require("module");
const os = require("os");
const path = require("path");
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "vscode") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeHttpPath } = require("../dist/analyzer/traceability/pathNormalizer");
const { UiToBffMatcher } = require("../dist/analyzer/traceability/uiToBffMatcher");
const { BffToBeMatcher } = require("../dist/analyzer/traceability/bffToBeMatcher");
const { UnresolvedMatchReporter } = require("../dist/analyzer/traceability/unresolvedMatchReporter");
const { BffOutboundCallExtractor } = require("../dist/analyzer/bff/bffOutboundCallExtractor");
const { BffFlowIndexBuilder } = require("../dist/analyzer/bff/bffFlowIndexBuilder");
const { JavaMethodCallExtractor } = require("../dist/analyzer/be/javaMethodCallExtractor");
const { PageFlowBuilder } = require("../dist/analyzer/traceability/pageFlowBuilder");
const { MultiRepoTraceabilityService } = require("../dist/multirepo/multiRepoTraceabilityService");

const root = path.resolve(__dirname, "..");

async function main() {
  const fixture = await json("test-fixtures/traceability/ui-bff-be/flow.json");
  const expected = await json("test-fixtures/expected/traceability/matches.json");
  const variants = ["/customers/:id", "/customers/{id}", "/customers/${id}", "/customers/{customerId}"];
  assert.deepStrictEqual([...new Set(variants.map(normalizeHttpPath))], [expected.normalizedPaths[0]]);
  assert.strictEqual(normalizeHttpPath("api/customers/search"), expected.normalizedPaths[1]);

  const uiToBff = new UiToBffMatcher().match(fixture.uiApiCalls, fixture.bffEndpoints);
  const bffToBe = new BffToBeMatcher().match(fixture.bffEndpoints, fixture.beEndpoints, fixture.outboundCalls);
  expected.uiToBff.forEach((record) => assert.ok(uiToBff.some((actual) => subset(actual, record)), `Missing UI-BFF match ${JSON.stringify(record)}`));
  expected.bffToBe.forEach((record) => assert.ok(bffToBe.some((actual) => subset(actual, record)), `Missing BFF-BE match ${JSON.stringify(record)}`));
  const unresolved = new UnresolvedMatchReporter().build(uiToBff, bffToBe);
  assert.strictEqual(unresolved.length, expected.unresolvedCount);
  assert.ok(unresolved.some((item) => /ambiguous/i.test(item.reason)));
  assert.ok(unresolved.some((item) => /No BFF endpoint/i.test(item.reason)));
  assert.ok(unresolved.some((item) => /No BE endpoint/i.test(item.reason)));

  testRestClientOutboundFlowAndTargetMatching();
  testPageFlowBeEvidenceEnrichment();
  await testTraceabilityServiceLoadsAndValidatesBeEvidence();

  await report(`# Traceability Fixture Report\n\nGenerated: ${new Date().toISOString()}\n\n## Coverage\n\n- Exact UI to BFF matches: ${uiToBff.filter((item) => item.confidence === "high").length}\n- Ambiguous path-variable matches: ${uiToBff.filter((item) => item.confidence === "low").length}\n- Unmatched UI calls: ${uiToBff.filter((item) => item.confidence === "unmatched").length}\n- BFF outbound to BE records: ${bffToBe.length}\n- Unresolved records: ${unresolved.length}\n\nPath variables in colon, Spring brace, template literal, and named-brace forms normalize to \`/customers/{param}\`. Missing leading slashes normalize safely. Ambiguous and unmatched records remain explicit.\n\nResult: PASS.\n`);
  console.log("Traceability fixture tests passed.");
}

function testPageFlowBeEvidenceEnrichment() {
  const uiToBff = [{
    uiPage: "ReleasePage",
    uiClientFunction: "createRelease",
    uiApiCall: "POST /api/releases",
    uiApiFile: "src/api/releases.ts",
    bffEndpoint: "POST /api/releases",
    bffController: "ReleaseBffController",
    bffHandler: "create",
    confidence: "high",
    matchReason: "exact"
  }];
  const bffToBe = [{
    bffEndpoint: "POST /api/releases",
    bffController: "ReleaseBffController",
    bffHandler: "create",
    beEndpoint: "POST /internal/releases/{param}",
    beController: "ReleaseController",
    beHandler: "create",
    confidence: "high",
    matchReason: "outbound exact"
  }];
  const interactions = [
    { page: "ReleasePage", component: "ReleasePage", label: "Re-simulate risk", handler: "simulateRisk", file: "src/pages/ReleasePage.tsx" },
    { page: "OtherReleasePage", component: "OtherReleasePage", label: "Create release", handler: "createRelease", file: "src/pages/OtherReleasePage.tsx" },
    { component: "ReleaseWizard", label: "Save draft", handler: "onSave", file: "src/components/ReleaseWizard.tsx" }
  ];
  const routes = [{ route: "/releases/new", pageComponent: "ReleasePage" }];
  const serviceFlows = [{
    endpoint: "post /internal/releases/{releaseId}",
    controller: "ReleaseController",
    handler: "create",
    candidateServices: ["ReleaseService"],
    candidateRepositories: ["ReleaseRepository"],
    entities: ["ReleaseOrder"],
    repositoryMethods: ["ReleaseRepository.save"],
    methodCalls: [
      "ReleaseController.create -> ReleaseService.create",
      "ReleaseService.create -> ReleaseRepository.save",
      "UnrelatedService.maintenance -> OtherRepository.deleteAll"
    ],
    confidence: "high"
  }];
  const entities = [{ entity: "ReleaseOrder", table: "release_order" }];

  const enriched = new PageFlowBuilder().build(uiToBff, bffToBe, interactions, routes, serviceFlows, entities)[0];
  assert.deepStrictEqual(enriched.beFlow, ["ReleaseController.create", "ReleaseService.create", "ReleaseRepository.save"]);
  assert.deepStrictEqual(enriched.entities, ["ReleaseOrder"]);
  assert.deepStrictEqual(enriched.tables, ["release_order"]);
  assert.strictEqual(enriched.interaction, "Save draft", "interaction matching must use API action evidence, not the first interaction on the page");
  assert.strictEqual(enriched.uiHandler, "onSave");
  assert.strictEqual(enriched.confidence, "high");
  assert.deepStrictEqual(enriched.uncertainties, []);

  const automaticRead = new PageFlowBuilder().build(
    [{ ...uiToBff[0], uiClientFunction: "getRelease", uiApiCall: "GET /api/releases/{param}", bffEndpoint: "GET /api/releases/{param}" }],
    [{ ...bffToBe[0], bffEndpoint: "GET /api/releases/{param}", beEndpoint: "GET /internal/releases/{param}", beHandler: "get" }],
    interactions,
    routes
  )[0];
  assert.strictEqual(automaticRead.interaction, undefined, "an unrelated same-page interaction must not be attached to an automatic GET load");
  assert.strictEqual(automaticRead.confidence, "high", "automatic GET loads do not require a click/submit interaction");
  assert.deepStrictEqual(automaticRead.uncertainties, []);

  const missingEvidence = new PageFlowBuilder().build(uiToBff, bffToBe, interactions, routes, [], [])[0];
  assert.strictEqual(missingEvidence.confidence, "partial");
  assert.ok(missingEvidence.uncertainties.some((item) => /service-flow evidence is missing/i.test(item)));
}

async function testTraceabilityServiceLoadsAndValidatesBeEvidence() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-trace-be-evidence-"));
  const manifest = {
    schemaVersion: 3,
    pipelineIdentity: "b".repeat(64),
    projectName: "Traceability Fixture",
    branch: "main",
    repos: {
      ui: { type: "react", url: "https://example.test/ui.git", localPath: path.join(multiRepoRoot, "repos", "ui"), status: "analyzed" },
      bff: { type: "spring-bff", url: "https://example.test/bff.git", localPath: path.join(multiRepoRoot, "repos", "bff"), status: "analyzed" },
      be: { type: "spring-be", url: "https://example.test/be.git", localPath: path.join(multiRepoRoot, "repos", "be"), status: "analyzed" }
    },
    updatedAt: "2026-07-16T00:00:00.000Z"
  };

  try {
    for (const role of ["ui", "bff", "be"]) {
      await writeJsonlFile(path.join(multiRepoRoot, role, "manifest.json"), [{
        repositoryUrl: manifest.repos[role].url,
        branch: manifest.branch,
        pipelineIdentity: manifest.pipelineIdentity
      }], true);
    }
    await writeJsonlFile(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), [
      { clientFunction: "createRelease", httpMethod: "POST", path: "/api/releases", file: "src/api/releases.ts", usedBy: ["ReleasePage"] }
    ]);
    await writeJsonlFile(path.join(multiRepoRoot, "ui", "interaction-index.jsonl"), [
      { page: "ReleasePage", component: "ReleasePage", label: "Create", handler: "createRelease", file: "src/pages/ReleasePage.tsx" }
    ]);
    await writeJsonlFile(path.join(multiRepoRoot, "ui", "route-index.jsonl"), [
      { route: "/releases/new", pageComponent: "ReleasePage" }
    ]);
    await writeJsonlFile(path.join(multiRepoRoot, "bff", "api-endpoints.jsonl"), [
      { httpMethod: "POST", path: "/api/releases", className: "ReleaseBffController", handlerMethod: "create", file: "ReleaseBffController.java" }
    ]);
    await writeJsonlFile(path.join(multiRepoRoot, "bff", "outbound-calls.jsonl"), [{
      client: "ReleaseClient",
      method: "create",
      httpMethod: "POST",
      targetPath: "/internal/releases/{releaseId}",
      sourceEndpoint: "POST /api/releases",
      sourceController: "ReleaseBffController",
      sourceHandler: "create",
      file: "ReleaseClient.java"
    }]);
    await writeJsonlFile(path.join(multiRepoRoot, "be", "api-endpoints.jsonl"), [
      { httpMethod: "POST", path: "/internal/releases/{id}", className: "ReleaseController", handlerMethod: "create", file: "ReleaseController.java" }
    ]);
    await writeJsonlFile(path.join(multiRepoRoot, "be", "service-flow-index.jsonl"), [{
      endpoint: "POST /internal/releases/{releaseId}",
      controller: "ReleaseController",
      handler: "create",
      candidateServices: ["ReleaseService"],
      candidateRepositories: ["ReleaseRepository"],
      entities: ["ReleaseOrder"],
      repositoryMethods: ["ReleaseRepository.save"],
      methodCalls: ["ReleaseController.create -> ReleaseService.create", "ReleaseService.create -> ReleaseRepository.save"],
      confidence: "high"
    }]);
    await writeJsonlFile(path.join(multiRepoRoot, "be", "entity-index.jsonl"), [
      { entity: "ReleaseOrder", table: "release_order", fields: [], relationships: [], file: "ReleaseOrder.java" }
    ]);

    await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);
    const pageFlows = await readJsonlFile(path.join(multiRepoRoot, "traceability", "page-flows.jsonl"));
    assert.deepStrictEqual(pageFlows[0].beFlow, ["ReleaseController.create", "ReleaseService.create", "ReleaseRepository.save"]);
    assert.deepStrictEqual(pageFlows[0].tables, ["release_order"]);

    await writeJsonlFile(path.join(multiRepoRoot, "be", "service-flow-index.jsonl"), [{ endpoint: "POST /internal/releases/{id}" }]);
    await assert.rejects(
      new MultiRepoTraceabilityService().build(multiRepoRoot, manifest),
      (error) => error && error.code === "JSONL_INVALID_RECORD"
    );
  } finally {
    if (path.dirname(multiRepoRoot) === path.resolve(os.tmpdir())) {
      await fs.rm(multiRepoRoot, { recursive: true, force: true });
    }
  }
}

function testRestClientOutboundFlowAndTargetMatching() {
  const files = [
    javaFile("TransferController.java", "controller", `
      @RestController
      @RequestMapping("/api/transfers")
      public class TransferController {
        private final TransferService transferService;
        public TransferController(TransferService transferService) { this.transferService = transferService; }

        @GetMapping("/{id}")
        public TransferResponse get(String id) { return transferService.get(id); }

        @PostMapping
        public TransferResponse create(CreateTransferRequest request, String actor) { return transferService.create(request, actor); }

        @DeleteMapping("/{id}")
        public void cancel(String id, String actor) { transferService.cancel(id, actor); }
      }
    `),
    javaFile("TransferService.java", "service", `
      @Service
      public class TransferService {
        private final LedgerClient ledgerClient;
        public TransferService(LedgerClient ledgerClient) { this.ledgerClient = ledgerClient; }
        public TransferResponse get(String id) { return ledgerClient.get(id); }
        public TransferResponse create(CreateTransferRequest request, String actor) { return ledgerClient.create(request, actor); }
        public void cancel(String id, String actor) { ledgerClient.cancel(id, actor); }
      }
    `),
    javaFile("LedgerClient.java", "client", `
      @Component
      public class LedgerClient {
        private final RestClient ledgerRestClient;
        public LedgerClient(RestClient ledgerRestClient) { this.ledgerRestClient = ledgerRestClient; }

        public TransferResponse get(String id) {
          return ledgerRestClient.get()
            .uri(builder -> builder.path("/internal/transfers/{transferId}").queryParam("view", "full").build(id))
            .header("X-Channel", "WEB")
            .retrieve()
            .body(TransferResponse.class);
        }

        public TransferResponse create(CreateTransferRequest request, String actor) {
          return ledgerRestClient.post()
            .uri(builder -> builder.path("/internal/transfers").pathSegment("{transferId}").build(request.id()))
            .header("X-Actor", actor)
            .contentType(MediaType.APPLICATION_JSON)
            .body(request)
            .retrieve()
            .body(TransferResponse.class);
        }

        public void cancel(String id, String actor) {
          ledgerRestClient.method(HttpMethod.DELETE)
            .uri("/internal/transfers/{transferId}", id)
            .headers(values -> values.set("X-Actor", actor))
            .retrieve()
            .toBodilessEntity();
        }
      }
    `)
  ];

  const outbound = new BffOutboundCallExtractor().extract(files);
  assert.strictEqual(outbound.length, 3, "GET, POST, and method(DELETE) RestClient chains must be indexed");
  const get = outbound.find((call) => call.httpMethod === "GET");
  const post = outbound.find((call) => call.httpMethod === "POST");
  const remove = outbound.find((call) => call.httpMethod === "DELETE");
  assert.ok(get && post && remove);
  assert.strictEqual(get.targetPath, "/internal/transfers/{transferId}");
  assert.deepStrictEqual(get.headers, ["X-Channel"]);
  assert.strictEqual(post.targetPath, "/internal/transfers/{transferId}");
  assert.deepStrictEqual(post.headers, ["X-Actor", "Content-Type"]);
  assert.strictEqual(post.bodyExpression, "request", "response body decoding after retrieve must not be classified as a request body");
  assert.strictEqual(remove.targetPath, "/internal/transfers/{transferId}");
  assert.deepStrictEqual(remove.headers, ["X-Actor"]);

  const endpoints = [
    endpoint("GET", "/api/transfers/{id}", "get"),
    endpoint("POST", "/api/transfers", "create"),
    endpoint("DELETE", "/api/transfers/{id}", "cancel")
  ];
  const components = [
    component("controller", "TransferController"),
    component("service", "TransferService"),
    component("client", "LedgerClient")
  ];
  const methodCalls = new JavaMethodCallExtractor().extract(files);
  const flows = new BffFlowIndexBuilder().build(endpoints, components, outbound, methodCalls);
  const createFlow = flows.find((flow) => flow.handler === "create");
  assert.ok(createFlow);
  assert.deepStrictEqual(createFlow.candidateServices, ["TransferService"]);
  assert.deepStrictEqual(createFlow.candidateClients, ["LedgerClient"]);
  assert.deepStrictEqual(createFlow.outboundCalls, ["POST /internal/transfers/{transferId} via LedgerClient.create"]);
  assert.ok(createFlow.methodCalls.includes("TransferController.create -> TransferService.create"));
  assert.ok(createFlow.methodCalls.includes("TransferService.create -> LedgerClient.create"));
  assert.strictEqual(createFlow.confidence, "high");
  assert.strictEqual(post.sourceEndpoint, "POST /api/transfers");
  assert.strictEqual(post.sourceController, "TransferController");
  assert.strictEqual(post.sourceHandler, "create");
  assert.strictEqual(remove.sourceEndpoint, "DELETE /api/transfers/{id}");

  const beEndpoints = [
    { httpMethod: "POST", path: "/api/transfers", className: "PublicShapeDecoyController", handlerMethod: "wrong", file: "Decoy.java" },
    { httpMethod: "POST", path: "/internal/transfers/{id}", className: "LedgerController", handlerMethod: "create", file: "LedgerController.java" }
  ];
  const matched = new BffToBeMatcher().match(endpoints, beEndpoints, [post]);
  assert.strictEqual(matched[0].beController, "LedgerController", "BE matching must follow the extracted outbound target, not the public BFF path");
  assert.strictEqual(matched[0].bffController, "TransferController");
  assert.strictEqual(matched[0].bffFile, post.file, "traceability must retain the outbound/Feign source file for evidence selection");
  assert.strictEqual(matched[0].beFile, "LedgerController.java", "traceability must retain the matched BE endpoint file for evidence selection");
  assert.strictEqual(matched[0].confidence, "high");

  const ambiguous = new BffToBeMatcher().match(endpoints, [
    beEndpoints[1],
    { ...beEndpoints[1], className: "SecondLedgerController", file: "SecondLedgerController.java" }
  ], [post]);
  assert.strictEqual(ambiguous[0].confidence, "low");
  assert.strictEqual(ambiguous[0].beFile, undefined, "ambiguous BE matches must not prioritize an arbitrary controller file");

  const deleteMatched = new BffToBeMatcher().match(endpoints, [
    { httpMethod: "DELETE", path: "/internal/transfers/{id}", className: "LedgerController", handlerMethod: "cancel", file: "LedgerController.java" }
  ], [remove]);
  assert.strictEqual(deleteMatched[0].bffEndpoint, "DELETE /api/transfers/{param}", "the public source endpoint must normalize exactly like UI-to-BFF output for PageFlowBuilder joins");

  const noOutboundEvidence = new BffToBeMatcher().match([endpoints[1]], [beEndpoints[0]], []);
  assert.strictEqual(noOutboundEvidence[0].confidence, "unmatched");
  assert.match(noOutboundEvidence[0].matchReason, /public BFF endpoint paths are not used/i);
}

function javaFile(file, classification, content) {
  return { file, absolutePath: file, extension: ".java", kind: "java", classification, size: content.length, content };
}

function endpoint(httpMethod, pathValue, handlerMethod) {
  return { httpMethod, path: pathValue, className: "TransferController", handlerMethod, parameters: [], pathVariables: [], requestParams: [], file: "TransferController.java" };
}

function component(type, className) {
  return { type, className, packageName: "fixture", file: `${className}.java`, annotations: [], constructorDependencies: [], fieldInjectedDependencies: [], implementedInterfaces: [] };
}

function subset(actual, expected) { return Object.entries(expected).every(([key, value]) => actual[key] === value); }
async function json(relative) { return JSON.parse(await fs.readFile(path.join(root, relative), "utf8")); }
async function writeJsonlFile(file, records, singleJson = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = singleJson
    ? `${JSON.stringify(records[0], null, 2)}\n`
    : records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  await fs.writeFile(file, content, "utf8");
}
async function readJsonlFile(file) {
  return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
async function report(content) { if (process.env.BANK_SPRING_DOCS_WRITE_TEST_REPORTS === "0") return; const file = path.join(root, ".ai-docs", "dev-audits", "traceability-fixture-report.md"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, "utf8"); }
main().catch((error) => { console.error(error); process.exit(1); });
