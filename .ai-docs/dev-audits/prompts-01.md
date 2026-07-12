You are working inside an existing TypeScript VS Code extension project named **Bank Spring Docs AI**.

You are running through Codex CLI.

The extension already works and must not be broken.

Current project capabilities include:

* Turkish VS Code side panel and Webview UI
* single Spring Boot repository analysis
* React UI + Spring BFF + Spring BE multi-repo analysis
* UI → BFF → BE traceability
* local knowledge graph artifacts
* Qwen semantic enrichment
* Copilot document generation through VS Code Language Model API
* page-level technical analysis
* focused source evidence packs
* gap detection
* gap repair
* final page technical analysis documents
* document quality scoring
* developer audit reports

The previous audit recommended:

* build parser/traceability fixture corpus
* add parser provider interfaces
* run current regex providers through a golden test harness
* add real-repo validation
* add documentation quality assessment
* add explicit Qwen/Copilot test boundaries
* do not install Tree-sitter yet

# Important Rules

Do not break existing functionality.

Do not remove or rename existing commands.

Do not change existing output schemas unless adding optional fields.

Do not install Tree-sitter yet.

Do not add a database or vector database.

Do not send full repositories to Qwen or Copilot.

Do not require real Qwen or real Copilot calls in automated tests.

Do not rewrite the whole project.

Do not make risky UI refactors.

Keep Turkish UI strings intact.

Keep all changes incremental.

Run compile/tests after every meaningful stage.

If something is too risky, write it into an audit file instead of implementing it.

# Multi-Agent Mode

Work as if there are several specialized agents. If Codex CLI supports multiple agents/subtasks, split work among them. If not, simulate these agents sequentially.

Use these roles:

## Agent 1 — Orchestrator

Responsibilities:

* coordinate the full run
* decide implementation order
* enforce compile/test gates
* keep changes incremental
* write final summary

## Agent 2 — Architecture Auditor

Responsibilities:

* read existing audit files
* inspect current architecture
* verify command registration
* verify pipeline flow
* identify fragile areas before coding

## Agent 3 — Fixture Engineer

Responsibilities:

* create checked-in parser and traceability fixtures
* add Java Spring fixtures
* add React TSX fixtures
* add BFF outbound call fixtures
* add BE service/repository fixtures
* add expected output golden files

## Agent 4 — Parser Contract Engineer

Responsibilities:

* define parser provider interfaces
* wire existing regex extractors into providers
* keep output compatible with current JSONL schemas
* create parser comparison reports

## Agent 5 — Traceability QA Engineer

Responsibilities:

* test UI API → BFF endpoint matching
* test BFF outbound → BE endpoint matching
* test path normalization
* test ambiguous matches
* test unresolved match reporting

## Agent 6 — Evidence QA Engineer

Responsibilities:

* test page evidence selection
* test exact React handler snippets
* test exact API client snippets
* test Java endpoint/service/repository snippets
* ensure evidence packs stay relevant and bounded

## Agent 7 — AI Boundary QA Engineer

Responsibilities:

* add Qwen mock boundary tests
* add Copilot mock boundary tests
* ensure automated tests do not call real Qwen or real Copilot
* define manual diagnostics for real AI calls

## Agent 8 — Documentation QA Engineer

Responsibilities:

* run local generated doc checks where possible
* inspect gap detection and quality score behavior
* assess generated-document structure without requiring AI calls
* produce document quality assessment reports

## Agent 9 — Real Repo Validation Engineer

Responsibilities:

* prepare reliable public repo validation config
* clone/use real repos when network is available
* fall back gracefully if network is unavailable
* validate analyzers on realistic projects where possible

# Phase 0 — Read Existing Audit State

First read these files if they exist:

```text
.ai-docs/dev-audits/full-project-architecture-audit.md
.ai-docs/dev-audits/compile-health-check.md
.ai-docs/dev-audits/page-pipeline-reliability-audit.md
.ai-docs/dev-audits/evidence-precision-enhancement.md
.ai-docs/dev-audits/traceability-graph-audit.md
.ai-docs/dev-audits/gap-repair-hardening.md
.ai-docs/dev-audits/quality-scoring-audit.md
.ai-docs/dev-audits/ast-extraction-roadmap.md
.ai-docs/dev-audits/codex-cli-final-summary.md
```

Then create:

```text
.ai-docs/dev-audits/next-phase-kickoff.md
```

Include:

* what previous audits recommended
* what this run will implement
* what will not be implemented
* compile/test gates
* risk areas

# Phase 1 — Parser Provider Abstraction

Implement parser-provider interfaces without installing Tree-sitter.

Create a small abstraction layer that allows future AST parsers to be plugged in.

Suggested files:

