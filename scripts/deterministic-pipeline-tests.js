const assert = require("assert");
const fs = require("fs/promises");
const Module = require("module");
const os = require("os");
const path = require("path");

const settings = {
  cacheFolder: ".ai-docs",
  workspaceFolder: ""
};
const vscodeMock = {
  workspace: {
    workspaceFolders: undefined,
    getConfiguration() {
      return {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
        },
        async update(key, value) {
          settings[key] = value;
        }
      };
    }
  }
};
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { RepositoryScanner } = require("../dist/analyzer/repositoryScanner");
const { ReactRepositoryScanner } = require("../dist/analyzer/ui/reactRepositoryScanner");
const {
  RepositoryScanCancelledError,
  RepositoryScanLimitError
} = require("../dist/analyzer/repositoryScanPolicy");
const {
  JsonlReadError,
  readJsonl,
  readRequiredJsonl,
  writeJsonl
} = require("../dist/storage/jsonlWriter");
const { atomicWriteJson } = require("../dist/storage/atomicFile");
const {
  LocalStorageService,
  resolveContainedCachePath
} = require("../dist/storage/localStorageService");
const {
  MultiRepoManifestService,
  canonicalRepositoryIdentity
} = require("../dist/multirepo/multiRepoManifestService");
const { MultiRepoArtifactIdentityService } = require("../dist/multirepo/multiRepoArtifactIdentityService");
const { MultiRepoTraceabilityService } = require("../dist/multirepo/multiRepoTraceabilityService");
const { PipelineArtifactReceiptService } = require("../dist/multirepo/pipelineArtifactReceiptService");
const { MultiRepoQualityReportGenerator } = require("../dist/multirepo/multiRepoQualityReportGenerator");
const { MultiRepoGitService } = require("../dist/multirepo/multiRepoGitService");
const { MultiRepoReactAnalysisService } = require("../dist/multirepo/multiRepoReactAnalysisService");
const { MultiRepoSpringAnalysisService } = require("../dist/multirepo/multiRepoSpringAnalysisService");
const { BeServiceFlowExtractor } = require("../dist/analyzer/be/beServiceFlowExtractor");
const { repositoryUrlForArtifact } = require("../dist/utils/repositoryUrl");
const { safePathSegment } = require("../dist/utils/pathUtils");

async function main() {
  try {
    await testSpringScannerSupportsNestedModulesAndProfiles();
    await testNestedSpringAnalysisIntegration();
    await testScanBudgetsAndCancellation();
    await testReactScannerIsDeterministicAndBounded();
    await testStrictAtomicJsonl();
    await testCacheContainment();
    await testManifestIdentityAndStateInvalidation();
    await testMultiRepoStorageLinkContainment();
    await testRoleManifestCommitMarkers();
    testBeServiceFlowStaysWithinReachableHandlers();
    await testQualityReportRatesFlowOutcomes();
    await testArtifactIdentityAndCorruptionPreflight();
    console.log("Deterministic pipeline tests passed (bounded scans, atomic artifacts, cache containment, and multi-repository identity).");
  } finally {
    Module._load = originalLoad;
  }
}

function testBeServiceFlowStaysWithinReachableHandlers() {
  const endpoints = [
    { httpMethod: "POST", path: "/releases", className: "ReleaseController", handlerMethod: "create" },
    { httpMethod: "POST", path: "/releases/{id}/simulation", className: "ReleaseController", handlerMethod: "simulate" }
  ];
  const components = [
    { type: "service", className: "ReleaseCommandService" },
    { type: "service", className: "AuditService" },
    { type: "repository", className: "ReleaseRepository", extendedClass: "JpaRepository<ReleaseOrder" },
    { type: "repository", className: "SimulationRepository", extendedClass: "JpaRepository<RiskSimulation" },
    { type: "repository", className: "AuditEventRepository" }
  ];
  const repositoryMethods = [
    { repository: "ReleaseRepository", method: "findByClientReference", entity: "ReleaseOrder" }
  ];
  const methodCalls = [
    call("ReleaseController", "create", "releaseService", "ReleaseCommandService", "create"),
    call("ReleaseController", "simulate", "releaseService", "ReleaseCommandService", "simulate"),
    call("ReleaseCommandService", "create", "releases", "ReleaseRepository", "findByClientReference"),
    call("ReleaseCommandService", "create", "releases", "ReleaseRepository", "save"),
    call("ReleaseCommandService", "create", "audit", "AuditService", "record"),
    call("AuditService", "record", "events", "AuditEventRepository", "save"),
    call("ReleaseCommandService", "simulate", "simulations", "SimulationRepository", "findById"),
    call("ReleaseCommandService", "unrelatedMaintenance", "releases", "ReleaseRepository", "deleteAll")
  ];

  const flows = new BeServiceFlowExtractor().extract(
    endpoints,
    components,
    [
      { entity: "ReleaseOrder" },
      { entity: "RiskSimulation" },
      { entity: "AuditEvent" }
    ],
    repositoryMethods,
    methodCalls
  );
  const createFlow = flows.find((flow) => flow.handler === "create");
  const simulationFlow = flows.find((flow) => flow.handler === "simulate");

  assert.deepStrictEqual(createFlow.candidateServices, ["ReleaseCommandService", "AuditService"]);
  assert.deepStrictEqual(createFlow.candidateRepositories, ["ReleaseRepository", "AuditEventRepository"]);
  assert.deepStrictEqual(createFlow.repositoryMethods, [
    "ReleaseRepository.findByClientReference",
    "ReleaseRepository.save",
    "AuditEventRepository.save"
  ]);
  assert.deepStrictEqual(createFlow.entities, ["ReleaseOrder", "AuditEvent"]);
  assert.ok(!createFlow.methodCalls.some((item) => item.includes("ReleaseCommandService.simulate")));
  assert.ok(!createFlow.methodCalls.some((item) => item.includes("unrelatedMaintenance")));
  assert.ok(!createFlow.candidateRepositories.includes("SimulationRepository"));

  assert.deepStrictEqual(simulationFlow.candidateServices, ["ReleaseCommandService"]);
  assert.deepStrictEqual(simulationFlow.candidateRepositories, ["SimulationRepository"]);
  assert.deepStrictEqual(simulationFlow.repositoryMethods, ["SimulationRepository.findById"]);
  assert.deepStrictEqual(simulationFlow.entities, ["RiskSimulation"]);
  assert.ok(!simulationFlow.methodCalls.some((item) => item.includes("ReleaseCommandService.create")));
}

