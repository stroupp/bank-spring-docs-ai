# Bank Spring Docs AI - Full Project Architecture Audit

## Project Purpose

Bank Spring Docs AI is a local-first VS Code extension that turns Spring Boot and React UI-BFF-BE source repositories into auditable technical documentation. It clones or reads repositories locally, builds compact JSONL indexes, creates deterministic Markdown documents, optionally enriches those indexes with a locally configured Qwen endpoint, and uses the VS Code Language Model API for source-grounded Copilot narratives. Full repositories are not sent to AI; the AI paths use selected indexes, focused snippets, and bounded context packs.

The extension supports two scopes:

- a single Spring Boot repository, including structure, endpoints, components, entities, configuration, tests, semantic enrichment, and local/Copilot documents;
- a three-repository system composed of React UI, Spring BFF, and Spring backend, including cross-layer matching, page flows, a local knowledge graph, selected-page evidence, gap repair, and document quality scoring.

## High-Level Architecture

```text
VS Code commands / Turkish Webviews
        |
        +-- Git + local storage
        |
        +-- Deterministic scanners and extractors
        |      +-- Spring/Java indexes
        |      +-- React indexes
        |      +-- BFF/BE flow indexes
        |
        +-- Cross-repository derivation
        |      +-- UI -> BFF matching
        |      +-- BFF -> BE matching
        |      +-- page flows
        |      +-- local graph and quality report
        |
        +-- Page analysis
        |      +-- page context
        |      +-- exact + fallback evidence
        |      +-- Qwen semantics
        |      +-- Copilot draft
        |      +-- gap detection/repair
        |      +-- final document and quality score
        |
        +-- Local or AI-assisted documentation
               +-- deterministic Markdown
               +-- Qwen JSON semantics
               +-- Copilot Markdown + audit artifacts
```

Main source modules:

- `src/extension.ts`: activation and command registration.
- `src/views/`: the activity-bar Webview view and standalone panel, including Turkish UI and message dispatch.
- `src/commands/`: thin orchestration around analyzers and generators.
- `src/analyzer/`: Java/Spring, React, BFF, backend, traceability, and quality extractors.
- `src/multirepo/`: multi-repository manifest, Git, local analysis, traceability, and quality orchestration.
- `src/pageanalysis/`: page selection, page context, semantics, draft, freshness, repair, finalization, and scoring.
- `src/evidence/`: page evidence file selection and focused source snippet extraction.
- `src/graph/`: local JSONL knowledge graph generation.
- `src/semantic/`: Qwen-backed semantic analysis and caches.
- `src/docs/`: deterministic, single-request Copilot, and multi-step agentic document generation.
- `src/ai/`: prompts, Copilot/Qwen clients, masking, token estimates, settings, and audit logging.
- `src/storage/`, `src/git/`, `src/utils/`: JSONL, manifests, extension state, filesystem paths, hashing, logging, and safe process execution.

The project contains about 13,500 TypeScript/JavaScript source lines. Its largest maintenance hotspots are the two Webview files, the agentic generators, evidence/snippet logic, local document templates, prompt definitions, and command orchestrators.

## Command Flow

The extension contributes 61 commands and registers all of them. `bankSpringDocs.getSelectedPage` is an internal registered helper and is not contributed to the command palette.

Important command families:

- Repository acquisition and indexing:
  - `analyzeRepositoryUrl` -> `AnalyzeRepositoryUrlCommand` -> Bitbucket URL parsing -> `GitService` -> `RepositoryScanner` -> Spring extractors -> JSONL/repo-map/manifest -> all local documents.
  - `indexCurrentRepository` is currently a placeholder-style command and does not perform the same full indexing flow.
- Deterministic documents:
  - individual `generate*Documentation` commands -> `generateLocalDocCommand` -> `LocalDocumentationGenerator`.
  - `generateAllLocalDocs` -> all ten local document kinds + analysis quality report.
- Single-repo AI:
  - `generateCopilot*` -> `CopilotDocumentationGenerator` -> document-specific context -> preview -> VS Code LM -> Markdown + audit.
  - `generateAgenticCopilotBackendDocs` -> six sequential Copilot steps with intermediate artifacts.
  - Qwen commands -> settings/test -> class, endpoint, and dependency semantic analyzers -> enriched repo map.