```text
src/parser/
  parserProviderTypes.ts
  parserProviderRegistry.ts
  parserProviderDiagnostics.ts

src/parser/java/
  javaParserProviderTypes.ts
  regexJavaParserProvider.ts

src/parser/react/
  reactParserProviderTypes.ts
  regexReactParserProvider.ts
```

If the existing structure already has better locations, follow it.

The provider interfaces should support current outputs without breaking schemas.

For Java, support provider methods such as:

```ts
parseControllerEndpoints(filePath: string, source: string): ParsedJavaEndpoint[];
parseDtoOrEntity(filePath: string, source: string): ParsedJavaModel[];
parseServiceMethods(filePath: string, source: string): ParsedJavaServiceMethod[];
parseRepositoryMethods(filePath: string, source: string): ParsedJavaRepositoryMethod[];
```

For React, support provider methods such as:

```ts
parseRoutes(filePath: string, source: string): ParsedReactRoute[];
parseComponents(filePath: string, source: string): ParsedReactComponent[];
parseInteractions(filePath: string, source: string): ParsedReactInteraction[];
parseApiCalls(filePath: string, source: string): ParsedReactApiCall[];
parseFormFields(filePath: string, source: string): ParsedReactFormField[];
parseStateUsage(filePath: string, source: string): ParsedReactStateUsage[];
```

Important:

* Existing regex logic should become the first provider.
* Do not change production defaults.
* Do not require Tree-sitter.
* Optional future fields are allowed, but existing JSONL schemas must remain valid.
* Add provider diagnostics so comparison reports can show parser name, version, confidence, and warnings.

Run:

```bash
npm run compile
npm test
```

# Phase 2 — Fixture Corpus

Create checked-in fixtures.

Use a folder such as:

```text
test-fixtures/
  java-spring/
    controllers/
    dto-entity/
    service-repository/
    bff-outbound/
  react/
    routes/
    pages/
    interactions/
    api-clients/
  traceability/
    ui-bff-be/
  ai-boundary/
    qwen/
    copilot/
  expected/
    java/
    react/
    traceability/
    ai-boundary/
```

Do not put huge files here. Keep fixtures small but realistic.

## Java Controller Fixtures

Create fixtures that exercise:

* single-line mappings
* multi-line mappings
* nested annotation arguments
* class-level `@RequestMapping`
* method-level `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`
* `@RequestParam(defaultValue = "...")`
* `@PathVariable`
* `@RequestBody`
* `@Valid`
* `Pageable`
* headers
* response types
* generic response wrappers
* security annotations if current analyzer supports them

Example fixture concepts:

* LoginController
* CustomerSearchController
* ProductInventoryController
* OrderController

## DTO/Entity Fixtures

Create fixtures that exercise:

* Lombok annotations
* validation annotations
* nested DTO fields
* enums
* `@Entity`
* `@Table`
* `@Id`
* `@Column`
* relations such as `@ManyToOne`
* DTO names like Request, Response, Dto, Command, Query

## Service/Repository Fixtures

Create fixtures that exercise:

* controller → service call
* service → repository call
* service → outbound client call
* custom repository methods
* `findBy...`
* `@Query`
* overloaded service methods if safe
* transaction annotation

## React Fixtures

Create fixtures that exercise:

* React Router `<Route path="" element={...} />`
* route arrays
* page component with subcomponents
* button `onClick`
* form `onSubmit`
* inline handler
* named handler
* `useState`
* `react-hook-form` style `Controller name=""`
* `input name=""`
* `TextField name=""`
* `axios.get/post`
* `fetch`
* `apiClient`
* typed API wrapper like `customerApi.searchCustomers(params)`
* React Query `useQuery`
* mutation style API call

## Traceability Fixtures

Create fixture data for:

```text
UI API call -> BFF endpoint -> BFF outbound client -> BE endpoint -> BE service -> repository/entity
```

Include:

* exact path match
* prefix match
* path variables
* ambiguous match
* unresolved match

Write expected JSON files under `test-fixtures/expected`.

# Phase 3 — Golden Test Harness

Add a test harness that runs current regex providers against fixtures and compares output to expected outputs.

Suggested files:

```text
scripts/parser-fixture-tests.js
scripts/traceability-fixture-tests.js
scripts/evidence-fixture-tests.js
```

Or integrate with the existing smoke test script if that is simpler.

Add npm scripts if appropriate:

```json
{
  "test:fixtures": "node scripts/parser-fixture-tests.js && node scripts/traceability-fixture-tests.js && node scripts/evidence-fixture-tests.js"
}
```

The tests should:

* run current parser providers on fixtures
* compare important fields, not fragile exact formatting
* print readable differences
* write reports under:

```text
.ai-docs/dev-audits/fixture-test-report.md
.ai-docs/dev-audits/parser-comparison-report.md
.ai-docs/dev-audits/traceability-fixture-report.md
.ai-docs/dev-audits/evidence-fixture-report.md
```

