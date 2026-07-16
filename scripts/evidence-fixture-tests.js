const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { sourceContextFromFiles } = require("../dist/docs/focusedSourceContext");
const { buildPageEvidenceSnippets } = require("../dist/evidence/sourceSnippetExtractors");
const { selectPageEvidenceFiles } = require("../dist/evidence/pageEvidenceSelector");

const root = path.resolve(__dirname, "..");

async function main() {
  const expected = JSON.parse(await fs.readFile(path.join(root, "test-fixtures", "expected", "evidence", "selected-page.json"), "utf8"));
  const manifest = {
    projectName: "fixture-customer-flow",
    branch: "fixture",
    repos: {
      ui: { localPath: path.join(root, "test-fixtures", "react") },
      bff: { localPath: path.join(root, "test-fixtures", "java-spring") },
      be: { localPath: path.join(root, "test-fixtures", "java-spring") }
    }
  };
  const pageFlow = fixturePageFlow();
  const result = await buildPageEvidenceSnippets(manifest, pageFlow, expected.maxSnippetCharacters);
  const groups = new Set(result.snippets.map((item) => item.group));
  expected.requiredGroups.forEach((group) => assert.ok(groups.has(group), `Missing evidence group: ${group}`));
  expected.requiredSymbols.forEach((symbol) => assert.ok(result.snippets.some((item) => item.symbolName.includes(symbol)), `Missing evidence symbol: ${symbol}`));
  result.snippets.forEach((item) => assert.ok(item.code.length <= expected.maxSnippetCharacters + 25, `Snippet exceeded bound: ${item.symbolName}`));

  const selections = selectPageEvidenceFiles(manifest, pageFlow);
  const uiFiles = selections.find((item) => item.role === "ui").files;
  const beFiles = selections.find((item) => item.role === "be").files;
  assert.ok(uiFiles.includes("pages/CustomerSearchPage.tsx"));
  assert.ok(uiFiles.includes("api-clients/customerApi.ts"));
  assert.ok(beFiles.includes("service-repository/CustomerRepository.java"));
  assert.ok(beFiles.length <= 8, `BE evidence selection is unexpectedly broad: ${beFiles.length}`);

  testTraceabilityFilesStayInTheirOwnRepoRole(manifest, pageFlow);
  await testBroadFallbackSharesBudgetAcrossFiles();

  await writeReport(`# Evidence Fixture Report\n\nGenerated: ${new Date().toISOString()}\n\n## Exact Evidence Coverage\n\n${[...groups].map((group) => `- ${group}: ${result.snippets.filter((item) => item.group === group).length}`).join("\n")}\n\n## Relevance and Bounds\n\n- Total exact snippets: ${result.snippets.length}\n- Maximum configured characters per snippet: ${expected.maxSnippetCharacters}\n- UI selected files: ${uiFiles.length}\n- BE selected files: ${beFiles.length}\n- Uncertainty notes: ${result.uncertainties.length}\n\nExact React handler/API windows and Java controller/service/outbound/repository/entity blocks were found. Selection remained bounded.\n\n## Known Limits\n\nRegex extraction may lose deeply nested syntax and object-property React API function declarations. In those cases the existing bounded API-call window and uncertainty mechanism remain the fallback.\n\nResult: PASS.\n`);
  console.log("Evidence fixture tests passed.");
}

function testTraceabilityFilesStayInTheirOwnRepoRole(manifest, pageFlow) {
  const selections = selectPageEvidenceFiles(manifest, {
    ...pageFlow,
    bffToBeMatches: [{
      bffFile: "trace-only/CustomerRiskClient.java",
      clientFile: "trace-only/CustomerRiskFallbackClient.java",
      beFile: "trace-only/CustomerRiskController.java",
      targetFile: "trace-only/CustomerRiskTargetController.java",
      confidence: "high"
    }]
  });
  const bffFiles = selections.find((item) => item.role === "bff").files;
  const beFiles = selections.find((item) => item.role === "be").files;

  assert.strictEqual(bffFiles[0], "trace-only/CustomerRiskClient.java", "Direct Feign trace evidence should have BFF priority.");
  assert.ok(bffFiles.includes("trace-only/CustomerRiskFallbackClient.java"));
  assert.ok(!bffFiles.includes("trace-only/CustomerRiskController.java"), "BE trace files must not leak into the BFF repository selection.");
  assert.ok(beFiles.includes("trace-only/CustomerRiskController.java"));
  assert.ok(beFiles.includes("trace-only/CustomerRiskTargetController.java"));
  assert.ok(!beFiles.includes("trace-only/CustomerRiskClient.java"), "BFF trace files must not leak into the BE repository selection.");
}

