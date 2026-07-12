# Bank Spring Docs AI - Next Phase Kickoff

## Previous Recommendations

The existing audits consistently recommend building a measurable compatibility boundary before introducing an AST dependency:

- create a small, checked-in Java, React, evidence, and UI-BFF-BE traceability fixture corpus;
- define schema-compatible Java and React parser-provider contracts;
- expose the current regex extractors as the first/default providers;
- run those providers through a golden test harness and report important-field differences rather than fragile formatting differences;
- add explicit mock boundaries for Qwen HTTP calls and the VS Code Language Model API so automated tests cannot reach real AI services;
- add local-only generated-document quality checks and realistic repository validation diagnostics;
- keep existing JSONL required fields, production defaults, commands, Turkish UI behavior, and regex fallbacks intact;
- measure parser accuracy, package size, Windows compatibility, extension-host loading, and fallback behavior before considering Tree-sitter.

The earlier reliability work also leaves targeted follow-ups: improve React ownership confidence, BFF inbound-to-outbound ownership, graph canonical IDs/provenance, strict diagnostics for required JSONL inputs, evidence source ranges, Qwen response validation, and human calibration of documentation quality scores.

## This Run's Implementation

This run will implement the prompt in incremental, test-gated slices:

1. Add parser-provider types, registries, and diagnostics for Java and React without changing production defaults.
2. Wrap or adapt current regex extraction behavior behind those contracts while preserving existing output schemas; any provenance, parser version, confidence, or warning fields will be optional.
3. Add compact, realistic fixtures for Spring controllers, DTOs/entities, services/repositories, BFF outbound clients, React routes/pages/interactions/API clients, and end-to-end traceability cases.
4. Add expected/golden data and Windows-compatible fixture runners for parser behavior, path matching, ambiguity/unresolved reporting, and bounded evidence selection.
5. Add deterministic Qwen and Copilot test boundaries. Automated tests will use mocks only and will cover success, invalid/failure, cache/audit, context-budget, secret-masking, and available cancellation paths without requiring live AI.
6. Add a real-repository validation runner that is diagnostic and non-fatal when network access or a CLI analyzer wrapper is unavailable. It must not invoke AI or make external cloning part of normal compile/test success.
7. Add a local Markdown document-quality assessment command/script that exits successfully with a clear warning when no generated documents exist.
8. Apply only low-risk extraction, normalization, evidence, scoring, or mock-failure fixes demonstrated by the new tests, then publish the requested comparison and final audit reports.

The live architecture remains three staged systems sharing local JSONL/Markdown artifacts: deterministic single-repo extraction, deterministic multi-repo traceability/graph derivation, and selected-page context/evidence followed by optional Qwen and Copilot stages. New provider/test code should sit beside those paths and must not create a competing production pipeline.

## Exclusions

This run will not:

- install or make Tree-sitter, another AST parser, or a heavy parsing dependency the production default;
- add a database, vector database, remote indexing service, or new persistence architecture;
- send full repositories to Qwen, Copilot, or any other AI service;
- require a live Qwen endpoint, a signed-in Copilot account, network access, or public-repository cloning for automated tests;
- remove, rename, or silently change the behavior contract of an existing command;
- change required fields in existing JSONL schemas; optional diagnostic/provenance fields are the compatibility limit;
- rewrite the two Webviews, perform a broad encoding migration, consolidate the single- and multi-repo pipelines, or redesign graph identity in this phase;
- turn missing optional artifacts or failed external validation into fatal compile/test failures;
- treat fixture success as proof that regex extraction is universally accurate.

## Compile and Test Gates

The prior audited baseline reported `npm run compile`, `npm test`, and `git diff --check` passing. Because the working tree already contains user changes and this run adds multiple independent slices, that historical result is not a substitute for a fresh merged-tree gate.

Required gates:

1. After parser contracts/adapters: `npm run compile`, then `npm test`.
2. After the fixture corpus and golden runners: `npm run compile`, `npm test`, and `npm run test:fixtures`.
3. After AI boundaries: `npm run compile`, `npm test`, `npm run test:qwen-boundary`, and `npm run test:copilot-boundary`; these scripts must be deterministic and must not perform network or VS Code LM requests.
4. After documentation/real-repo diagnostics: run `npm run test:doc-quality`; real-repo validation must warn rather than fail solely because network access is unavailable.
5. After every low-risk production fix: rerun compile, smoke tests, fixture tests, and both AI-boundary suites.
6. Before handoff: run all added npm scripts on Windows, verify readable failure diffs, verify no fixture contains secrets or large repository extracts, run `git diff --check`, and re-check contribution/registration/activation consistency.