async function testQualityReportRatesFlowOutcomes() {
  await withTempDirectory("bank-pipeline-quality-outcomes-", async (multiRepoRoot) => {
    const manifest = fixtureManifest(multiRepoRoot);
    await writeRoleManifests(multiRepoRoot, manifest);
    await writeJsonl(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), [
      { httpMethod: "GET", path: "/api/orphan", file: "src/api/release.ts", usedBy: ["ReleasePage"] }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "ui", "interaction-index.jsonl"), [
      { page: "ReleasePage", component: "ReleasePage", label: "Load", handler: "load", file: "src/pages/ReleasePage.tsx" }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "ui", "route-index.jsonl"), [
      { route: "/releases", pageComponent: "ReleasePage" }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "bff", "api-endpoints.jsonl"), [
      springEndpoint("GET", "/api/known", "ReleaseBffController", "get")
    ]);
    await writeJsonl(path.join(multiRepoRoot, "bff", "outbound-calls.jsonl"), []);
    await writeJsonl(path.join(multiRepoRoot, "be", "api-endpoints.jsonl"), [
      springEndpoint("GET", "/internal/other", "ReleaseController", "get")
    ]);
    await writeJsonl(path.join(multiRepoRoot, "bff", "bff-flow-index.jsonl"), [
      { endpoint: "GET /api/known", confidence: "low", outboundCalls: [] }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "be", "service-flow-index.jsonl"), [
      {
        endpoint: "GET /internal/other",
        controller: "ReleaseController",
        handler: "get",
        confidence: "high",
        outcome: "unresolved",
        candidateServices: [],
        candidateRepositories: [],
        entities: [],
        repositoryMethods: [],
        methodCalls: []
      }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "be", "entity-index.jsonl"), []);
    await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);

    const poorResult = await new MultiRepoQualityReportGenerator().generate(multiRepoRoot, manifest);
    const poorReport = JSON.parse(await fs.readFile(poorResult.jsonPath, "utf8"));
    const poorRatings = new Map(poorReport.artifactRatings.map((rating) => [rating.key, rating]));
    for (const key of ["bffFlows", "beServiceFlows", "uiToBff", "bffToBe", "pageFlows", "unresolved"]) {
      assert.strictEqual(poorRatings.get(key).rating, "weak", `${key} must not be rated good when its outcomes are unresolved or low-confidence`);
    }
    assert.ok(poorRatings.get("bffToBe").notes.some((note) => /unmatched confidence/.test(note)));
    assert.ok(poorRatings.get("pageFlows").notes.some((note) => /missing a required downstream endpoint/.test(note)));

    await writeJsonl(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), [
      { httpMethod: "GET", path: "/api/known", file: "src/api/release.ts", usedBy: ["ReleasePage"] }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "be", "api-endpoints.jsonl"), [
      springEndpoint("GET", "/api/known", "ReleaseController", "get")
    ]);
    await writeJsonl(path.join(multiRepoRoot, "bff", "outbound-calls.jsonl"), [
      {
        client: "ReleaseClient",
        method: "get",
        httpMethod: "GET",
        targetPath: "/api/known",
        sourceEndpoint: "GET /api/known",
        file: "ReleaseClient.java"
      }
    ]);
    await writeJsonl(path.join(multiRepoRoot, "be", "service-flow-index.jsonl"), [{
      endpoint: "GET /api/known",
      controller: "ReleaseController",
      handler: "get",
      confidence: "high",
      candidateServices: ["ReleaseService"],
      candidateRepositories: ["ReleaseRepository"],
      entities: [],
      repositoryMethods: ["ReleaseRepository.findById"],
      methodCalls: [
        "ReleaseController.get -> ReleaseService.get",
        "ReleaseService.get -> ReleaseRepository.findById"
      ]
    }]);
    await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);

    const resolvedResult = await new MultiRepoQualityReportGenerator().generate(multiRepoRoot, manifest);
    const resolvedReport = JSON.parse(await fs.readFile(resolvedResult.jsonPath, "utf8"));
    const resolvedRatings = new Map(resolvedReport.artifactRatings.map((rating) => [rating.key, rating]));
    for (const key of ["uiToBff", "bffToBe", "pageFlows", "unresolved"]) {
      assert.strictEqual(resolvedRatings.get(key).rating, "good", `${key} should recover after all exact flow matches resolve`);
    }
  });
}