Do not make the tests impossibly strict. They should catch major regressions.

Run:

```bash
npm run compile
npm test
npm run test:fixtures
```

If `npm run test:fixtures` is added, ensure it works on Windows.

# Phase 4 — Explicit AI Boundary Tests

Automated tests must not call real Qwen or real Copilot.

Real Qwen and real Copilot should stay manual diagnostics only.

## Copilot Boundary

The extension uses VS Code Language Model API for real Copilot calls, so normal Codex CLI / Node tests should not depend on real Copilot.

Add or verify an abstraction around Copilot.

If a suitable abstraction exists, reuse it. If not, add one:

```ts
export interface ICopilotClient {
  send(prompt: string, options: CopilotRequestOptions): Promise<CopilotResponse>;
}
```

Keep the real implementation:

```text
RealCopilotClient
→ uses vscode.lm.selectChatModels()
→ uses model.sendRequest()
```

Add a mock implementation for tests:

```text
MockCopilotClient
→ returns deterministic Markdown
→ does not call vscode.lm
```

Automated tests should verify:

* Copilot context pack is generated
* context pack is under configured budget
* secrets are masked
* selected page information exists
* source evidence exists
* Qwen semantics are included when available
* BFF/BE traceability is included
* Copilot audit record is written
* success status is recorded with mock output
* failure status is recorded when mock client throws
* cancellation/timeout path is handled if supported
* final document can be built from mock Copilot draft
* gap detection can run on mock Copilot draft
* quality score can run on mock final document

Create or update:

```text
scripts/copilot-boundary-tests.js
```

Optional npm script:

```json
{
  "test:copilot-boundary": "node scripts/copilot-boundary-tests.js"
}
```

The test must not call real Copilot.

## Qwen Boundary

Qwen is HTTP-based, but automated tests should still not require a live Qwen endpoint.

Add or verify an abstraction around Qwen.

If a suitable abstraction exists, reuse it. If not, add one:

```ts
export interface IQwenClient {
  send(prompt: string, options: QwenRequestOptions): Promise<QwenResponse>;
  testConnection?(): Promise<QwenConnectionResult>;
}
```

Keep the real implementation:

```text
RealQwenClient
→ calls configured Qwen endpoint
```

Add a mock implementation for tests:

```text
MockQwenClient
→ returns deterministic strict JSON
→ does not make HTTP calls
```

Automated tests should verify:

* Qwen page semantic prompt is built
* Qwen interaction semantic prompt is built
* Qwen output strict JSON is parsed
* invalid Qwen JSON is handled gracefully
* raw invalid output is saved to debug folder if current behavior supports this
* Qwen cache hit works
* Qwen cache miss works
* Qwen semantic files are written
* page context/evidence are included in Qwen prompt
* Qwen failures do not crash the full page pipeline

Create or update:

```text
scripts/qwen-boundary-tests.js
```

Optional npm script:

```json
{
  "test:qwen-boundary": "node scripts/qwen-boundary-tests.js"
}
```

The test must not call real Qwen.

## AI Boundary Test Report

Create:

```text
.ai-docs/dev-audits/ai-boundary-test-report.md
```

Include:

```text
# AI Boundary Test Report

## Copilot Boundary
- abstraction status
- mock test status
- what was tested
- what remains manual

## Qwen Boundary
- abstraction status
- mock test status
- what was tested
- what remains manual

## Real AI Calls
Confirm automated tests did not require real Qwen or real Copilot.

## Remaining Risks
List limitations.
```

## Manual AI Integration Test Plan

Create:

```text
.ai-docs/dev-audits/ai-integration-test-plan.md
```

Include manual steps:

```text
# AI Integration Test Plan

## Real Qwen Test
1. Open Qwen settings.
2. Enter local or DashScope-compatible endpoint.
3. Click Qwen connection test.
4. Run Qwen page semantics for one selected page.
5. Verify qwen-page-semantics.json exists.
6. Verify no full repo source was sent.

## Real Copilot Test
1. Launch Extension Development Host with F5.
2. Run Copilot diagnostics command.
3. Generate one selected-page Copilot draft.
4. Verify Copilot audit log contains model info.
5. Verify copilot-draft.md exists.
6. Verify context pack was saved.
```

Run if scripts were added:

```bash
npm run compile
npm test
npm run test:qwen-boundary
npm run test:copilot-boundary
```

# Phase 5 — Real Repo Validation Plan

Add a real-repo validation runner or at least a documented script.

Important: If external network is unavailable, do not fail the project. Use fixtures as fallback.

Create:

```text
scripts/real-repo-validation.js
```

The script should support a config file such as:

```text
test-fixtures/real-repos.json
```

Example config:

