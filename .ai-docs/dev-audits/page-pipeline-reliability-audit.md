# Page Pipeline Reliability Audit

## Pipeline Reviewed

```text
selected page
  -> context pack + page-flow.json
  -> evidence pack
  -> optional Qwen semantics
  -> Copilot draft
  -> gap detection
  -> optional gap repair
  -> final page document
  -> quality score/report
```

The review covered command prerequisites, selected-page state, derived-artifact refresh, output dependencies, context budgets, secret masking, AI failure handling, output directories, audit records, merge behavior, and score semantics.

## Finding PPR-001

Severity: high  
Area: freshness

Problem: `ensurePagePipelineFreshness` warns when required base indexes are missing but callers continue building the page context and evidence.

Why it matters: a successful-looking page run can be generated from empty JSONL reads. This produces a polished but incomplete document and makes later quality metrics difficult to trust.

Evidence from code: `PagePipelineFreshnessService.ensure` reports missing required UI/BFF/BE artifacts as high severity. `analyzeSelectedPageCommand` and `runFullSelectedPageAnalysisCommand` await the helper but do not check a result. `readJsonl` returns an empty array on any read/parse error.

Suggested fix: return a readiness result from the helper. Stop page generation only when required base artifacts are completely missing; keep stale or optional-artifact findings as warnings.

## Finding PPR-002

Severity: high  
Area: quality

Problem: zero-denominator coverage can be scored as success.

Why it matters: when no UI API calls or matched BFF calls are available, `ratio(0, 0)` returns `1`. A page with unknown input data can therefore receive credit for full coverage.

Evidence from code: `PageDocumentQualityScorer.ratio` returns `1` when `total <= 0`; UI API coverage is calculated as `ratio(uiApiCallCount, uiApiCallCount)` and BE/service coverage use forced denominators.

Suggested fix: represent unavailable metrics as unknown, exclude their weights from the earned/available score, and explain every metric in the JSON/Markdown report.

## Finding PPR-003

Severity: high  
Area: evidence

Problem: exact snippet sections are not governed by the configured total evidence budget.

Why it matters: many matching snippets can make `page-evidence-pack.md` much larger than `pageAnalysis.maxEvidenceCharacters`, defeating the bounded-context design before Copilot truncates the combined context.

Evidence from code: `EvidencePackBuilder` applies a per-role budget only to broad fallback source evidence. Exact snippet groups are appended without tracking their cumulative size.

Suggested fix: rank exact snippets, reserve group budgets, cap duplicates/candidates, and record omitted evidence as an uncertainty. Apply the total budget across exact and fallback content.

## Finding PPR-004

Severity: medium  
Area: freshness

Problem: page artifact freshness is timestamp based and metadata is inconsistent.

Why it matters: copied files, coarse filesystem timestamps, clock changes, or regenerated content with preserved mtimes can evade checks. Operators also cannot easily determine which source artifacts produced Qwen, draft, final, or score outputs.

Evidence from code: `PagePipelineFreshnessService`, `PageOutputFreshnessService`, and local stale helpers compare `mtimeMs`; only `page-flow.json` records a broad source-artifact timestamp map.

Suggested fix: add a shared pipeline version, source-artifact timestamp map, and inexpensive input hash to page artifacts. Keep mtime checks as warning-only compatibility behavior.

## Finding PPR-005

Severity: medium  
Area: errors

Problem: full-page orchestration has no outer error boundary.

Why it matters: a Copilot, filesystem, parser, or finalization failure rejects the command promise after progress starts, with inconsistent user-facing context and no page run failure record.

Evidence from code: `runFullSelectedPageAnalysisCommand` only catches the optional Qwen step. Copilot draft, gap detection, repair, finalization, and scoring failures propagate directly.

Suggested fix: catch the outer operation, preserve generated intermediates, write a small run audit, and show one actionable Turkish error message. Do not delete partial artifacts.

## Finding PPR-006

Severity: medium  
Area: copilot

Problem: selected-page Copilot draft auditing records only successful requests.

Why it matters: failed/cancelled requests leave context and prompt packs but no structured audit entry explaining the outcome.

Evidence from code: `CopilotPageDraftGenerator.generate` calls `askCopilotWithUsage`, then writes the audit entry. There is no catch/finally audit path.

Suggested fix: wrap the request, record failed/cancelled status with error details, then rethrow.

## Finding PPR-007

Severity: medium  
Area: qwen

Problem: a page-level Qwen failure has uneven behavior.

Why it matters: per-interaction errors become a failure count, while the page-level semantic request can abort the standalone command. The output also lacks a consistent metadata envelope and source hash.