function call(className, methodName, targetVariable, targetType, targetMethod) {
  return { className, methodName, targetVariable, targetType, targetMethod, file: `${className}.java`, confidence: "high" };
}

function springEndpoint(httpMethod, endpointPath, className, handlerMethod) {
  return { httpMethod, path: endpointPath, className, handlerMethod, file: `${className}.java` };
}

async function testSpringScannerSupportsNestedModulesAndProfiles() {
  await withTempDirectory("bank-pipeline-spring-scan-", async (repoRoot) => {
    await write(path.join(repoRoot, "pom.xml"), "<project />\n");
    await write(path.join(repoRoot, "src", "main", "java", "RootApplication.java"), "class RootApplication {}\n");
    await write(path.join(repoRoot, "module-a", "pom.xml"), "<project />\n");
    await write(path.join(repoRoot, "module-a", "src", "main", "java", "com", "bank", "CustomerService.java"), "class CustomerService {}\n");
    await write(path.join(repoRoot, "module-a", "src", "main", "resources", "application-prod.yml"), "spring:\n  application:\n    name: customer\n");
    await write(path.join(repoRoot, "module-a", "src", "main", "resources", "application-prod.eu.yml"), "feature.enabled=true\n");
    await write(path.join(repoRoot, "module-a", "src", "main", "resources", "bootstrap-local.properties"), "spring.application.name=customer\n");
    await write(path.join(repoRoot, "module-b", "src", "test", "java", "CustomerServiceTest.java"), "class CustomerServiceTest {}\n");
    await write(path.join(repoRoot, "module-b", "src", "main", "java-backup", "Ignored.java"), "class Ignored {}\n");
    await write(path.join(repoRoot, "module-b", "target", "generated", "Generated.java"), "class Generated {}\n");
    await write(path.join(repoRoot, "module-b", "TARGET", "generated", "UpperGenerated.java"), "class UpperGenerated {}\n");

    const scanner = new RepositoryScanner();
    const first = await scanner.scan(repoRoot);
    const second = await scanner.scan(repoRoot);
    const names = first.map((file) => file.file);

    assert.deepStrictEqual(names, second.map((file) => file.file), "repeated scans must have stable ordering");
    assert.ok(names.includes("module-a/src/main/java/com/bank/CustomerService.java"));
    assert.ok(names.includes("module-a/src/main/resources/application-prod.yml"));
    assert.ok(names.includes("module-a/src/main/resources/application-prod.eu.yml"));
    assert.ok(names.includes("module-a/src/main/resources/bootstrap-local.properties"));
    assert.ok(names.includes("module-b/src/test/java/CustomerServiceTest.java"));
    assert.ok(!names.some((name) => name.includes("java-backup") || name.includes("target")));
    assert.deepStrictEqual(names, [...names].sort(), "the final index must be globally path-sorted");
    assert.strictEqual(scanner.detectBuildTool(first), "Maven");

    const moduleFile = first.find((file) => file.file.endsWith("CustomerService.java"));
    assert.strictEqual(moduleFile.modulePath, "module-a");
    assert.strictEqual(moduleFile.sourceSet, "main");
    assert.strictEqual(moduleFile.sourceRoot, "module-a/src/main/java");
    const rootFile = first.find((file) => file.file.endsWith("RootApplication.java"));
    assert.strictEqual(rootFile.modulePath, "");
    assert.strictEqual(rootFile.sourceRoot, "src/main/java");
  });
}

async function testNestedSpringAnalysisIntegration() {
  await withTempDirectory("bank-pipeline-spring-integration-", async (root) => {
    const repoRoot = path.join(root, "repository");
    const outputRoot = path.join(root, "artifacts", "bff");
    await fs.mkdir(path.dirname(outputRoot), { recursive: true });
    await write(path.join(repoRoot, "pom.xml"), "<project />\n");
    await write(
      path.join(repoRoot, "services", "customer", "src", "main", "java", "com", "bank", "CustomerController.java"),
      'package com.bank;\n@RestController\n@RequestMapping("/customers")\nclass CustomerController {\n  @GetMapping("/{id}")\n  public String find() { return "ok"; }\n}\n'
    );
    await write(
      path.join(repoRoot, "legacy", "customer", "src", "main", "java", "com", "legacy", "LegacyCustomerController.java"),
      'package com.legacy;\n@RestController\n@RequestMapping("/legacy-customers")\nclass LegacyCustomerController {}\n'
    );
    await new MultiRepoSpringAnalysisService().analyze({
      repoUrl: "https://bitbucket.example/scm/BNK/customer-bff.git",
      repoRoot,
      outputRoot,
      branch: "release/liv",
      pipelineIdentity: "c".repeat(64),
      role: "bff"
    });
    const files = await readRequiredJsonl(path.join(outputRoot, "file-index.jsonl"));
    const endpoints = await readRequiredJsonl(path.join(outputRoot, "api-endpoints.jsonl"));
    const modules = JSON.parse(await fs.readFile(path.join(outputRoot, "module-map.json"), "utf8"));
    assert.ok(files.some((file) => file.modulePath === "services/customer" && file.sourceSet === "main"));
    assert.ok(endpoints.some((endpoint) => endpoint.className === "CustomerController" && endpoint.path.includes("/customers")));
    assert.ok(modules.modules.some((module) => module.name === "services/customer" && module.components.includes("CustomerController")));
    assert.ok(modules.modules.some((module) => module.name === "legacy/customer" && module.components.includes("LegacyCustomerController")));
  });
}

