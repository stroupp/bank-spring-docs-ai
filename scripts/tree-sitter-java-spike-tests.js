const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const { performance } = require("perf_hooks");

const { TreeSitterJavaEndpointProvider } = require("../dist/parser/java/treeSitterJavaEndpointProvider");
const { RegexJavaParserProvider } = require("../dist/parser/java/regexJavaParserProvider");
const { RepositoryScanner } = require("../dist/analyzer/repositoryScanner");

const root = path.resolve(__dirname, "..");

async function main() {
  const ast = new TreeSitterJavaEndpointProvider();
  const regex = new RegexJavaParserProvider();
  const fixtures = await Promise.all([
    readSource("test-fixtures/java-spring/controllers/CustomerSearchController.java"),
    readSource("test-fixtures/java-spring/controllers/LegacyOrderController.java")
  ]);

  const astEndpoints = fixtures.flatMap((fixture) => ast.parseControllerEndpoints(fixture.file, fixture.source));
  const regexEndpoints = fixtures.flatMap((fixture) => regex.parseControllerEndpoints(fixture.file, fixture.source));
  const expected = JSON.parse(await fs.readFile(path.join(root, "test-fixtures/expected/java/tree-sitter-java-endpoints.json"), "utf8"));

  assertExpected(astEndpoints, expected.endpoints);
  assertParameterChecks(astEndpoints, expected.parameterChecks);
  assert.ok(astEndpoints.every((endpoint) => endpoint.sourceRange && endpoint.sourceRange.startLine > 0), "AST endpoints must include one-based source ranges");
  assert.strictEqual(ast.diagnostics().warnings.some((warning) => warning.code === "AST_REGEX_FALLBACK"), false, "Valid fixtures should not need regex endpoint fallback");
  assert.ok(ast.diagnostics().warnings.some((warning) => warning.code === "AST_REGEX_DIVERGENCE"), "The multi-path fixture should make AST/regex divergence auditable");
  const fixtureDiagnostics = ast.diagnostics();
  assertFallbackIsNonFatal(fixtures[0]);

  const benchmark = benchmarkProviders(ast, regex, fixtures, 50);
  const realRepoComparison = await compareCachedRepositories(ast, regex);
  await writeReport("tree-sitter-java-endpoint-spike-report.md", spikeReport(astEndpoints, regexEndpoints, benchmark, realRepoComparison, fixtureDiagnostics));
  await writeReport("tree-sitter-real-repo-comparison-report.md", realRepoReport(realRepoComparison));
  console.log(`Tree-sitter Java endpoint spike passed: ${astEndpoints.length} fixture endpoints; ${realRepoComparison.controllerFiles} cached controller files compared.`);
}

function assertFallbackIsNonFatal(fixture) {
  const failingProvider = new TreeSitterJavaEndpointProvider();
  failingProvider.parser.parse = () => { throw new Error("controlled parser failure"); };
  const endpoints = failingProvider.parseControllerEndpoints(fixture.file, fixture.source);
  assert.ok(endpoints.length > 0, "A parser exception must retain regex endpoint results");
  assert.ok(endpoints.every((endpoint) => endpoint.fallbackReason && endpoint.parser === "regex-java"), "Fallback results must be explicit and auditable");
  assert.ok(failingProvider.diagnostics().warnings.some((warning) => warning.code === "AST_REGEX_FALLBACK"), "Fallback diagnostics must be exposed");
}

function assertExpected(actual, expected) {
  for (const item of expected) {
    assert.ok(actual.some((record) => isSubset(record, item)), `Missing AST endpoint: ${JSON.stringify(item)}\nActual: ${JSON.stringify(actual, null, 2)}`);
  }
}

function assertParameterChecks(endpoints, checks) {
  for (const check of checks) {
    const endpoint = endpoints.find((item) => item.handlerMethod === check.handlerMethod && item.parameters.some((parameter) => parameter.name === check.name));
    assert.ok(endpoint, `Missing endpoint parameter ${check.handlerMethod}.${check.name}`);
    const parameter = endpoint.parameters.find((item) => item.name === check.name);
    const expectedParameter = { ...check };
    delete expectedParameter.handlerMethod;
    assert.ok(isSubset(parameter, expectedParameter), `Parameter mismatch: ${JSON.stringify(check)}\nActual: ${JSON.stringify(parameter)}`);
  }
}