Evidence from code: `QwenPageSemanticAnalyzer` catches errors only inside the interaction loop; the page request and JSON parse are outside that loop.

Suggested fix: keep standalone failures actionable, keep the full pipeline's existing optional-step warning, and add metadata to successful output. Record interaction identities that failed where practical.

## Finding PPR-008

Severity: medium  
Area: gap-repair

Problem: required-section detection only recognizes level-two headings and does not account for child headings as content.

Why it matters: a valid section using `###` children can be reported empty, and heading variants can create unnecessary repairs.

Evidence from code: `PageDocGapDetector.splitSections` matches only `^##`; its required-section loop tests only the captured direct body. Turkish folding is present but historical mojibake substitutions are mixed with Unicode folding.

Suggested fix: parse `##` parent sections while retaining nested headings/content, normalize Turkish Unicode consistently, and deduplicate gaps by section/type.

## Finding PPR-009

Severity: medium  
Area: gap-repair

Problem: finalization can theoretically build a document from repaired sections without a valid full draft.

Why it matters: if the draft is stale/missing but repair content is considered fresh, the final result can contain only repaired fragments.

Evidence from code: `FinalPageDocumentBuilder` independently blanks stale draft/repair inputs and `mergeRepairedSections` returns whichever input is present.

Suggested fix: require a non-empty, fresh draft for finalization. Treat repairs as optional. Preserve the existing backup behavior.

## Finding PPR-010

Severity: medium  
Area: ui

Problem: selected-page state is global and is not tied to the current multi-repo manifest.

Why it matters: switching projects can leave a previously selected page active, producing output under the wrong multi-repo root if the page names overlap.

Evidence from code: `SelectedPageStateService` stores a bare `PageCandidate` under one `globalState` key.

Suggested fix: store project/manifest identity with the page or clear/revalidate the selection whenever a new manifest is saved.

## Finding PPR-011

Severity: medium  
Area: traceability

Problem: page ownership and downstream matching use first-match heuristics without ambiguity reporting.

Why it matters: short or similar component names can associate unrelated API calls, and duplicate normalized endpoints are silently reduced to the first match.

Evidence from code: `recordMatchesPage` and `isApiCallOwnedBy` use normalized substring inclusion; `UiToBffMatcher` and `BffToBeMatcher` use `find` for exact/suffix candidates.

Suggested fix: prefer exact file/symbol/route ownership, rank candidates, lower confidence when multiple candidates tie, and add ambiguity details to unresolved/uncertainty artifacts.

## Finding PPR-012

Severity: low  
Area: errors

Problem: `readJsonl` suppresses missing-file, malformed-line, and permission errors identically.

Why it matters: resilience is good for optional artifacts, but malformed required indexes become indistinguishable from valid empty analysis.

Evidence from code: `readJsonl` catches every exception and returns `[]`.

Suggested fix: retain the tolerant API for optional consumers, but add a strict/diagnostic read variant or require freshness/existence checks before critical pipelines.

## Finding PPR-013

Severity: low  
Area: errors

Problem: page output writes are mostly safe because their page folder already exists, but several individual writers rely on prior phases to have created parent directories.

Why it matters: invoking a later command after manually removing a folder can fail with `ENOENT`.

Evidence from code: Qwen, draft, gap, repair, final, and quality writers do not consistently call `fs.mkdir(pageRoot, { recursive: true })` before writing.

Suggested fix: ensure the page/output directory at each standalone entry point. This is cheap and idempotent.

## Finding PPR-014

Severity: low  
Area: copilot

Problem: context budgeting is character-first and truncates the combined string from the end.

Why it matters: lower-priority or earlier sections can consume the budget, while critical evidence groups later in the context disappear. The selected model's `maxInputTokens` is only recorded after the request.

Evidence from code: page draft and repair use `slice(0, maxCharacters)`; the Copilot client counts tokens but does not reject/rescale before `sendRequest`.

Suggested fix: reserve budgets by evidence priority and, in a later phase, select/count the model before final context assembly.

## Low-Risk Fix Scope Chosen

The implementation following this audit is limited to:

- blocking page generation only when required base artifacts are missing;
- adding an outer Turkish error boundary for the full selected-page pipeline;
- ensuring output folders exist;
- adding shared page artifact metadata/version/hash support;
- bounding/ranking exact evidence and recording uncertainty;
- strengthening heading/merge safety;
- making quality metrics unknown-aware and explanatory;
- improving low-risk path normalization and ambiguity reporting.

Broader parser replacement, Webview consolidation, model-aware dynamic budgeting, and schema-wide orchestration refactors are deferred.
