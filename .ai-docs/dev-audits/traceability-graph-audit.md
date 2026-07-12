# Traceability and Graph Reliability Audit

## Scope

The audit covered:

- React API call -> BFF endpoint matching;
- BFF outbound call -> backend endpoint matching;
- page -> interaction -> UI API -> BFF -> BE flow construction;
- path and HTTP method normalization;
- unresolved and ambiguous matches;
- graph refresh before page context generation;
- graph node/edge consistency.

## Current Flow

`MultiRepoTraceabilityService` reads UI calls/interactions/routes, BFF endpoints/outbound calls, and backend endpoints. It writes UI-to-BFF, BFF-to-BE, page-flow, unresolved, Markdown, and JSON reports. `PagePipelineFreshnessService` compares base and derived artifact mtimes; when required bases are present and derived outputs are missing/stale, it rebuilds traceability, the graph, and the multi-repo quality report before page context generation.

## Findings

### TR-001 - First-candidate ambiguity

Severity: high

The matchers previously used `find`, so duplicate normalized endpoints silently selected the first record with high/medium confidence. This was corrected: exact and suffix candidates are collected, ties receive low confidence, and the reason includes the candidate count. Ambiguous low-confidence matches are also written to unresolved reporting for review.

### TR-002 - Path normalization

Severity: medium

Existing normalization already handled leading slashes and `:id`, `{id}`, `${id}`, and `{customerId}` placeholders. It now also strips query/fragment suffixes, extracts the pathname from absolute HTTP(S) URLs, and removes the common `/api` prefix case-insensitively during suffix matching.

The following normalize consistently:

```text
/customers/:id
/customers/{id}
/customers/${id}
/customers/{customerId}
```

to:

```text
/customers/{param}
```

`api/customers/search` and `/api/customers/search` normalize to `/api/customers/search`.

### TR-003 - Method matching

Severity: low

Methods are normalized to uppercase and remain mandatory for exact/suffix matches. Unknown methods default to GET. A future schema should distinguish genuinely unknown methods from GET rather than silently defaulting.

### TR-004 - Page ownership

Severity: medium

Page ownership combines `usedBy`, page/component/file fields, normalized name matching, and fallbacks. Substring matching can associate similarly named pages. No broad rewrite was made because it requires fixture coverage and likely index schema additions.

Recommended next step: add explicit `ownerFile`, `ownerComponent`, import/call-site evidence, and ownership confidence to React API-call records.

### TR-005 - BFF source endpoint ownership

Severity: medium

BFF outbound calls are preferred when present, but the quality of BFF-to-BE traces depends on `sourceEndpoint`. When it is missing, the matcher can identify the backend endpoint but the page flow may not connect it to the correct incoming BFF endpoint.

Recommended next step: derive source endpoint through controller -> service -> client method calls and persist candidate paths with confidence.

### TR-006 - Page flow depth

Severity: medium

`PageFlowBuilder` records controller/handler-level BFF and BE flows, while service/repository/entity depth is joined later by page context. Page-flow `entities` and `tables` remain empty. Extending these fields from trusted BE service flows is low conceptual risk but should follow canonical endpoint identity work to prevent false joins.

### TR-007 - Graph canonicalization

Severity: medium

The graph creates canonical layer nodes and additional traceability-layer nodes for the same logical endpoints. This makes the graph auditable but produces duplicate identities and limits traversal across canonical components.

Recommended next step: reuse canonical endpoint IDs in traceability edges and add explicit edges for page ownership, component calls, endpoint handlers, service calls, DTO use, repository methods, entities, validation, and exceptions.

### TR-008 - Graph freshness

Severity: low

Graph refresh is correctly included in the pre-page derived-artifact refresh. The new page metadata and artifact freshness report make the source artifact times visible. Freshness remains mtime based; content hashes should be introduced incrementally for derived run manifests.

## Changes Implemented

- ambiguity-aware UI-to-BFF and BFF-to-BE matching;
- ambiguous match visibility in unresolved output;
- stronger path normalization for queries, fragments, absolute URLs, and case-insensitive `/api` handling;
- regression tests for placeholder normalization, leading slash normalization, and ambiguous exact matches;
- required-base checks now stop page generation instead of allowing empty traceability to appear successful.

## Remaining Graph Roadmap

1. Define canonical IDs for endpoints, components, methods, DTOs, and pages.
2. Reuse those IDs across layer and traceability builders.
3. Add edge provenance (`artifact`, record ID, match reason) and candidate confidence.
4. Add graph integrity tests: dangling edges, duplicate logical nodes, low-confidence ratios, and path reachability.
5. Use graph neighborhoods for context selection only after graph accuracy is measured against fixtures.