```json
{
  "workspace": ".tmp/real-repo-validation",
  "repos": [
    {
      "name": "inventory-management-API",
      "type": "spring-be",
      "url": "https://github.com/Sebaspallero/inventory-management-API.git",
      "branch": "main",
      "description": "Real-life inventory management Spring Boot backend"
    },
    {
      "name": "rbac-ums",
      "type": "ui-bff-be-monorepo",
      "url": "https://github.com/mpiumakkho/rbac-ums.git",
      "branch": "main",
      "paths": {
        "ui": "frontend",
        "bff": "web-api",
        "be": "core-api"
      },
      "description": "React UI + Spring BFF + Spring backend structure"
    },
    {
      "name": "bff-spring-keycloak-react-demo",
      "type": "ui-bff-be-monorepo",
      "url": "https://github.com/HQT-Team/bff-spring-keycloak-react-demo.git",
      "branch": "main",
      "paths": {
        "ui": "backoffice",
        "bff": "backoffice-bff",
        "be": "product"
      },
      "description": "Java 17 Spring BFF + React + backend demo"
    }
  ]
}
```

The script should:

* clone or update repos into temporary validation workspace
* avoid long path issues on Windows if possible
* run available local analyzers if they can be invoked outside VS Code
* if direct invocation is not currently possible, create a report explaining what wrapper is missing
* never require Qwen or Copilot
* never send repo code to AI
* write output to:

```text
.ai-docs/dev-audits/real-repo-validation-report.md
```

For now, validation can be partly diagnostic. It is acceptable if it identifies that some analyzers need CLI-accessible wrappers.

Do not let failed external clones break compile/test.

# Phase 6 — Documentation Quality Assessment Harness

Add a local-only documentation quality assessment harness.

Goal:
Assess generated Markdown documents without Qwen/Copilot.

Create or improve:

```text
scripts/document-quality-check.js
```

It should inspect generated Markdown files and report:

* required section presence
* source references count
* unresolved “Not visible” / “Provided context içinde net görünmüyor” count
* empty sections
* duplicate sections
* API endpoint mentions
* BFF/BE flow mentions
* repository/entity mentions
* diagram presence if any
* quality score file consistency if present

Write:

```text
.ai-docs/dev-audits/document-quality-assessment-report.md
```

If no generated docs exist, the script should say so and exit successfully with a warning.

Add npm script if appropriate:

```json
{
  "test:doc-quality": "node scripts/document-quality-check.js"
}
```

Run it.

# Phase 7 — Safe Enhancements from Findings

After fixture tests, AI boundary tests, and quality reports exist, implement only low-risk improvements discovered by tests.

Prioritize:

* path normalization bugs
* missing default value extraction
* missing `@PathVariable` or `@RequestParam` metadata
* React handler extraction gaps
* API client path extraction gaps
* evidence over-selection
* false quality score positives
* missing AI mock failure handling

Do not implement Tree-sitter yet.

After each fix:

* run compile
* run smoke tests
* run fixture tests
* run AI boundary tests
* update audit report

# Phase 8 — Multi-Agent Final Report

Create:

```text
.ai-docs/dev-audits/multi-agent-enhancement-final-report.md
```

Include:

```text
# Multi-Agent Enhancement Final Report

## Agents / Roles Used
Summarize the simulated or actual agents.

## Files Changed
List changed files.

## New Test Fixtures
List fixture categories.

## New Test Scripts
List scripts and npm commands.

## Parser Provider Contract
Explain the new abstraction.

## Fixture Test Results
Summarize results.

## Qwen Boundary Test Results
Summarize mock Qwen tests and what remains manual.

## Copilot Boundary Test Results
Summarize mock Copilot tests and what remains manual.

## Real Repo Validation
Summarize whether public repo validation was run, skipped, or partially completed.

## Documentation Quality Assessment
Summarize findings.

## Fixes Implemented
List fixes.

## Compile/Test Status
Include:
- npm run compile
- npm test
- npm run test:fixtures
- npm run test:qwen-boundary
- npm run test:copilot-boundary
- npm run test:doc-quality

## Remaining Risks
List remaining risks.

## Recommended Next Phase
Recommend the next specific phase.
```

# Final Terminal Response

At the end, print a concise summary:

```text
Completed multi-agent enhancement phase.
Compile: pass/fail
Smoke tests: pass/fail
Fixture tests: pass/fail/warn
Qwen boundary tests: pass/fail/warn
Copilot boundary tests: pass/fail/warn
Doc quality check: pass/fail/warn
Reports written under .ai-docs/dev-audits/
Next recommended prompt: Tree-sitter Java endpoint parser spike with fixture comparison, no production default change.
```

# Suggested Next Phase After This Prompt

Do not implement now, but prepare for:

```text
Tree-sitter Java endpoint parser spike with fixture comparison.
```

That future phase should:

* install candidate parser only after package-size and Windows compatibility check
* run against fixtures
* compare AST output vs regex output
* not become production default until it proves better