async function testScanBudgetsAndCancellation() {
  await withTempDirectory("bank-pipeline-scan-budget-", async (repoRoot) => {
    const firstContent = "class A {}\n";
    await write(path.join(repoRoot, "src", "main", "java", "A.java"), firstContent);
    const scanner = new RepositoryScanner();
    const exact = await scanner.scan(repoRoot, {
      maxFiles: 1,
      maxFileSizeBytes: Buffer.byteLength(firstContent),
      maxTotalBytes: Buffer.byteLength(firstContent)
    });
    assert.strictEqual(exact.length, 1, "limits are inclusive at the exact boundary");

    await assert.rejects(
      scanner.scan(repoRoot, { maxFileSizeBytes: Buffer.byteLength(firstContent) - 1 }),
      (error) => error instanceof RepositoryScanLimitError && /per-file limit/.test(error.message)
    );
    await assert.rejects(
      scanner.scan(repoRoot, { cancellationToken: { isCancellationRequested: true } }),
      (error) => error instanceof RepositoryScanCancelledError
    );

    await write(path.join(repoRoot, "src", "main", "java", "B.java"), "class B {}\n");
    await assert.rejects(
      scanner.scan(repoRoot, { maxFiles: 1 }),
      (error) => error instanceof RepositoryScanLimitError && /limit is 1 files/.test(error.message)
    );
    await assert.rejects(
      scanner.scan(repoRoot, { maxTotalBytes: Buffer.byteLength(firstContent) + 1 }),
      (error) => error instanceof RepositoryScanLimitError && /total content limit/.test(error.message)
    );
    let cancellationChecks = 0;
    await assert.rejects(
      scanner.scan(repoRoot, { cancellationToken: { get isCancellationRequested() { return ++cancellationChecks > 3; } } }),
      (error) => error instanceof RepositoryScanCancelledError
    );
  });

  await withTempDirectory("bank-pipeline-binary-budget-", async (repoRoot) => {
    await writeBuffer(path.join(repoRoot, "src", "main", "java", "A.java"), Buffer.from([0]));
    await writeBuffer(path.join(repoRoot, "src", "main", "java", "B.java"), Buffer.from([0]));
    await assert.rejects(
      new RepositoryScanner().scan(repoRoot, { maxFiles: 1 }),
      (error) => error instanceof RepositoryScanLimitError
    );
  });
}

async function testReactScannerIsDeterministicAndBounded() {
  await withTempDirectory("bank-pipeline-react-scan-", async (repoRoot) => {
    await write(path.join(repoRoot, "package.json"), '{"dependencies":{"react":"latest"}}\n');
    await write(path.join(repoRoot, "apps", "portal", "src", "App.tsx"), "export const App = () => null;\n");
    await write(path.join(repoRoot, "apps", "portal", "src", "api.ts"), "export const load = () => fetch('/api');\n");
    await write(path.join(repoRoot, "node_modules", "hidden.ts"), "throw new Error('ignored');\n");
    await write(path.join(repoRoot, "Node_Modules", "also-hidden.ts"), "throw new Error('ignored');\n");
    await write(path.join(repoRoot, ".Next", "server.ts"), "throw new Error('ignored');\n");
    const scanner = new ReactRepositoryScanner();
    const first = await scanner.scan(repoRoot);
    const second = await scanner.scan(repoRoot);
    assert.deepStrictEqual(first.map((file) => file.file), second.map((file) => file.file));
    assert.ok(first.some((file) => file.file === "apps/portal/src/App.tsx"));
    assert.ok(!first.some((file) => file.file.includes("node_modules")));
    assert.ok(!first.some((file) => file.file.toLowerCase().includes("node_modules") || file.file.toLowerCase().includes(".next")));
    assert.deepStrictEqual(first.map((file) => file.file), [...first.map((file) => file.file)].sort());
    assert.ok(scanner.detectIndicators(first).includes("package.json react dependency"));
    assert.ok(scanner.detectIndicators(first).includes("React entry files"));
    await assert.rejects(
      scanner.scan(repoRoot, { maxFiles: 2 }),
      (error) => error instanceof RepositoryScanLimitError
    );
  });
}

