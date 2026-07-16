const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");

const { ParserProviderRegistry } = require("../dist/parser/parserProviderRegistry");
const { collectParserProviderDiagnostics } = require("../dist/parser/parserProviderDiagnostics");
const { RegexJavaParserProvider } = require("../dist/parser/java/regexJavaParserProvider");
const { RegexReactParserProvider } = require("../dist/parser/react/regexReactParserProvider");
const { ReactRepositoryScanner } = require("../dist/analyzer/ui/reactRepositoryScanner");
const { ReactRouteExtractor } = require("../dist/analyzer/ui/reactRouteExtractor");
const { ReactComponentExtractor } = require("../dist/analyzer/ui/reactComponentExtractor");
const { ReactApiCallExtractor } = require("../dist/analyzer/ui/reactApiCallExtractor");
const { ReactFormFieldExtractor } = require("../dist/analyzer/ui/reactFormFieldExtractor");
const { ReactStateExtractor } = require("../dist/analyzer/ui/reactStateExtractor");

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
  testJavaModelRegressions(java);
  const javaExpected = await readJson("test-fixtures/expected/java/regex-java.json");
  const reactExpected = await readJson("test-fixtures/expected/react/regex-react.json");
  assertExpectedRecords(javaActual, javaExpected, ["endpoints", "models", "serviceCalls", "repositoryMethods"]);
  assertExpectedRecords(reactActual, reactExpected, ["routes", "components", "interactions", "apiCalls", "formFields", "stateUsage"]);
  await testAdvancedReactRegressions();

  const diagnostics = collectParserProviderDiagnostics(registry.list());
  assert.strictEqual(diagnostics.providers.length, 2);
  assert.ok(diagnostics.warningCount > 0);
  await writeReport("parser-comparison-report.md", parserReport(javaActual, javaExpected, reactActual, reactExpected, diagnostics));
  await writeReport("fixture-test-report.md", fixtureReport(javaActual, reactActual));
  console.log("Parser fixture tests passed.");
}

async function testAdvancedReactRegressions() {
  const fixtureRoot = path.join(root, "test-fixtures", "react", "advanced");
  const files = await new ReactRepositoryScanner().scan(fixtureRoot);
  const routes = new ReactRouteExtractor().extract(files);
  const components = new ReactComponentExtractor().extract(files, routes);
  const apiCalls = new ReactApiCallExtractor().extract(files, components);
  const formFields = new ReactFormFieldExtractor().extract(files, components);
  const states = new ReactStateExtractor().extract(files, components);

  assert.strictEqual(files.find((file) => file.file === "pages/ReleaseDetailPage.tsx")?.classification, "page",
    "explicit page paths and Page filenames must outrank inline fetch/API content");
  assert.ok(components.some((component) => component.component === "ReleaseDetailPage" && component.classification === "page"),
    "a data-loading page must remain in the page/component indexes");

  assert.ok(routes.some((route) => route.route === "/transfers/:id" && route.pageComponent === "TransferDetailPage"),
    "a role guard wrapper must resolve to the nested route page");
  assert.ok(!routes.some((route) => route.pageComponent === "RoleGuard"), "a route guard is not a leaf page");
  assert.ok(components.some((component) => component.component === "TransferDetailPage" && component.classification === "page" && component.route === "/transfers/:id"));

  assert.ok(apiCalls.some((call) => call.clientFunction === "search" && call.httpMethod === "GET" &&
    call.path === "/api/transfers/{customerId}?status={status}" && call.parameters.includes("actorHeaders")),
    "config-object request wrappers and imported aliased path constants must be resolved");
  assert.ok(apiCalls.some((call) => call.clientFunction === "approve" && call.httpMethod === "POST" &&
    call.path === "/api/transfers/{transferId}/approve" && call.parameters.includes("header:X-Actor-Id")),
    "client wrappers and literal header maps must be indexed");
  assert.ok(apiCalls.some((call) => call.clientFunction === "cancel" && call.httpMethod === "DELETE" && call.path === "/api/transfers/{transferId}"),
    "method-first request wrappers must be indexed");
  assert.ok(apiCalls.some((call) => call.clientFunction === "list" && call.httpMethod === "GET" &&
    call.path === "/api/treasury/releases?status={status}"),
    "lowercase base constants and optional template query suffixes must preserve the resolvable endpoint path");
  assert.ok(apiCalls.some((call) => call.clientFunction === "detail" && call.httpMethod === "GET" &&
    call.path === "/api/treasury/releases/{id}"),
    "lowercase base constants must resolve in path-parameter templates");
  assert.ok(apiCalls.some((call) => call.clientFunction === "approve" && call.usedBy.length === 1 && call.usedBy[0] === "ReleaseDetailPage"),
    "a component API consumer with one reachable parent must be attributed to that page");
  assert.ok(apiCalls.some((call) => call.path === "/api/treasury/releases/summary" && call.usedBy.includes("ReleaseDetailPage")),
    "an inline page fetch must retain direct page ownership");

  for (const fieldName of ["beneficiaryIban", "note", "currency", "amount"]) {
    assert.ok(formFields.some((field) => field.fieldName === fieldName && field.page === "TransferDetailPage"),
      `nested JSX form field ${fieldName} should be attributed to its owning page`);
  }
  for (const fieldName of ["comment", "stepUpToken", "status"]) {
    assert.ok(formFields.some((field) => field.fieldName === fieldName && field.page === "ReleaseDetailPage"),
      `direct controlled field ${fieldName} should be extracted from its value binding`);
  }
  assert.ok(formFields.some((field) => field.fieldName === "Dynamic release filter" &&
    field.source === "controlled aria-label fallback" && field.page === "ReleaseDetailPage"),
    "a non-trivial controlled expression may use a bounded literal aria-label fallback");
  assert.ok(states.some((state) => state.stateName === "wizard" && state.setter === "dispatch" && state.initialValue === "INITIAL_STATE"));
  assert.ok(states.some((state) => state.stateName === "wizard.step" && state.initialValue === "1"));
  assert.ok(states.some((state) => state.stateName === "wizard.confirmed" && state.initialValue === "false"));
}

