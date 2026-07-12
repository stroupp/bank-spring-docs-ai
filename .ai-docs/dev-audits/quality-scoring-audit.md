# Page Quality Scoring Audit

## Previous Scoring Risks

The previous scorer combined useful signals but contained an optimistic denominator rule: `ratio(0, 0)` returned `1`. Missing UI API calls could therefore produce full UI/BFF coverage credit. Parameter and validation coverage also relied mainly on the presence of generic words in the document.

The score mixed headings, references, gaps, matches, optional Qwen output, artifact availability, length, and freshness, but the JSON did not explain how each component affected the result.

## Improvements Implemented

- Coverage values are now `number | null`; `null` means unknown.
- No-data denominators no longer become successful coverage.
- UI API-call coverage checks indexed call paths/functions/method signals against the document.
- BFF coverage uses matched BFF endpoints divided by selected-page UI API calls.
- BE coverage uses matched BE endpoints divided by matched BFF calls.
- Parameter coverage checks extracted form fields and endpoint parameters against document text.
- Validation coverage checks extracted validation annotations, fields, and class names against document text.
- Service-flow coverage uses non-low-confidence backend flows divided by matched BE endpoints.
- Repository/entity coverage is evaluated only when a trusted backend flow exists and checks extracted records against document text.
- Missing Qwen semantics are marked unknown rather than false success; stale semantics receive partial measured credit.
- Missing gap reports no longer receive the “no gaps” points.
- Context/evidence availability, document length, source references, required sections, unresolved gaps, high-severity gaps, and freshness remain explicit inputs.
- `metricExplanations` records status, value, weight, and a human-readable reason for every score family.
- `quality-score.json` now includes generation time, pipeline version, input hash, and source artifact modification times.
- the Markdown quality report prints `unknown` values and a `Skor Aciklamalari` section.
- source-vs-page artifact freshness warnings are included in the freshness issue count.

## Weight Model

The positive model totals 100 points before deductions:

| Metric | Weight |
| --- | ---: |
| Required sections | 20 |
| Source references | 12 |
| Unresolved gap count | 12 |
| High-severity gaps | 8 |
| UI API call documentation | 6 |
| UI -> BFF match coverage | 7 |
| BFF -> BE match coverage | 7 |
| Parameter evidence coverage | 5 |
| Validation evidence coverage | 5 |
| Service-flow coverage | 4 |
| Repository/entity coverage | 4 |
| Qwen semantics | 2 |
| Context/evidence availability | 3 |
| Document length sanity | 5 |

Unknown metrics earn zero; they are listed rather than converted to success. Missing core data and freshness issues also apply bounded deductions. This is intentionally conservative for a documentation system whose primary goal is source grounding.

## Remaining Limitations

- Text mention checks show that evidence identifiers appear, not that every claim is correct.
- Source-reference count can be inflated by repeated paths; a future version should score unique path + line/symbol citations.
- Required-section presence does not measure prose quality.
- A page that legitimately has no API, validation, repository, or Qwen data loses optional points. Future calibration can distinguish “not applicable” from “unknown” when indexes expose that state explicitly.
- Weight calibration has not yet been validated against human-rated documents.

## Validation Plan

1. Build a corpus of page outputs rated by senior engineers.
2. Compare score components with human ratings for correctness, completeness, and usefulness.
3. Add tests for no-API pages, partial BFF matches, no-BE pages, validation-heavy forms, and stale semantics.
4. Track score version in the pipeline version before changing weights again.