async function testStrictAtomicJsonl() {
  await withTempDirectory("bank-pipeline-jsonl-", async (root) => {
    const file = path.join(root, "records.jsonl");
    await writeJsonl(file, [{ id: 1 }, { id: 2 }]);
    assert.deepStrictEqual(await readRequiredJsonl(file), [{ id: 1 }, { id: 2 }]);

    const tolerant = path.join(root, "tolerant.jsonl");
    await fs.writeFile(tolerant, '\uFEFF{"id":1}\r\n\r\n {"id":2} \r\n', "utf8");
    assert.deepStrictEqual(await readRequiredJsonl(tolerant), [{ id: 1 }, { id: 2 }]);
    assert.deepStrictEqual(await readJsonl(path.join(root, "optional.jsonl")), []);
    await assert.rejects(
      readRequiredJsonl(path.join(root, "required.jsonl")),
      (error) => error instanceof JsonlReadError && error.code === "JSONL_NOT_FOUND"
    );

    const malformed = path.join(root, "malformed.jsonl");
    await fs.writeFile(malformed, '{"id":1}\n{"secret":"must-not-appear"\n', "utf8");
    await assert.rejects(
      readRequiredJsonl(malformed),
      (error) => error instanceof JsonlReadError &&
        error.code === "JSONL_INVALID_JSON" &&
        error.lineNumber === 2 &&
        error.filePath === malformed &&
        !error.message.includes("must-not-appear")
    );

    const invalidRecord = path.join(root, "invalid-record.jsonl");
    await fs.writeFile(invalidRecord, '{"id":"wrong"}\n', "utf8");
    await assert.rejects(
      readRequiredJsonl(invalidRecord, { validate: (value) => Boolean(value) && typeof value.id === "number" }),
      (error) => error instanceof JsonlReadError && error.code === "JSONL_INVALID_RECORD" && error.lineNumber === 1
    );

    const batches = Array.from({ length: 8 }, (_, batch) =>
      Array.from({ length: 30 }, (_, index) => ({ batch, index }))
    );
    await Promise.all(batches.map((records) => writeJsonl(file, records)));
    const concurrentResult = await readRequiredJsonl(file);
    assert.ok(batches.some((records) => JSON.stringify(records) === JSON.stringify(concurrentResult)), "a concurrent writer must win as one complete batch");
    assert.deepStrictEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);

    const originalRename = fs.rename;
    let transientFailures = 2;
    fs.rename = async (...args) => {
      if (transientFailures-- > 0) {
        const error = new Error("fixture transient lock");
        error.code = "EBUSY";
        throw error;
      }
      return originalRename(...args);
    };
    try {
      await writeJsonl(file, [{ retried: true }]);
    } finally {
      fs.rename = originalRename;
    }
    assert.deepStrictEqual(await readRequiredJsonl(file), [{ retried: true }]);

    fs.rename = async () => {
      const error = new Error("fixture persistent lock");
      error.code = "EPERM";
      throw error;
    };
    try {
      await assert.rejects(writeJsonl(file, [{ mustNotPublish: true }]), /fixture persistent lock/);
    } finally {
      fs.rename = originalRename;
    }
    assert.deepStrictEqual(await readRequiredJsonl(file), [{ retried: true }], "persistent publication failure must preserve the previous target");
    assert.deepStrictEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);

    await writeJsonl(file, [{ stable: true }]);
    const circular = {};
    circular.self = circular;
    await assert.rejects(writeJsonl(file, [circular]), /circular/i);
    await assert.rejects(writeJsonl(file, [undefined]), /cannot be serialized/i);
    assert.deepStrictEqual(await readRequiredJsonl(file), [{ stable: true }], "serialization failures must preserve the previous artifact");

    const jsonFile = path.join(root, "manifest.json");
    await atomicWriteJson(jsonFile, { stable: true });
    await assert.rejects(atomicWriteJson(jsonFile, undefined), /cannot be serialized/i);
    assert.deepStrictEqual(JSON.parse(await fs.readFile(jsonFile, "utf8")), { stable: true });
  });
}

async function testCacheContainment() {
  await withTempDirectory("bank-pipeline-cache-", async (root) => {
    const repoRoot = path.join(root, "repository");
    await fs.mkdir(repoRoot, { recursive: true });
    assert.strictEqual(resolveContainedCachePath(repoRoot, ".ai-docs"), path.join(repoRoot, ".ai-docs"));
    assert.strictEqual(resolveContainedCachePath(repoRoot, "..cache"), path.join(repoRoot, "..cache"));
    assert.strictEqual(resolveContainedCachePath(repoRoot, "nested/cache"), path.join(repoRoot, "nested", "cache"));

    for (const unsafe of [".", "..", "../outside", "nested/../outside", "C:\\outside", "\\\\server\\share", path.resolve(root, "outside")]) {
      assert.throws(() => resolveContainedCachePath(repoRoot, unsafe), /relative child folder|inside the repository root/);
    }

    const context = extensionContext(path.join(root, "global"));
    settings.cacheFolder = "nested/cache";
    const created = await new LocalStorageService(context).ensureAiDocs(repoRoot);
    assert.strictEqual(created, path.join(repoRoot, "nested", "cache"));
    await fs.access(path.join(created, "generated-docs"));

    const outside = path.join(root, "outside-target");
    const link = path.join(repoRoot, "escape");
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      settings.cacheFolder = "escape/cache";
      await assert.rejects(
        new LocalStorageService(context).ensureAiDocs(repoRoot),
        /resolves through a link outside the configured storage root/
      );
    } catch (error) {
      if (!error || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        throw error;
      }
    } finally {
      settings.cacheFolder = ".ai-docs";
    }
    assert.notStrictEqual(safePathSegment("A/B", "page"), safePathSegment("A B", "page"));
    assert.notStrictEqual(safePathSegment("x".repeat(100) + "a", "page"), safePathSegment("x".repeat(100) + "b", "page"));
  });
}

