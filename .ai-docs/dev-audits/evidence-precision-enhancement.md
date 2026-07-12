# Evidence Precision Enhancement

## What Was Improved

The selected-page evidence pipeline now uses a more explicit, ranked evidence structure and a real total evidence budget.

Changes include:

- added `React Route Evidence` extraction from the route definition file;
- split BFF service evidence from BFF outbound client evidence;
- split repository method evidence from entity/DTO/validation evidence;
- added field-level validation extraction before falling back to a full Java class block;
- retained exact React handler, JSX event, API client, Spring endpoint, service/client, repository, and class extraction;
- capped exact candidates per group and sorted them by confidence;
- applied the configured total evidence budget across exact and fallback evidence instead of budgeting only the fallback;
- recorded exact snippets omitted by the budget as uncertainty notes;
- added a metadata block containing project, branch, page, route, source artifact modification times, input hash, and pipeline version;
- added stable module entry files for the requested extractor responsibilities while retaining the existing shared implementation to avoid risky duplication.

## Exact Snippets Now Selected

Evidence is emitted in this order:

1. selected React page/component declaration;
2. route definition window for the selected page;
3. interaction handler, JSX event element, and nearby hook/form context;
4. API client function or exact HTTP call window;
5. matched BFF controller endpoint method;
6. matched BFF service method;
7. matched BFF outbound client method;
8. matched backend controller endpoint method;
9. matched backend service method;
10. matched repository method;
11. entity, DTO, and validation field/class evidence.

The format is now:

```text
# Page Evidence Pack

## Metadata
## React Page Evidence
## React Route Evidence
## React Interaction Evidence
## React API Client Evidence
## BFF Endpoint Evidence
## BFF Service Evidence
## BFF Outbound Client Evidence
## Backend Endpoint Evidence
## Backend Service Evidence
## Repository Evidence
## Entity / DTO / Validation Evidence
## Broad Fallback Evidence
## Uncertainties
```

## Fallback Behavior

- Exact extraction failures never abort the evidence build.
- Every missing/unreadable symbol adds an uncertainty note.
- Broad fallback still uses the existing focused-source selector, path containment checks, per-file truncation, and trusted backend-flow filtering.
- Broad evidence is limited to the budget left after exact evidence and divided across the UI/BFF/BE roles that actually have candidate files.
- Low-confidence backend flows do not expand repository/entity evidence.

## Limitations

- Exact extraction is still regex/brace based and can be confused by braces in strings/comments, overloads, nested declarations, unusual formatting, decorators, or complex TypeScript generics.
- BFF service/client method names are inferred from flow text and candidate components; weak upstream flow indexes still limit exactness.
- Route extraction is a focused source window, not an AST-resolved route object.
- Entity/DTO evidence can still be a bounded class block when a specific field cannot be identified.
- The four-snippet-per-group limit is intentionally conservative and may omit valid overloads; omissions are auditable.
- Fallback source selection remains file based and should not be expanded until precision tests exist.

## Next Improvements

1. Add fixture tests for function expressions, destructured parameters, Java overloads, annotations, records, and Feign/WebClient variants.
2. Add symbol offsets and line ranges to JSONL indexes so evidence extraction does not need to rediscover symbols.
3. Rank candidate evidence using exact file + symbol + endpoint ownership rather than name similarity.
4. Introduce parser interfaces and AST implementations behind the current extractor exports while keeping regex fallback.