function isSubset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => isSubset(actual[index], item));
  if (expected && typeof expected === "object") return actual && Object.entries(expected).every(([key, value]) => isSubset(actual[key], value));
  return actual === expected;
}

function benchmarkProviders(ast, regex, fixtures, iterations) {
  const run = (provider) => {
    const started = performance.now();
    let endpointCount = 0;
    for (let i = 0; i < iterations; i++) {
      for (const fixture of fixtures) endpointCount += provider.parseControllerEndpoints(fixture.file, fixture.source).length;
    }
    return { milliseconds: Number((performance.now() - started).toFixed(2)), endpointCount };
  };
  return { iterations, ast: run(ast), regex: run(regex) };
}

async function compareCachedRepositories(ast, regex) {
  if (process.env.BANK_SPRING_DOCS_SKIP_REAL_REPO_CACHE === "1") {
    return { repositories: [], controllerFiles: 0, astEndpoints: 0, regexEndpoints: 0, shared: 0, astOnly: 0, regexOnly: 0, fallbackFiles: 0 };
  }
  const cacheRoot = path.join(root, ".tmp", "real-repo-validation");
  const result = { repositories: [], controllerFiles: 0, astEndpoints: 0, regexEndpoints: 0, shared: 0, astOnly: 0, regexOnly: 0, fallbackFiles: 0 };
  let config;
  try { config = JSON.parse(await fs.readFile(path.join(root, "test-fixtures", "real-repos.json"), "utf8")); } catch { return result; }

  const targets = config.repos.flatMap((repo) => {
    const repoRoot = path.join(cacheRoot, safeName(repo.name));
    if (repo.type === "spring-be") return [{ name: repo.name, role: "be", root: repoRoot }];
    return ["bff", "be"].map((role) => ({ name: repo.name, role, root: path.join(repoRoot, repo.paths?.[role] ?? "") }));
  });
  for (const target of targets) {
    try { if (!(await fs.stat(target.root)).isDirectory()) continue; } catch { continue; }
    const repoRoot = target.root;
    const scanned = await new RepositoryScanner().scan(repoRoot);
    const controllers = scanned.filter((file) => file.kind === "java" && file.classification === "controller");
    const repo = { name: target.name, role: target.role, controllerFiles: controllers.length, astEndpoints: 0, regexEndpoints: 0, shared: 0, astOnly: 0, regexOnly: 0, fallbackFiles: 0 };
    for (const file of controllers) {
      const astItems = ast.parseControllerEndpoints(file.file, file.content);
      const regexItems = regex.parseControllerEndpoints(file.file, file.content);
      const astKeys = new Set(astItems.map(endpointKey));
      const regexKeys = new Set(regexItems.map(endpointKey));
      repo.astEndpoints += astItems.length;
      repo.regexEndpoints += regexItems.length;
      repo.shared += [...astKeys].filter((key) => regexKeys.has(key)).length;
      repo.astOnly += [...astKeys].filter((key) => !regexKeys.has(key)).length;
      repo.regexOnly += [...regexKeys].filter((key) => !astKeys.has(key)).length;
      if (astItems.some((item) => item.fallbackReason)) repo.fallbackFiles++;
    }
    result.repositories.push(repo);
    for (const key of ["controllerFiles", "astEndpoints", "regexEndpoints", "shared", "astOnly", "regexOnly", "fallbackFiles"]) result[key] += repo[key];
  }
  return result;
}

function endpointKey(endpoint) {
  return `${endpoint.httpMethod} ${normalizePath(endpoint.path)} ${endpoint.handlerMethod}`;
}

function normalizePath(value) {
  return (`/${value || ""}`).replace(/\/+/g, "/").replace(/\{[^}]+\}|:[A-Za-z0-9_]+|\$\{[^}]+\}/g, "{param}").replace(/\/$/, "") || "/";
}

