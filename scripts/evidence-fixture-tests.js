const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
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

  await writeReport(`# Evidence Fixture Report\n\nGenerated: ${new Date().toISOString()}\n\n## Exact Evidence Coverage\n\n${[...groups].map((group) => `- ${group}: ${result.snippets.filter((item) => item.group === group).length}`).join("\n")}\n\n## Relevance and Bounds\n\n- Total exact snippets: ${result.snippets.length}\n- Maximum configured characters per snippet: ${expected.maxSnippetCharacters}\n- UI selected files: ${uiFiles.length}\n- BE selected files: ${beFiles.length}\n- Uncertainty notes: ${result.uncertainties.length}\n\nExact React handler/API windows and Java controller/service/outbound/repository/entity blocks were found. Selection remained bounded.\n\n## Known Limits\n\nRegex extraction may lose deeply nested syntax and object-property React API function declarations. In those cases the existing bounded API-call window and uncertainty mechanism remain the fallback.\n\nResult: PASS.\n`);
  console.log("Evidence fixture tests passed.");
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
  const file = path.join(root, ".ai-docs", "dev-audits", "evidence-fixture-report.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

main().catch((error) => { console.error(error); process.exit(1); });