async function testManifestIdentityAndStateInvalidation() {
  await withTempDirectory("bank-pipeline-manifest-", async (root) => {
    settings.workspaceFolder = path.join(root, "workspace");
    const context = extensionContext(path.join(root, "global"));
    const service = new MultiRepoManifestService(context);
    const input = {
      projectName: "Customer Platform",
      branch: "release/liv",
      uiRepoUrl: "https://bitbucket.example/scm/BNK/customer-ui.git",
      bffRepoUrl: "ssh://git@bitbucket.example/BNK/customer-bff.git",
      beRepoUrl: "git@bitbucket.example:BNK/customer-be.git"
    };

    const initial = await service.saveManifest(input);
    const initialRoot = service.getMultiRepoRoot(initial);
    assert.strictEqual(initial.schemaVersion, 3);
    assert.match(initial.pipelineIdentity, /^[a-f0-9]{64}$/);
    assert.ok(initialRoot.includes(path.join("multi-repo", "workspaces", initial.pipelineIdentity)));
    await fs.access(path.join(initialRoot, "manifest.json"));
    assert.ok(Object.values(initial.repos).every((repo) => repo.status === "not-analyzed"));
    initial.repos.ui.status = "analyzed";
    initial.repos.bff.status = "error";
    initial.repos.bff.error = "fixture failure";
    initial.repos.be.status = "ready";
    await service.updateManifest(initial);
    await context.globalState.update("bankSpringDocs.pageAnalysis.selectedPage", { page: "Customers" });

    assert.strictEqual(
      canonicalRepositoryIdentity("https://user:secret@bitbucket.example/scm/BNK/customer-ui.git"),
      canonicalRepositoryIdentity(input.uiRepoUrl)
    );
    assert.notStrictEqual(
      canonicalRepositoryIdentity("https://bitbucket.example:7990/scm/BNK/customer-ui.git"),
      canonicalRepositoryIdentity("https://bitbucket.example:7991/scm/BNK/customer-ui.git"),
      "self-hosted Bitbucket ports are part of repository identity"
    );
    assert.notStrictEqual(
      canonicalRepositoryIdentity("https://bitbucket.example/proxy-a/scm/BNK/customer-ui.git"),
      canonicalRepositoryIdentity("https://bitbucket.example/proxy-b/scm/BNK/customer-ui.git"),
      "reverse-proxy base paths are part of repository identity"
    );
    assert.strictEqual(
      repositoryUrlForArtifact("https://user:secret@bitbucket.example/scm/BNK/customer-ui.git"),
      "https://bitbucket.example/scm/BNK/customer-ui.git"
    );
    await assert.rejects(
      service.saveManifest({ ...input, uiRepoUrl: "https://user:secret@bitbucket.example/scm/BNK/customer-ui.git" }),
      /must not contain embedded credentials/
    );
    assert.ok(!(await fs.readFile(service.getManifestPath(), "utf8")).includes("secret"));

    const reused = await service.saveManifest(input);
    assert.strictEqual(reused.pipelineIdentity, initial.pipelineIdentity);
    assert.strictEqual(reused.repos.ui.status, "analyzed");
    assert.strictEqual(reused.repos.bff.status, "error");
    assert.strictEqual(reused.repos.bff.error, "fixture failure");
    assert.ok(context.globalState.get("bankSpringDocs.pageAnalysis.selectedPage"));

    const changed = await service.saveManifest({ ...input, branch: "release/next" });
    const changedRoot = service.getMultiRepoRoot(changed);
    assert.notStrictEqual(changed.pipelineIdentity, reused.pipelineIdentity);
    assert.notStrictEqual(changedRoot, initialRoot);
    assert.strictEqual(service.getMultiRepoRoot(), changedRoot, "the active workspace pointer follows the saved identity");
    await fs.access(path.join(changedRoot, "manifest.json"));
    assert.ok(Object.values(changed.repos).every((repo) => repo.status === "not-analyzed"));
    assert.ok(Object.values(changed.repos).every((repo) => repo.error === undefined));
    assert.strictEqual(context.globalState.get("bankSpringDocs.pageAnalysis.selectedPage"), undefined);
    assert.notStrictEqual(changed.repos.ui.localPath, reused.repos.ui.localPath);

    const persisted = JSON.parse(await fs.readFile(service.getManifestPath(), "utf8"));
    assert.strictEqual(persisted.schemaVersion, 3);
    assert.strictEqual(persisted.pipelineIdentity, changed.pipelineIdentity);
    persisted.pipelineIdentity = "0".repeat(64);
    await fs.writeFile(service.getManifestPath(), `${JSON.stringify(persisted)}\n`, "utf8");
    assert.strictEqual((await service.readManifest()).pipelineIdentity, changed.pipelineIdentity, "persisted identities are recomputed from manifest inputs");
    persisted.pipelineIdentity = changed.pipelineIdentity;
    persisted.repos.ui.localPath = path.join(root, "outside", "tampered-ui");
    persisted.repos.ui.status = "analyzed";
    await fs.writeFile(service.getManifestPath(), `${JSON.stringify(persisted)}\n`, "utf8");
    const normalized = await service.readManifest();
    assert.notStrictEqual(normalized.repos.ui.localPath, persisted.repos.ui.localPath);
    assert.strictEqual(normalized.repos.ui.status, "not-analyzed");

    const tampered = JSON.parse(JSON.stringify(changed));
    for (const role of ["ui", "bff", "be"]) {
      tampered.repos[role].localPath = path.join(root, "outside", role);
    }
    const cloneResult = await new MultiRepoGitService(service.getCloneRoot()).cloneOrUpdateAll(tampered);
    assert.strictEqual(cloneResult.failed.length, 3, "clone targets outside the configured root must be rejected before Git runs");
    const reservedSegment = path.relative(path.join(settings.workspaceFolder, "mr"), service.getRepositoryRoot("CON")).split(path.sep)[0];
    assert.notStrictEqual(reservedSegment.toLowerCase(), "con");
    settings.workspaceFolder = "";
  });
}

