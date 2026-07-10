# Page Pipeline Audit

## Checked Files
- `src/commands/pageAnalysisCommands.ts`
- `src/pageanalysis/pageListService.ts`
- `src/pageanalysis/selectedPageStateService.ts`
- `src/pageanalysis/pageContextPackBuilder.ts`
- `src/evidence/pageEvidenceSelector.ts`
- `src/evidence/evidencePackBuilder.ts`
- `src/docs/focusedSourceContext.ts`
- `src/analyzer/be/javaMethodCallExtractor.ts`
- `src/pageanalysis/qwenPageSemanticAnalyzer.ts`
- `src/pageanalysis/copilotPageDraftGenerator.ts`
- `src/pageanalysis/gapDetection/pageDocGapDetector.ts`
- `src/pageanalysis/gapRepair/pageGapRepairPlanner.ts`
- `src/pageanalysis/gapRepair/pageGapEvidenceSelector.ts`
- `src/pageanalysis/gapRepair/pageSectionRegenerator.ts`
- `src/pageanalysis/finalPageDocumentBuilder.ts`
- `src/pageanalysis/quality/pageDocumentQualityScorer.ts`
- `src/pageanalysis/quality/pageDocumentQualityReportWriter.ts`
- `src/multirepo/multiRepoTraceabilityService.ts`
- `src/graph/localKnowledgeGraphBuilder.ts`
- `src/multirepo/multiRepoQualityReportGenerator.ts`
- `scripts/smoke-tests.js`

## Current Pipeline Summary
The full selected-page command currently executes this order:

1. Read the saved UI-BFF-BE manifest and selected page.
2. Refresh traceability, local knowledge graph, and multi-repo quality artifacts.
3. Build `page-flow.json` and `page-context-pack.md`.
4. Build `page-evidence-pack.md` from selected source files.
5. Optionally run Qwen page and interaction semantics when Qwen is enabled.
6. Build Copilot draft context and prompt artifacts.
7. Ask Copilot for `copilot-draft.md`.
8. Run local gap detection into `detected-gaps.json`.
9. If gaps exist, ask Copilot to regenerate repaired sections into `repaired-sections.md`.
10. Build `final-page-technical-analysis.md`.
11. Score the final/draft document and write page plus aggregate quality reports.

The smaller "analyze selected page" command builds only context and evidence packs. It does not currently refresh all multi-repo prerequisites.

## Findings

### F-001
- Severity: high
- Area: evidence
- Problem: Page evidence selection could include broad BE entity/repository candidates because `pageContextPackBuilder` stores all BE entities and repositories in the page flow, and `pageEvidenceSelector` collected any file-like field recursively.
- Why it matters: Copilot could receive noisy evidence, spend context budget on unrelated files, and generate plausible but weak service/entity explanations.
- Evidence from code: `selectPageEvidenceFiles` previously included `collectFiles(pageFlow.entities)` and `collectFiles(pageFlow.repositories)` without checking whether the current page's BE flow referenced those records.
- Suggested fix: Rank exact page/flow evidence first and include repository/entity snippets only when referenced by matched BE service-flow records.

### F-002
- Severity: high
- Area: repair
- Problem: Final document generation overwrote the existing final document directly and appended unmatched repaired sections as standalone duplicated content.
- Why it matters: A bad repair pass could destroy the previous usable final document, and duplicated headings make final docs harder to review.
- Evidence from code: `FinalPageDocumentBuilder.build` wrote directly to `final-page-technical-analysis.md`; unmatched repaired sections were appended with a generic separator.
- Suggested fix: Back up the previous final document before writing, replace matching H2 sections safely, skip duplicate repaired headings, and append unmatched repair content under one clear section.

### F-003
- Severity: medium
- Area: scoring
- Problem: Quality score did not expose missing artifact data, document length sanity, or context-pack availability.
- Why it matters: A document could get a deceptively strong score when scoring inputs were absent or the final output was too short to be useful.
- Evidence from code: `PageDocumentQualityScorer` checked required sections, references, gaps, coverage, Qwen, and evidence availability, but did not report unknown source data or final length.
- Suggested fix: Add `metricsWithUnknownData`, `contextPackAvailable`, and `finalDocumentLength`, and include those in reports and scoring.

### F-004
- Severity: medium
- Area: freshness
- Problem: Page context packs had only `generatedAt`; they did not record source artifact paths or timestamps.
- Why it matters: When a page document looks wrong, it is hard to tell whether context came from fresh traceability/graph/index artifacts or stale files.
- Evidence from code: `page-flow.json` and `page-context-pack.md` included project, branch, and selected page, but no source artifact mtime metadata.
- Suggested fix: Add pragmatic source artifact metadata with existence/mtime status for UI/BFF/BE indexes, traceability, graph, and quality artifacts.

### F-005
- Severity: medium
- Area: gap-detection
- Problem: The detector already handled H2 parent sections better, but heading normalization needed to remain ASCII-folded and stable for Turkish Markdown.
- Why it matters: Turkish headings can include `ı`, `ğ`, `ü`, `ş`, `ö`, `ç`; byte/encoding drift can create false empty-section gaps.
- Evidence from code: Heading normalization was present but had previously been vulnerable to mojibake in source.
- Suggested fix: Keep normalization based on Unicode escape handling and ASCII folding.

### F-006
- Severity: low
- Area: UI
- Problem: Resolved. The full selected-page command now reports the freshness preflight as step `1/9` before context generation.
- Why it matters: Users can see that prerequisite artifact checks are a real part of the full pipeline.
- Evidence from code: `runFullSelectedPageAnalysisCommand` reports `1/9 Artifact tazeligi kontrol ediliyor...` before building context/evidence.
- Suggested fix: No remaining action for this finding.