- Multi-repo:
  - save manifest -> clone/update -> analyze BFF/BE -> analyze React UI -> build traceability -> Qwen page semantics -> local graph -> multi-repo quality report -> optional multi-step Copilot synthesis.
- Selected-page analysis:
  - build page list/select page -> page context/evidence -> selected-page Qwen -> Copilot draft -> gap detection -> gap repair -> final document -> quality score.
  - `runFullSelectedPageAnalysis` orchestrates the complete selected-page sequence.
- Inspection/maintenance:
  - open repo map, generated docs, context, prompt, audit log, unresolved matches, multi-repo output, and clear local cache.

Manifest observations:

- All contributed commands are registered.
- `openRepoMap` and `openGeneratedDocs` are contributed but not listed as explicit `onCommand` activation events. Since the extension also activates on startup and modern VS Code derives activation from contributions, this is not currently breaking, but the manifest is inconsistent.

## UI Flow

There are two closely related Webview implementations:

- `BankSpringDocsViewProvider` supplies the activity-bar side panel and contains the broadest workflow: repository analysis, local/Copilot documents, Qwen settings, multi-repo actions, model selection, and selected-page analysis.
- `BankSpringDocsPanel` supplies a standalone panel and duplicates a substantial amount of HTML, CSS, JavaScript, settings handling, and status behavior.

Both Webviews post typed messages back to the extension. The provider dispatches messages to commands, posts busy/done/error states, reloads manifest/page state, and exposes the selected Copilot model. Turkish labels and operational messages are embedded in the Webview templates and command handlers.

The UI is functional but expensive to maintain because two large inline Webviews duplicate structure and behavior. Future work should extract shared template helpers or a common message contract without rewriting the UI.

## Single Repo Pipeline

1. The user provides a Bitbucket HTTPS/SSH URL and branch.
2. `parseBitbucketUrl` derives repository identity and a safe local folder.
3. `GitService.cloneOrUpdate` performs shallow clone or fetch/checkout/pull without shell interpolation.
4. `LocalStorageService` creates `.ai-docs`, summary, context, and document folders.
5. `RepositoryScanner` recursively reads selected Java, build, and Spring configuration files while ignoring build/cache folders.
6. Regex-based extractors produce:
   - Spring components and dependency injection hints;
   - endpoints, parameters, request/response types;
   - JPA entities and relationships;
   - import dependency edges;
   - configuration keys;
   - tests and framework hints;
   - a package-derived module map.
7. JSONL files, `repo-map.md`, and `manifest.json` are written.
8. `AnalysisStateService` records the last analysis in VS Code global state.
9. All deterministic local documents are generated from the indexes.

The pipeline is intentionally lightweight and dependency-free, but Java parsing is predominantly regex based. Multiline annotations, nested types, records, Lombok-heavy DTOs, meta-annotations, aliased imports, and complex method bodies can be missed or misclassified.

## Multi-Repo Pipeline

The multi-repo manifest stores project name, shared branch, UI/BFF/BE URLs, local paths, statuses, and update time. Repositories are cloned below a project-specific `mr` directory while derived artifacts live under `.ai-docs/multi-repo`.

- React analysis scans TS/TSX/JS/JSX and emits file, route, page, component, interaction, API call, form-field, and state indexes plus a React repo map.
- BFF analysis reuses Spring extraction and adds outbound client calls, DTOs, and BFF flow records.
- Backend analysis adds Java method calls, service flows, repository methods, DTOs, validations, exceptions, entities, and configuration/test data.
- `UiToBffMatcher` matches normalized HTTP method/path pairs.
- `BffToBeMatcher` prefers outbound-call-to-backend matches and otherwise falls back to endpoint-to-endpoint matching.
- `PageFlowBuilder` associates UI calls with page/interaction/route context and linked BFF/BE endpoints.
- unresolved matches and Markdown/JSON traceability reports are written.
- `LocalKnowledgeGraphBuilder` converts indexes and matches into local node/edge JSONL files.
- `MultiRepoQualityReportGenerator` evaluates artifact presence, counts, unresolved/partial flows, and graph density.