async function testMultiRepoStorageLinkContainment() {
  await withTempDirectory("bank-pipeline-multi-link-", async (root) => {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, path.join(workspace, ".ai-docs"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        return;
      }
      throw error;
    }

    settings.workspaceFolder = workspace;
    try {
      const service = new MultiRepoManifestService(extensionContext(path.join(root, "global")));
      await assert.rejects(
        service.saveManifest({
          projectName: "Linked Platform",
          branch: "release/liv",
          uiRepoUrl: "https://bitbucket.example/scm/BNK/ui.git",
          bffRepoUrl: "https://bitbucket.example/scm/BNK/bff.git",
          beRepoUrl: "https://bitbucket.example/scm/BNK/be.git"
        }),
        /resolves through a link outside the configured storage root/
      );
      await assert.rejects(fs.access(path.join(outside, "multi-repo")), (error) => error.code === "ENOENT");
    } finally {
      settings.workspaceFolder = "";
    }
  });
}

async function testRoleManifestCommitMarkers() {
  await withTempDirectory("bank-pipeline-role-manifest-", async (root) => {
    const failedOutput = path.join(root, "failed-ui");
    await write(path.join(failedOutput, "manifest.json"), '{"stale":true}\n');
    const failingScanner = { scan: async () => { throw new Error("fixture scan failure"); } };
    await assert.rejects(
      new MultiRepoReactAnalysisService(failingScanner).analyze({
        repoUrl: "https://bitbucket.example/scm/BNK/ui.git",
        repoRoot: root,
        outputRoot: failedOutput,
        branch: "release/liv",
        pipelineIdentity: "new-pipeline"
      }),
      /fixture scan failure/
    );
    await assert.rejects(fs.access(path.join(failedOutput, "manifest.json")), (error) => error.code === "ENOENT");

    const uiOutput = path.join(root, "ui");
    await new MultiRepoReactAnalysisService({
      scan: async () => [],
      detectIndicators: () => []
    }).analyze({
      repoUrl: "https://bitbucket.example/scm/BNK/ui.git",
      repoRoot: root,
      outputRoot: uiOutput,
      branch: "release/liv",
      pipelineIdentity: "pipeline-fixture"
    });
    const uiManifest = JSON.parse(await fs.readFile(path.join(uiOutput, "manifest.json"), "utf8"));
    assert.strictEqual(uiManifest.pipelineIdentity, "pipeline-fixture");
    assert.strictEqual(uiManifest.repositoryUrl, "https://bitbucket.example/scm/BNK/ui.git");

    const bffOutput = path.join(root, "bff");
    await new MultiRepoSpringAnalysisService({
      scan: async () => [],
      detectBuildTool: () => "Unknown"
    }).analyze({
      repoUrl: "ssh://git@bitbucket.example/BNK/bff.git",
      repoRoot: root,
      outputRoot: bffOutput,
      branch: "release/liv",
      pipelineIdentity: "pipeline-fixture",
      role: "bff"
    });
    const bffManifest = JSON.parse(await fs.readFile(path.join(bffOutput, "manifest.json"), "utf8"));
    assert.strictEqual(bffManifest.pipelineIdentity, "pipeline-fixture");
    assert.strictEqual(bffManifest.repositoryUrl, "ssh://bitbucket.example/BNK/bff.git");
  });
}

