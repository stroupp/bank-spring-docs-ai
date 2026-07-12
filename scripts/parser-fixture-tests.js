const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");

const { ParserProviderRegistry } = require("../dist/parser/parserProviderRegistry");
const { collectParserProviderDiagnostics } = require("../dist/parser/parserProviderDiagnostics");
const { RegexJavaParserProvider } = require("../dist/parser/java/regexJavaParserProvider");
const { RegexReactParserProvider } = require("../dist/parser/react/regexReactParserProvider");

const root = path.resolve(__dirname, "..");

async function main() {
  const java = new RegexJavaParserProvider();
  const react = new RegexReactParserProvider();
  const registry = new ParserProviderRegistry();
  registry.register(java);
  registry.register(react);
  assert.strictEqual(registry.list().length, 2);
  assert.strictEqual(registry.get("java", "regex-java"), java);

  const javaActual = await parseJava(java);
  const reactActual = await parseReact(react);
  const javaExpected = await readJson("test-fixtures/expected/java/regex-java.json");
  const reactExpected = await readJson("test-fixtures/expected/react/regex-react.json");
  assertExpectedRecords(javaActual, javaExpected, ["endpoints", "models", "serviceCalls", "repositoryMethods"]);
  assertExpectedRecords(reactActual, reactExpected, ["routes", "components", "interactions", "apiCalls", "formFields", "stateUsage"]);

  const diagnostics = collectParserProviderDiagnostics(registry.list());
  assert.strictEqual(diagnostics.providers.length, 2);
  assert.ok(diagnostics.warningCount > 0);
  await writeReport("parser-comparison-report.md", parserReport(javaActual, javaExpected, reactActual, reactExpected, diagnostics));
  await writeReport("fixture-test-report.md", fixtureReport(javaActual, reactActual));
  console.log("Parser fixture tests passed.");
}

async function parseJava(provider) {
  const controller = await source("test-fixtures/java-spring/controllers/CustomerSearchController.java");
  const entity = await source("test-fixtures/java-spring/dto-entity/Customer.java");
  const dto = await source("test-fixtures/java-spring/dto-entity/CustomerSearchRequest.java");
  const service = await source("test-fixtures/java-spring/service-repository/CustomerService.java");
  const repository = await source("test-fixtures/java-spring/service-repository/CustomerRepository.java");
  return {
    endpoints: provider.parseControllerEndpoints(controller.file, controller.text),
    models: [...provider.parseDtoOrEntity(entity.file, entity.text), ...provider.parseDtoOrEntity(dto.file, dto.text)],
    serviceCalls: provider.parseServiceMethods(service.file, service.text),
    repositoryMethods: provider.parseRepositoryMethods(repository.file, repository.text)
  };
}

async function parseReact(provider) {
  const routes = await source("test-fixtures/react/routes/AppRoutes.tsx");
  const page = await source("test-fixtures/react/pages/CustomerSearchPage.tsx");
  const api = await source("test-fixtures/react/api-clients/customerApi.ts");
  return {
    routes: provider.parseRoutes(routes.file, routes.text),
    components: provider.parseComponents(page.file, page.text),
    interactions: provider.parseInteractions(page.file, page.text),
    apiCalls: provider.parseApiCalls(api.file, api.text),
    formFields: provider.parseFormFields(page.file, page.text),
    stateUsage: provider.parseStateUsage(page.file, page.text)
  };
}

function assertExpectedRecords(actual, expected, keys) {
  for (const key of keys) {
    for (const expectedRecord of expected[key]) {
      assert.ok(actual[key].some((record) => isSubset(record, expectedRecord)), `Missing ${key} record: ${JSON.stringify(expectedRecord)}\nActual: ${JSON.stringify(actual[key], null, 2)}`);
    }
  }
}

function isSubset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => isSubset(actual[index], item));
  if (expected && typeof expected === "object") return actual && Object.entries(expected).every(([key, value]) => isSubset(actual[key], value));
  return actual === expected;
}

function parserReport(javaActual, javaExpected, reactActual, reactExpected, diagnostics) {
  return `# Parser Comparison Report\n\nGenerated: ${new Date().toISOString()}\n\n## Providers\n\n${diagnostics.providers.map((item) => `- ${item.name} ${item.version} (${item.strategy}, ${item.confidence}); warnings: ${item.warnings.length}`).join("\n")}\n\n## Regex Java Baseline\n\n- Endpoints: ${javaActual.endpoints.length} (golden minimum ${javaExpected.endpoints.length})\n- Models: ${javaActual.models.length} (golden minimum ${javaExpected.models.length})\n- Service calls: ${javaActual.serviceCalls.length} (golden minimum ${javaExpected.serviceCalls.length})\n- Repository methods: ${javaActual.repositoryMethods.length} (golden minimum ${javaExpected.repositoryMethods.length})\n\n## Regex React Baseline\n\n- Routes: ${reactActual.routes.length} (golden minimum ${reactExpected.routes.length})\n- Components: ${reactActual.components.length} (golden minimum ${reactExpected.components.length})\n- Interactions: ${reactActual.interactions.length} (golden minimum ${reactExpected.interactions.length})\n- API calls: ${reactActual.apiCalls.length} (golden minimum ${reactExpected.apiCalls.length})\n- Form fields: ${reactActual.formFields.length} (golden minimum ${reactExpected.formFields.length})\n- State records: ${reactActual.stateUsage.length} (golden minimum ${reactExpected.stateUsage.length})\n\n## Comparison Status\n\nAll important golden fields matched. This is the regex baseline for a future AST comparison; it does not change production parser selection.\n`;
}

function fixtureReport(javaActual, reactActual) {
  return `# Fixture Test Report\n\nGenerated: ${new Date().toISOString()}\n\n## Corpus\n\nSmall checked-in fixtures cover Spring controller mappings and parameters, DTO/entity annotations, service/repository calls, Feign outbound calls, React routes/pages/forms/state/API calls, traceability, and focused evidence.\n\n## Parser Result\n\n- Java endpoints detected: ${javaActual.endpoints.length}\n- Java models detected: ${javaActual.models.length}\n- React routes detected: ${reactActual.routes.length}\n- React API calls detected: ${reactActual.apiCalls.length}\n\nResult: PASS. Comparisons intentionally use important-field subsets so formatting and new optional schema fields do not make tests brittle.\n`;
}

async function source(relative) { return { file: relative.replace(/^test-fixtures\//, "src/"), text: await fs.readFile(path.join(root, relative), "utf8") }; }
async function readJson(relative) { return JSON.parse(await fs.readFile(path.join(root, relative), "utf8")); }
async function writeReport(name, content) { const file = path.join(root, ".ai-docs", "dev-audits", name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, "utf8"); }

main().catch((error) => { console.error(error); process.exit(1); });