function testJavaModelRegressions(provider) {
  const recordModels = provider.parseDtoOrEntity("src/main/java/com/acme/treasury/dto/CreateReleaseRequest.java", `
    package com.acme.treasury.dto;
    import jakarta.validation.Valid;
    import jakarta.validation.constraints.*;
    import java.math.BigDecimal;
    import java.util.List;
    public record CreateReleaseRequest(
      @NotBlank String sourceAccountId,
      @Positive @Digits(integer = 12, fraction = 2) BigDecimal amount,
      @Valid List<BeneficiaryDto> beneficiaries,
      @Size(max = 64) String note
    ) {}
  `);
  const recordDto = recordModels.find((model) => model.className === "CreateReleaseRequest");
  assert.ok(recordDto, "Java record DTO should be indexed");
  assert.deepStrictEqual(recordDto.fields, [
    "sourceAccountId: String",
    "amount: BigDecimal",
    "beneficiaries: List<BeneficiaryDto>",
    "note: String"
  ]);
  assert.ok(recordDto.validations.some((item) => item.field === "sourceAccountId" && item.annotation === "NotBlank"));
  assert.ok(recordDto.validations.some((item) => item.field === "amount" && item.annotation === "Digits" && /fraction\s*=\s*2/.test(item.arguments)));
  assert.ok(recordDto.validations.some((item) => item.field === "note" && item.annotation === "Size" && item.arguments === "max = 64"));

  const entityModels = provider.parseDtoOrEntity("src/main/java/com/acme/treasury/domain/ReleaseOrder.java", `
    package com.acme.treasury.domain;
    import jakarta.persistence.*;
    @Entity
    @Table(
      uniqueConstraints = @UniqueConstraint(name = "uk_release_reference", columnNames = "client_reference"),
      name = "release_orders"
    )
    public class ReleaseOrder {
      @Id private Long id;
    }
  `);
  const entity = entityModels.find((model) => model.entity === "ReleaseOrder");
  assert.ok(entity, "entity should be indexed");
  assert.strictEqual(entity.table, "release_orders", "@UniqueConstraint.name must not be used as @Table.name");

  const falsePositive = provider.parseDtoOrEntity("src/main/java/com/acme/treasury/service/ReleaseCommandService.java", `
    package com.acme.treasury.service;
    public class ReleaseCommandService {
      private final String state;
    }
  `);
  assert.deepStrictEqual(falsePositive, [], "DTO path detection must not match command/query substrings in service filenames");
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
async function writeReport(name, content) { if (process.env.BANK_SPRING_DOCS_WRITE_TEST_REPORTS === "0") return; const file = path.join(root, ".ai-docs", "dev-audits", name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, "utf8"); }

main().catch((error) => { console.error(error); process.exit(1); });