The graph is a derived file representation rather than a graph database. That preserves local-first operation and keeps the format inspectable.

## Page-Level Pipeline

1. `PageListService` combines page, route, component, API-call, and page-flow indexes into selectable candidates.
2. `SelectedPageStateService` stores the chosen page in VS Code workspace state.
3. `PagePipelineFreshnessService` checks required base artifacts and regenerates traceability, graph, and multi-repo quality outputs when derived artifacts are missing/stale.
4. `PageContextPackBuilder` filters cross-layer indexes to the selected page and writes `page-flow.json` plus `page-context-pack.md`.
5. `EvidencePackBuilder` selects exact snippets and bounded broad fallback source files, grouping evidence by layer and recording uncertainty.
6. `QwenPageSemanticAnalyzer` optionally produces page and interaction JSON semantics with a prompt/model/content-addressed cache.
7. `CopilotPageDraftGenerator` builds a bounded, masked context and writes context, prompt, draft, and Copilot audit records.
8. `PageDocGapDetector` checks the draft for required Turkish sections, uncertainty language, and source-reference gaps.
9. `PageSectionRegenerator` asks Copilot to rewrite only weak sections using repair context.
10. `FinalPageDocumentBuilder` merges repaired sections into the draft, backs up a previous final file, and writes the final page technical analysis.
11. `PageDocumentQualityScorer` scores structure, references, gaps, cross-layer coverage, semantics, evidence presence, length, and freshness.

The page pipeline is the most mature source-grounded path in the extension. It already distinguishes deterministic context, exact evidence, semantic interpretation, generative drafting, repair, and scoring. Its main risks are timestamp-only freshness, broad substring ownership matching, best-effort regex snippets, and optimistic scores when denominators are absent.

## Qwen Integration

- `QwenSettingsService` reads/writes endpoint, model, temperature, token limit, timeout, enabled state, and API-key usage from VS Code settings; API keys are stored in SecretStorage.
- `QwenClient` calls an OpenAI-compatible chat-completions endpoint using `fetch`, supports cancellation and timeouts, and normalizes common local/cloud endpoint shapes.
- single-repo semantic analyzers process selected classes, endpoints, and dependency edges, parse strict JSON, and store content-addressed cached outputs.
- multi-repo semantics analyze UI interactions and page flows.
- selected-page semantics combine page context and evidence, cache the page result and per-interaction results, and write JSON/JSONL artifacts.

Strengths are local configurability, secret storage, deterministic prompt versioning, and caching. Weaknesses include limited output schema validation, per-item failures that can become silent counts, and no common artifact metadata envelope.

## Copilot Integration

- `ContextPackBuilder` selects document-specific local indexes and applies a character budget.
- `safeContextFilter` masks common secret assignments, bearer tokens, and private keys.
- `CopilotDocumentationGenerator` writes context-selection audits, context/prompt packs, optionally asks the user to preview, calls the VS Code LM API, and records model/usage/status metadata.
- model selection honors the configured model ID, otherwise choosing the first available VS Code model.
- agentic generators run six focused sequential requests for a backend or multi-repo system and persist every context, prompt, output, summary, and audit record.
- selected-page generation has separate draft and repair requests, with bounded context and freshness checks.

The Copilot integration is notably auditable. Remaining weaknesses are character-based budgeting instead of model-aware preflight limits, inconsistent preview behavior between generators, incomplete failure audits in some page/agentic paths, and the possibility that early sections consume the whole context budget.

## Artifacts

Important single-repo outputs:

```text
.ai-docs/
  manifest.json
  file-index.jsonl
  spring-components.jsonl
  api-endpoints.jsonl
  entity-index.jsonl
  dependency-graph.jsonl
  configuration-index.jsonl
  test-index.jsonl
  module-map.json
  repo-map.md
  analysis-report.{md,json}
  generated-docs/*.md
  enriched/*
  semantic/*
  context-packs/*
  audit/copilot-requests.jsonl
  copilot-workspace/agentic/*
```

