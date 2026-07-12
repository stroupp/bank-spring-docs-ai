const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const { normalizeHttpPath } = require("../dist/analyzer/traceability/pathNormalizer");
const { UiToBffMatcher } = require("../dist/analyzer/traceability/uiToBffMatcher");
const { BffToBeMatcher } = require("../dist/analyzer/traceability/bffToBeMatcher");
const { UnresolvedMatchReporter } = require("../dist/analyzer/traceability/unresolvedMatchReporter");

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

  await report(`# Traceability Fixture Report\n\nGenerated: ${new Date().toISOString()}\n\n## Coverage\n\n- Exact UI to BFF matches: ${uiToBff.filter((item) => item.confidence === "high").length}\n- Ambiguous path-variable matches: ${uiToBff.filter((item) => item.confidence === "low").length}\n- Unmatched UI calls: ${uiToBff.filter((item) => item.confidence === "unmatched").length}\n- BFF outbound to BE records: ${bffToBe.length}\n- Unresolved records: ${unresolved.length}\n\nPath variables in colon, Spring brace, template literal, and named-brace forms normalize to \`/customers/{param}\`. Missing leading slashes normalize safely. Ambiguous and unmatched records remain explicit.\n\nResult: PASS.\n`);
  console.log("Traceability fixture tests passed.");
}

function subset(actual, expected) { return Object.entries(expected).every(([key, value]) => actual[key] === value); }
async function json(relative) { return JSON.parse(await fs.readFile(path.join(root, relative), "utf8")); }
async function report(content) { const file = path.join(root, ".ai-docs", "dev-audits", "traceability-fixture-report.md"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, "utf8"); }
main().catch((error) => { console.error(error); process.exit(1); });
