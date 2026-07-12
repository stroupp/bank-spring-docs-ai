# AST Extraction Roadmap

## Why AST is needed

The current regex/static scan is fast, dependency-light, and a valuable fallback, but it cannot reliably model a programming language grammar. Known limits include multiline/nested annotations, overloaded methods, records, complex generics, Lombok-generated members, interface/default methods, braces in comments/strings, composed Spring annotations, aliased imports, chained WebClient calls, JSX expressions, route objects, hook closures, and TypeScript syntax variants.

AST parsing should improve exact symbol ranges, annotations, types, ownership, and call relationships. It should not replace the current schemas or remove regex fallback.

Before implementation, introduce parser-provider interfaces and fixture-based golden tests. The extension should select AST results when parsing succeeds and fall back per file/symbol when it does not.

## Phase 1: Java Controller Endpoint AST Parser

Extract:

- class/interface name, package, imports, source range;
- controller stereotypes and class-level request mapping;
- method-level Spring mappings, including arrays and named attributes;
- HTTP method, normalized paths, handler name, visibility, annotations;
- parameter names/types and `@PathVariable`, `@RequestParam`, `@RequestHeader`, `@RequestBody` metadata;
- parameter/method validation annotations;
- return type, generic wrapper, thrown exceptions, source line range.

Map results to the existing `ApiEndpoint` schema and add optional fields such as `sourceRange`, `parser: "ast"`, `parserVersion`, `confidence`, and `mappingPaths`.

## Phase 2: Java DTO/Entity Field AST Parser

Extract:

- classes, records, enums, fields, record components, constructors;
- field/type/generic information and source ranges;
- Bean Validation annotations and arguments;
- Lombok annotations as generation clues without inventing generated methods;
- JPA entity/table/column/id metadata;
- relationships, join columns, collection target types, embedded IDs;
- DTO naming/usage clues and serialization annotations.

Preserve `entity-index.jsonl`, `dto-index.jsonl`, and `validation-index.jsonl` compatibility. Add optional provenance and annotation-argument fields.

## Phase 3: Java Service Method Call Parser

Extract:

- exact method declarations and lexical source ranges;
- injected field/constructor dependencies with variable-to-type binding;
- method invocations and receiver resolution;
- controller -> service -> repository/client call chains;
- return/throw branches where practical;
- transactional, async, retry, cache, and security annotations.

Output should remain compatible with `java-method-call-index.jsonl` and `service-flow-index.jsonl`. Confidence should reflect resolution quality: resolved symbol, local type inference, or name-only fallback.

## Phase 4: Java Repository Method Parser

Extract:

- repository interfaces and inheritance;
- `JpaRepository`/`CrudRepository` entity and ID generic types;
- declared query methods and parameters;
- `@Query`, named queries, modifying/native flags;
- default/custom repository methods;
- exact method source ranges and referenced entity properties when derivable.

Keep `repository-method-index.jsonl` fields and extend with optional query/provenance metadata. Never expose configuration secrets or query parameter values from runtime sources.

## Phase 5: React TSX Parser

Use a TypeScript-capable parser to extract:

- imports/exports and component declarations;
- JSX/route objects and lazy-loaded page components;
- event handlers and handler-to-element relationships;
- API client functions, HTTP methods, template paths, parameters, and call sites;
- form fields, labels, validation rules, and submit flow;
- state/hooks/effects and dependency arrays;
- component ownership, subcomponent use, and source ranges.

Preserve route, page, component, interaction, API-call, form-field, and state JSONL schemas. Add optional symbol ranges and resolved ownership.

## Fallback Strategy

- Keep every current regex extractor.
- Parse per file, not as an all-or-nothing repository operation.
- On parser load failure, syntax error, unsupported language level, or timeout, record a warning and use regex output for that file.
- Merge AST and regex results using stable logical keys, preferring AST fields while retaining regex-only records.
- Record `parser`, `parserVersion`, `fallbackReason`, and confidence as optional fields.
- Do not let parser failure block local documents.

## Output Compatibility

- Existing required JSONL fields remain unchanged.
- New fields are optional.
- Context builders and document generators must ignore unknown fields safely.
- Artifact `pipelineVersion` and parser versions must make mixed runs auditable.
- Stable IDs should be introduced from repository role + normalized file + symbol + signature, not array position.

## Risks

- dependency size and extension startup/package size;
- native module installation and Windows compatibility;
- WASM loading restrictions in VS Code extension hosts;
- Java grammar/version coverage and preview features;
- TypeScript/JSX parser version alignment;
- parse time and memory on monorepos;
- conflicting AST/regex results;
- schema drift and context growth from richer records;
- misleading confidence when symbol resolution is incomplete.

No parser dependency should be added until a small technical spike compares pure-JS, WASM, and native options. Prefer a dependency that packages predictably for Windows and the VS Code extension host. A heavy dependency requires measured accuracy and packaging benefits.

## Validation Plan

1. Create small checked-in fixtures for Java controllers, DTOs/entities, services, repositories, BFF clients, React routes, forms, handlers, and API clients.
2. Store expected JSONL records as golden files.
3. Run both regex and AST providers and produce a comparison report: matched, AST-only, regex-only, conflicting fields.
4. Measure precision/recall manually on representative internal repositories without committing source.
5. Benchmark parse time, memory, extension activation time, and package size on Windows.
6. Add fault tests for malformed files and unsupported syntax.
7. Roll out one index at a time, beginning with Java controller endpoints.
8. Keep a setting or automatic capability check that allows AST parsing to be disabled without breaking current behavior.

The recommended next engineering phase is the parser interface + fixture corpus, not Tree-sitter installation.
