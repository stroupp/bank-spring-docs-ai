const path = require("path");
const { spawnSync } = require("child_process");

const scripts = [
  "smoke-tests.js",
  "parser-fixture-tests.js",
  "traceability-fixture-tests.js",
  "evidence-fixture-tests.js",
  "tree-sitter-java-spike-tests.js",
  "qwen-boundary-tests.js",
  "qwen-page-pipeline-tests.js",
  "qwen-gap-repair-tests.js",
  "qwen-only-panel-tests.js",
  "qwen-only-command-tests.js",
  "copilot-boundary-tests.js",
  "copilot-model-selection-tests.js",
  "ai-provider-boundary-tests.js",
  "agentic-run-status-tests.js",
  "deterministic-pipeline-tests.js"
];

for (const script of scripts) {
  console.log(`\n> ${script}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      BANK_SPRING_DOCS_SKIP_REAL_REPO_CACHE: "1",
      BANK_SPRING_DOCS_WRITE_TEST_REPORTS: "0"
    },
    timeout: 120_000,
    stdio: "inherit"
  });
  if (result.error) {
    throw new Error(`${script} could not complete: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nDeterministic test suite passed (${scripts.length} scripts).`);