function spikeReport(astEndpoints, regexEndpoints, benchmark, comparison, diagnostics) {
  return `# Tree-sitter Java Endpoint Spike Report\n\nGenerated: ${new Date().toISOString()}\n\n## Scope and Safety\n\n- Scope is limited to Java Spring controller endpoints.\n- Production parser registry and default selection were not changed.\n- DTO/entity, service-call, and repository parsing still delegate to the regex provider.\n- AST failures return explicit diagnostics and a regex fallback instead of stopping the pipeline.\n\n## Dependency Decision\n\n- Compatible pair: tree-sitter 0.21.1 + tree-sitter-java 0.23.5.\n- Packages are development dependencies for the spike. The native binding loaded successfully on Windows x64 / Node ${process.version}.\n- Installed unpacked package sizes measured locally: tree-sitter 2,674,496 bytes; tree-sitter-java 6,223,115 bytes; node-addon-api 417,282 bytes; node-gyp-build 13,864 bytes.\n- The Java grammar peer range is ^0.21.1 and therefore excludes tree-sitter 0.25; the latest core package was intentionally not selected.\n- Official references: https://github.com/tree-sitter/node-tree-sitter and https://github.com/tree-sitter/tree-sitter-java\n\n## Runtime Compatibility\n\n- Native load and parse: PASS on Windows x64 / Node ${process.version}.\n- VS Code installation observed: 1.128.0 on Windows x64.\n- Extension Development Host native-load/package test: NOT RUN. The provider must remain non-production until this is verified because Electron/extension-host ABI and VSIX packaging are separate from the CLI Node test.\n\n## Fixture Results\n\n- AST endpoints: ${astEndpoints.length}\n- Regex endpoints: ${regexEndpoints.length}\n- AST source ranges: ${astEndpoints.filter((item) => item.sourceRange).length}/${astEndpoints.length}\n- AST validation metadata: ${astEndpoints.filter((item) => item.validationAnnotations?.length).length} endpoints\n- AST security metadata: ${astEndpoints.filter((item) => item.securityAnnotations?.length).length} endpoints\n- Multi-path RequestMapping endpoints: ${astEndpoints.filter((item) => item.handlerMethod === "getOrder").length}\n- Controlled AST exception fallback: PASS (regex results retained with explicit reason and diagnostic).\n\n## Micro Benchmark\n\n${benchmark.iterations} iterations across ${2 * benchmark.iterations} fixture parses:\n\n- Tree-sitter: ${benchmark.ast.milliseconds} ms\n- Regex: ${benchmark.regex.milliseconds} ms\n\nThis micro benchmark is directional only; extension-host profiling is still required before production activation.\n\n## Cached Public Repository Comparison\n\n- Controller files: ${comparison.controllerFiles}\n- AST endpoints: ${comparison.astEndpoints}\n- Regex endpoints: ${comparison.regexEndpoints}\n- Shared normalized endpoint keys: ${comparison.shared}\n- AST-only keys: ${comparison.astOnly}\n- Regex-only keys: ${comparison.regexOnly}\n- Files requiring AST-to-regex fallback: ${comparison.fallbackFiles}\n\n## Diagnostics\n\n${diagnostics.warnings.map((warning) => `- ${warning.code}: ${warning.message}`).join("\n")}\n\n## Decision\n\nThe provider remains opt-in and test-only. Promotion requires reviewing AST-only/regex-only samples, adding extension-host packaging tests, and validating latency/memory on larger repositories.\n`;
}

function realRepoReport(comparison) {
  const rows = comparison.repositories.map((repo) => `| ${repo.name} | ${repo.role} | ${repo.controllerFiles} | ${repo.astEndpoints} | ${repo.regexEndpoints} | ${repo.shared} | ${repo.astOnly} | ${repo.regexOnly} | ${repo.fallbackFiles} |`).join("\n") || "| Cached repository bulunamadı | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 |";
  return `# Tree-sitter Real Repository Comparison Report\n\nGenerated: ${new Date().toISOString()}\n\n| Repository | Role | Controllers | AST | Regex | Shared | AST-only | Regex-only | Fallback files |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n## Interpretation\n\nCounts are normalized by HTTP method, parameter-normalized path, and handler name. Differences are evidence for manual review, not proof that either provider is correct. No repository content is sent to an AI service.\n`;
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function readSource(relative) {
  return { file: relative.replace(/^test-fixtures\//, "src/"), source: await fs.readFile(path.join(root, relative), "utf8") };
}
async function writeReport(name, content) {
  if (process.env.BANK_SPRING_DOCS_WRITE_TEST_REPORTS === "0") return;
  const file = path.join(root, ".ai-docs", "dev-audits", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

main().catch((error) => { console.error(error); process.exit(1); });