Important multi-repo/page outputs:

```text
.ai-docs/multi-repo/
  manifest.json
  ui/*.jsonl
  bff/*.jsonl
  be/*.jsonl
  traceability/{ui-to-bff,bff-to-be,page-flows,unresolved-matches}.jsonl
  traceability/traceability-report.{md,json}
  graph/{nodes,edges}.jsonl
  graph/graph-summary.{md,json}
  quality/multi-repo-quality-report.{md,json}
  quality/page-document-quality.jsonl
  page-analysis/pages/<page>/
    page-flow.json
    page-context-pack.md
    page-evidence-pack.md
    qwen-page-semantics.json
    qwen-interaction-semantics.jsonl
    copilot-draft-context-pack.md
    copilot-draft-prompt.md
    copilot-draft.md
    detected-gaps.json
    repaired-context-pack.md
    repaired-sections.md
    final-page-technical-analysis.md
    quality-score.json
    output-freshness.json
```

## Current Strengths

- Local-first and inspectable: no database, vector database, or hidden server-side state.
- Clear separation between deterministic facts, semantic enrichment, and generative narrative.
- Bounded context packs instead of full-repository AI submission.
- Secret masking, SecretStorage for Qwen keys, and user-preview support.
- JSONL schemas are simple, debuggable, and resilient to incremental optional fields.
- Cross-layer confidence and unresolved-match concepts already exist.
- Page analysis preserves context, evidence, prompt, draft, repair, final, quality, and freshness artifacts.
- Git subprocesses use argument arrays with `shell: false`.
- The project compiles under strict TypeScript and the existing smoke suite passes.
- Existing functionality is modular enough to add AST providers behind current schemas later.

## Current Weaknesses

- Regex extractors are the primary accuracy ceiling for both Java and React.
- Several scanners are sequential and read full relevant files into memory; large monorepos will be slow.
- The single-repo and multi-repo Spring analysis paths duplicate orchestration.
- Two large inline Webviews duplicate UI and message behavior.
- Artifact freshness mostly uses modification times; source hashes and a shared metadata envelope are inconsistent.
- Some JSONL reads intentionally return empty arrays for missing files, which helps resilience but can hide missing prerequisites unless a separate freshness check runs.
- Traceability picks the first exact/suffix match and does not represent ambiguity or candidate ranking.
- Page ownership uses normalized substring matching and can over-associate short names.
- The graph creates useful nodes but many relationship types are still missing, and some traceability nodes duplicate canonical layer nodes.
- Quality scoring contains heuristic text checks and can award perfect coverage when source denominators are zero.
- Gap detection only parses level-two sections and may treat nested/variant headings inaccurately.
- Page Qwen/Copilot/repair paths do not use one shared run manifest or consistent failure audit envelope.
- Character budgets do not reserve space per evidence priority or compare the final request with the selected model limit before sending.
- Existing smoke tests cover only a small fraction of extractors, matchers, Webview messaging, error cases, and full pipeline orchestration.
- README content describes the original MVP more than the current multi-repo/page feature set.

## Recommended Next Phases

1. Stabilize page artifacts: shared metadata, hashes where cheap, warning-only freshness checks, prerequisite validation, and consistent error/audit behavior.
2. Improve evidence precision: explicit ranked evidence candidates, exact route/handler/client/service/repository snippets, group-specific budgets, and bounded fallbacks.
3. Make scoring truthful: unknown metrics must not become automatic success; add metric explanations and freshness deductions.
4. Strengthen traceability incrementally: normalized paths, candidate/ambiguity reporting, service/outbound ownership, and canonical graph edges.
5. Build a fixture-based parser test corpus for Java and React before adding AST dependencies.
6. Introduce parser interfaces and schema-compatible AST providers, keeping regex fallback.
7. Reduce orchestration duplication and extract shared Webview contracts only after pipeline behavior is covered by tests.
8. Update README and add a developer audit command after the reliability work is stable.

Tree-sitter should not be introduced until fixture-based regression tests, parser interfaces, and output compatibility rules are in place.