### F-007
- Severity: high
- Area: freshness
- Problem: Downstream page outputs can become stale after `page-context-pack.md` or `page-evidence-pack.md` is rebuilt. Existing commands mostly checked only whether files existed.
- Why it matters: Gap detection, repair, final document building, and quality scoring can run against an old Copilot draft while the current context/evidence is newer.
- Evidence from local output: `copilot-draft.md` was older than fresh `page-context-pack.md` and `page-evidence-pack.md`, but quality scoring previously did not expose that transitive stale state.
- Suggested fix: Add output freshness checks for page outputs and include stale output state in quality metrics and command warnings.

## Top Fixes Implemented
1. Improved `pageEvidenceSelector` so evidence selection prefers selected UI/page files, matched BFF files, matched BE endpoint/service-flow files, and only repository/entity files referenced by the matched BE service flow.
2. Added uncertainty notes to evidence selections and wrote them into `page-evidence-pack.md`.
3. Added source artifact metadata to `page-flow.json` and `page-context-pack.md`, including key UI/BFF/BE/traceability/graph/quality artifact paths and mtimes or `missing`.
4. Hardened `FinalPageDocumentBuilder` so it creates a timestamped `.bak-*` backup before overwriting the final document.
5. Changed final repair merging to replace matching H2 sections, skip duplicate repaired headings, and append unmatched repair content under `## Ek Onarim Notlari`.
6. Updated final-document heading normalization to ASCII-fold Turkish characters using Unicode escape rules.
7. Extended `PageDocumentQualityScorer` with `contextPackAvailable`, `finalDocumentLength`, and `metricsWithUnknownData`.
8. Updated page and aggregate quality reports to show document length, context/evidence availability, and unknown metric data.
9. Added `PagePipelineFreshnessService` to check required base and derived page-pipeline artifacts before context generation.
10. Wired freshness validation into both selected-page context analysis and full selected-page analysis.
11. Freshness validation writes `audit/page-pipeline-freshness.json`, regenerates missing/stale derived traceability/graph/quality artifacts when base indexes exist, and warns when base UI/BFF/BE indexes are missing.
12. Added related BFF/BE Spring component records to page context so evidence can include exact controller/component files.
13. Tightened low-confidence BE evidence: low-confidence service-flow candidates no longer pull broad service/repository/entity files into the page evidence pack.
14. Filtered page context `entities` and `repositories` to trusted BE service flows only, preventing low-confidence candidates from inflating context and quality.
15. Updated service-flow quality coverage so low-confidence BE service flows do not count as full service-flow coverage.
16. Added `PageOutputFreshnessService` to detect stale generated page outputs against their dependencies.
17. Updated quality scoring/reporting with `outputFreshnessIssues` and `stale-output` unknown metric data.
18. Added stale-output warnings before gap detection, gap repair, final document build, and manual scoring commands.
19. Extended output freshness checks to aggregate multiple targets into one `output-freshness.json` instead of overwriting per target.
20. Added Qwen freshness checks; stale Qwen semantics now reduce `qwenSemanticCoverage` instead of counting as fully valid.
21. Updated Copilot page draft context selection so stale Qwen semantic artifacts are skipped instead of sent to Copilot.
22. Copilot draft context now places skipped-artifact notes at the top of the context so token truncation cannot hide them.
23. Updated gap repair context so stale Qwen semantic artifacts are skipped and replaced with explicit regeneration notes.
24. Updated final document generation so stale Copilot drafts and stale repaired sections are not merged into final documents; the final output now records skipped stale inputs.
25. Updated gap repair context so stale Copilot drafts are skipped and replaced with explicit regeneration notes.
26. Added stale-output warning when opening the final selected-page document.
27. Updated the full selected-page progress text to include the artifact freshness preflight as a real pipeline step.
28. Changed manual gap detection, gap repair, and final build commands to stop when their direct generated input is stale, preventing new downstream artifacts from being created from old context.
29. Improved `focusedSourceContext` so oversized Java/React files produce focused line-window snippets around controllers, mappings, services, entities, hooks, handlers, and API calls instead of blindly using the first characters of the file.
30. Added BE DTO index generation, page-context DTO matching, DTO source evidence inclusion, BE DTO graph nodes, BE DTO quality tracking, and BE DTO context for agentic Copilot.
31. Added selected-page BE validation matching so DTO/entity validation records and source files are included in page context/evidence.
32. Updated Copilot and Qwen page-analysis prompts to explicitly map request/response DTOs, UI parameters, backend validation, and visible DTO/model fields; bumped Qwen page semantic prompt version to invalidate older cache entries.
33. Added `be/java-method-call-index.jsonl` generation and used it to narrow BE service flows from controller calls to service calls to repository methods/entities before falling back to naming heuristics.
34. Added Java method-call graph nodes/edges and included the method-call index in freshness, quality, context metadata, and agentic Copilot context.
35. Added `npm test` smoke tests covering method-call BE flow narrowing, selected-page DTO/validation context, and Qwen prompt-version cache invalidation.
36. Upgraded focused source context from regex line windows to brace-balanced method/component snippets, with line-window fallback for files where structured blocks cannot be safely extracted.
37. Expanded smoke tests for structured snippets, evidence selection, final repair merge/backups, and quality unknown-data scoring.

## Remaining Work
- No open items from this audit list. Future hardening can add a real parser such as Tree-sitter, but the current list is implemented with dependency-free local heuristics and smoke coverage.