A stage that fails its gate should be fixed within that stage or documented and deferred. It must not be hidden by weakening expected outputs or by making an external service mandatory.

## Risk Areas

### Command and activation wiring

The live manifest currently has 62 contributed commands, 63 registrations, and 62 explicit `onCommand` activation events. All contributed commands are registered and activated, with no duplicates. The extra registration, `bankSpringDocs.getSelectedPage`, is an internal Webview/state helper and is intentionally not contributed.

There are nevertheless semantic and maintenance concerns:

- `bankSpringDocs.indexCurrentRepository` is still a scaffold that only shows an information message, unlike the full URL-analysis command.
- `bankSpringDocs.generatePageTechnicalAnalysis` is registered as an alias of `analyzeSelectedPageCommand`; its title suggests final technical-document generation, but it currently builds/opens context and evidence only.
- `multiRepoPhaseNotImplementedCommand` remains exported and imported by `extension.ts` but is not registered or invoked, which is dead architecture residue rather than a missing contribution.
- `onStartupFinished` activates the extension even when no command/view is used. This is functional but makes activation-time cost important when future parsers are added.
- Command registration is centralized in a long `context.subscriptions.push(...)` block, while Webview message dispatch is maintained separately. The current wiring is correct, but future commands can drift without an automated manifest-registration test.

### Parser compatibility

Current extractors are regex/static-scan based and have differing input/output shapes. A provider abstraction can accidentally invent a lowest-common-denominator schema, duplicate extraction logic, or change record ordering. Adapters should reuse current functions, compare stable important fields, and keep fallback decisions per file or symbol.

### Node testability and VS Code coupling

Many orchestration and AI modules import `vscode` directly. Node fixture tests cannot safely load those modules without a boundary or controlled stub. Provider logic and mock clients should keep pure parsing/prompt/cache behavior separate from VS Code UI, configuration, SecretStorage, cancellation, and model selection.

### AI boundary leakage

`QwenClient` directly calls `fetch`, and the current Copilot helper directly calls `vscode.lm.selectChatModels()` and `model.sendRequest()`. Tests must inject deterministic clients before exercising higher-level analyzers. A mock should be the only client reachable in automated tests, and test reports should explicitly confirm that no real endpoint/model call was needed.

### Error masking in local artifacts

`readJsonl` returns an empty array for missing files, malformed JSON lines, permission errors, and genuine empty indexes alike. This supports optional-artifact resilience but can make fixtures and critical pipelines pass with missing or corrupted inputs. Golden runners should fail loudly on their own fixture/expected files and avoid using tolerant reads as assertions.

### Traceability and evidence confidence

Path normalization and ambiguity reporting have improved, but React page ownership still uses normalized substring heuristics, BFF outbound calls may lack reliable source-endpoint ownership, and exact snippets remain regex/brace based. Fixtures must include ambiguous and unresolved cases; expected results should not reward first-candidate selection or broad unrelated evidence.

### Graph and quality interpretation

Graph traceability nodes are not fully canonical with layer nodes, and service/repository/entity depth is partly joined later in page context rather than represented consistently in page flows. Quality scoring is now unknown-aware, but identifier mentions and headings are still proxies for factual correctness. This phase should report those limitations rather than redesign graph identity or overfit scoring weights to synthetic fixtures.

### Existing encoding and dirty-worktree safety

Numerous existing Turkish strings are visibly mojibaked or contain replacement question marks. A broad encoding rewrite is excluded because it is high risk and difficult to validate without UI regression coverage; new user-facing text should preserve Turkish correctly without opportunistically rewriting old strings. The working tree already contains substantial user changes from the previous audit phase, so agents must edit only their assigned files, avoid destructive Git operations, and review overlaps before applying patches.

### External validation portability

Public repositories can change, disappear, use unexpected default branches, exceed Windows path limits, or require build tooling not present locally. Validation output must record commit/branch and limitations when available, use a disposable workspace, avoid AI, and remain diagnostic when cloning or direct analyzer invocation is unavailable.
