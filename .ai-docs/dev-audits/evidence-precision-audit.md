# Evidence Precision Audit

## Scope
This audit covers the page-level evidence pack precision upgrade for UI-BFF-BE page technical analysis.

## Improved Extractors
- `reactHandlerSnippetExtractor`
  - Extracts selected React component declarations, event handler functions, JSX elements wired to handlers, nearby `useState`/`useForm` lines, and relevant imports.
- `reactApiClientSnippetExtractor`
  - Extracts API client functions and nearby `axios`, `fetch`, or `apiClient` calls matched from `uiApiCalls`.
  - Supports expression-bodied arrow exports such as `export const login = body => apiClient.post(...)`.
- `javaControllerMethodSnippetExtractor`
  - Extracts controller endpoint methods for BFF and BE endpoints, including nearby annotations, signature, method body, class name, and relevant imports.
- `javaServiceMethodSnippetExtractor`
  - Extracts BFF service/outbound client and BE service methods from service-flow records and method-call evidence.
  - Uses `outboundCalls` text such as `via AuthClient.login` to extract exact BFF client methods.
- `javaRepositoryMethodSnippetExtractor`
  - Extracts repository methods, entity/DTO class blocks, and validation-related source files when visible.

## Evidence Pack Layout
`page-evidence-pack.md` now writes exact evidence first:

1. React Page Evidence
2. React Interaction Evidence
3. React API Client Evidence
4. BFF Endpoint Evidence
5. BFF Service / Outbound Client Evidence
6. Backend Endpoint Evidence
7. Backend Service Evidence
8. Repository / Entity Evidence
9. Broad Fallback Evidence
10. Uncertainties

Each exact snippet includes:
- file path
- detected symbol name
- selection reason
- confidence
- source excerpt

## Fallback Behavior
- Exact snippet extraction is best-effort and never fails the page pipeline.
- If a symbol/method/handler cannot be found, the evidence pack records an uncertainty.
- The existing broad evidence selection still runs under `Broad Fallback Evidence`.
- Existing `focusedSourceContext` remains the fallback for broader but still trimmed source context.

## Validation
- `npm run compile` passes.
- `npm test` passes.
- Smoke tests cover:
  - BE method-call service-flow narrowing
  - structured source snippets
  - low-confidence BE evidence filtering
  - DTO and validation context inclusion
  - exact page evidence pack group layout
  - expression-bodied React API client functions
  - BFF outbound client methods with multi-line Java annotations
  - final repair merge/backups
  - quality unknown-data scoring
  - Qwen semantic prompt-version cache invalidation

## Limitations
- React inline handlers are captured only when the JSX pattern is simple enough for static extraction.
- Complex TypeScript generics, nested callback factories, HOCs, render props, and generated clients may still fall back to broader evidence.
- Java extraction is brace-balanced and annotation-aware, but not a full AST parser.
- Lombok-generated methods, inherited controller methods, interface default methods, and dynamic route composition may require fallback evidence.
- BFF service/outbound snippets depend on available flow/component records; unresolved client classes are recorded as uncertainties.

## Next Step
The next precision upgrade would be adding Tree-sitter or TypeScript compiler API parsing behind the current dependency-free extractors. The current implementation intentionally avoids new heavy dependencies and preserves existing regex/static fallback behavior.