async function testArtifactIdentityAndCorruptionPreflight() {
  await withTempDirectory("bank-pipeline-artifacts-", async (multiRepoRoot) => {
    const manifest = fixtureManifest(multiRepoRoot);
    await writeRoleManifests(multiRepoRoot, manifest);
    const identityService = new MultiRepoArtifactIdentityService();
    assert.deepStrictEqual(await identityService.inspect(multiRepoRoot, manifest), []);

    await writeRoleManifest(multiRepoRoot, manifest, "be", { pipelineIdentity: "different-pipeline" });
    const mismatch = await identityService.inspect(multiRepoRoot, manifest);
    assert.ok(mismatch.some((issue) => issue.role === "be" && issue.problem === "pipeline-mismatch"));
    await assert.rejects(identityService.assertCompatible(multiRepoRoot, manifest), /different pipeline selection/);
    await writeRoleManifest(multiRepoRoot, manifest, "be");

    await write(path.join(multiRepoRoot, "ui", "manifest.json"), "null\n");
    const malformedManifest = await identityService.inspect(multiRepoRoot, manifest);
    assert.ok(malformedManifest.some((issue) => issue.role === "ui" && issue.problem === "malformed"));
    await writeRoleManifest(multiRepoRoot, manifest, "ui");

    await write(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), '{"httpMethod":"GET","path":"/api","file":"api.ts"}\n{"secret":"never-log-this"\n');
    for (const relative of [
      "ui/interaction-index.jsonl",
      "ui/route-index.jsonl",
      "bff/api-endpoints.jsonl",
      "bff/outbound-calls.jsonl",
      "be/api-endpoints.jsonl",
      "be/service-flow-index.jsonl",
      "be/entity-index.jsonl"
    ]) {
      await write(path.join(multiRepoRoot, relative), "");
    }
    const sentinelPath = path.join(multiRepoRoot, "traceability", "ui-to-bff.jsonl");
    await write(sentinelPath, '{"sentinel":true}\n');
    await assert.rejects(
      new MultiRepoTraceabilityService().build(multiRepoRoot, manifest),
      (error) => error instanceof JsonlReadError &&
        error.code === "JSONL_INVALID_JSON" &&
        error.lineNumber === 2 &&
        !error.message.includes("never-log-this")
    );
    assert.strictEqual(await fs.readFile(sentinelPath, "utf8"), '{"sentinel":true}\n', "failed preflight reads must not overwrite prior outputs");
    await assert.rejects(fs.access(path.join(multiRepoRoot, "traceability", "pipeline-manifest.json")), (error) => error.code === "ENOENT");

    await write(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), '{}\n');
    await assert.rejects(
      new MultiRepoTraceabilityService().build(multiRepoRoot, manifest),
      (error) => error instanceof JsonlReadError && error.code === "JSONL_INVALID_RECORD" && error.lineNumber === 1
    );
    assert.strictEqual(await fs.readFile(sentinelPath, "utf8"), '{"sentinel":true}\n');

    for (const relative of [
      "ui/api-call-index.jsonl",
      "ui/interaction-index.jsonl",
      "ui/route-index.jsonl",
      "bff/api-endpoints.jsonl",
      "bff/outbound-calls.jsonl",
      "be/api-endpoints.jsonl",
      "be/service-flow-index.jsonl",
      "be/entity-index.jsonl"
    ]) {
      await write(path.join(multiRepoRoot, relative), "");
    }
    await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);
    const receiptService = new PipelineArtifactReceiptService();
    assert.strictEqual(await receiptService.assertTraceabilityCompatible(multiRepoRoot, manifest), true);
    await write(path.join(multiRepoRoot, "be", "entity-index.jsonl"), " \n");
    await assert.rejects(
      receiptService.assertTraceabilityCompatible(multiRepoRoot, manifest),
      /stale, incomplete, or corrupt/
    );
    await write(path.join(multiRepoRoot, "be", "entity-index.jsonl"), "");
    await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);
    await write(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), " \n");
    await assert.rejects(
      receiptService.assertTraceabilityCompatible(multiRepoRoot, manifest),
      /stale, incomplete, or corrupt/
    );

    await write(path.join(multiRepoRoot, "ui", "file-index.jsonl"), '{"file":"stale.ts"}\n');
    await fs.rm(path.join(multiRepoRoot, "ui", "manifest.json"));
    await assert.rejects(
      new MultiRepoQualityReportGenerator().generate(multiRepoRoot, manifest),
      /UI analysis manifest is missing/
    );
  });
}

function fixtureManifest(root) {
  const pipelineIdentity = "a".repeat(64);
  return {
    schemaVersion: 3,
    pipelineIdentity,
    projectName: "Fixture Platform",
    branch: "release/liv",
    repos: {
      ui: fixtureRepo("react", "https://bitbucket.example/scm/BNK/ui.git", path.join(root, "repos", "ui")),
      bff: fixtureRepo("spring-bff", "https://bitbucket.example/scm/BNK/bff.git", path.join(root, "repos", "bff")),
      be: fixtureRepo("spring-be", "https://bitbucket.example/scm/BNK/be.git", path.join(root, "repos", "be"))
    },
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function fixtureRepo(type, url, localPath) {
  return { type, url, localPath, status: "analyzed" };
}

async function writeRoleManifests(root, manifest) {
  for (const role of ["ui", "bff", "be"]) {
    await writeRoleManifest(root, manifest, role);
  }
}

async function writeRoleManifest(root, manifest, role, overrides = {}) {
  await write(
    path.join(root, role, "manifest.json"),
    `${JSON.stringify({
      repositoryUrl: manifest.repos[role].url,
      branch: manifest.branch,
      pipelineIdentity: manifest.pipelineIdentity,
      ...overrides
    }, null, 2)}\n`
  );
}

function extensionContext(globalStorageRoot) {
  const values = new Map();
  return {
    globalStorageUri: { fsPath: globalStorageRoot },
    globalState: {
      get(key) {
        return values.get(key);
      },
      async update(key, value) {
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
      }
    }
  };
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeBuffer(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function withTempDirectory(prefix, operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await operation(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exit(1);
});