async function testBroadFallbackSharesBudgetAcrossFiles() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bank-evidence-budget-"));
  const first = "src/main/java/app/FirstController.java";
  const feign = "src/main/java/app/RiskFeignClient.java";
  try {
    await writeRepoFile(repo, first, `public class FirstController {\n${"  // first controller evidence\n".repeat(120)}}`);
    await writeRepoFile(repo, feign, `@FeignClient(name = "risk")\npublic interface RiskFeignClient {\n${"  // feign outbound evidence\n".repeat(120)}}`);

    const result = await sourceContextFromFiles(repo, [first, feign], 2400, 1200);
    assert.deepStrictEqual(result.files, [first, feign], "A large first file must not starve later Feign evidence.");
    assert.match(result.content, /### src\/main\/java\/app\/FirstController\.java/);
    assert.match(result.content, /### src\/main\/java\/app\/RiskFeignClient\.java/);
    assert.ok(result.content.length <= 1200, `Broad fallback exceeded its total budget: ${result.content.length}`);

    const tinyFiles = ["A.java", "B.java", "C.java", "D.java"];
    for (const file of tinyFiles) {
      await writeRepoFile(repo, file, `class ${path.basename(file, ".java")} {}`);
    }
    const tinyResult = await sourceContextFromFiles(repo, tinyFiles, 2400, 1200);
    assert.deepStrictEqual(
      tinyResult.files,
      tinyFiles,
      "actual small file sizes must allow more candidates than a fixed file-count estimate"
    );
    assert.ok(tinyResult.content.length <= 1200);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

async function writeRepoFile(repo, relativeFile, content) {
  const file = path.join(repo, relativeFile);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

function fixturePageFlow() {
  return {
    selectedPage: { pageName: "CustomerSearchPage", route: "/customers/search", file: "pages/CustomerSearchPage.tsx" },
    routes: [{ route: "/customers/search", pageComponent: "CustomerSearchPage", file: "routes/AppRoutes.tsx", confidence: "high" }],
    components: [{ component: "CustomerSearchPage", file: "pages/CustomerSearchPage.tsx", confidence: "high" }],
    interactions: [{ component: "CustomerSearchPage", event: "onSubmit", handler: "submitSearch", file: "pages/CustomerSearchPage.tsx", confidence: "high" }],
    formFields: [{ fieldName: "customerName", file: "pages/CustomerSearchPage.tsx" }],
    states: [{ stateName: "status", file: "pages/CustomerSearchPage.tsx" }],
    uiApiCalls: [{ httpMethod: "GET", path: "/api/customers/search", file: "api-clients/customerApi.ts", confidence: "high" }],
    bffEndpoints: [{ className: "CustomerSearchController", handlerMethod: "searchCustomers", httpMethod: "GET", path: "/api/customers/search", file: "controllers/CustomerSearchController.java", confidence: "high" }],
    bffComponents: [{ className: "CustomerRiskClient", type: "client", file: "bff-outbound/CustomerRiskClient.java" }],
    bffServiceFlows: [{ endpoint: "GET /api/customers/search", handler: "searchCustomers", candidateClients: ["CustomerRiskClient"], outboundCalls: ["GET /api/risk/customers/{customerId} via CustomerRiskClient.checkRisk"], confidence: "high" }],
    beEndpoints: [{ className: "CustomerSearchController", handlerMethod: "getCustomer", httpMethod: "GET", path: "/api/customers/{customerId}", file: "controllers/CustomerSearchController.java", confidence: "high" }],
    beComponents: [{ className: "CustomerService", type: "service", file: "service-repository/CustomerService.java" }],
    beServiceFlows: [{ endpoint: "GET /api/customers/{customerId}", handler: "getCustomer", candidateServices: ["CustomerService"], candidateRepositories: ["CustomerRepository"], repositoryMethods: ["CustomerRepository.searchByName"], entities: ["Customer"], methodCalls: ["CustomerSearchController.getCustomer -> CustomerService.getCustomer"], confidence: "high" }],
    repositories: [{ repository: "CustomerRepository", method: "searchByName", entity: "Customer", file: "service-repository/CustomerRepository.java", confidence: "high" }],
    entities: [{ entity: "Customer", file: "dto-entity/Customer.java", confidence: "high" }]
  };
}

async function writeReport(content) {
  if (process.env.BANK_SPRING_DOCS_WRITE_TEST_REPORTS === "0") return;
  const file = path.join(root, ".ai-docs", "dev-audits", "evidence-fixture-report.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

main().catch((error) => { console.error(error); process.exit(1); });
