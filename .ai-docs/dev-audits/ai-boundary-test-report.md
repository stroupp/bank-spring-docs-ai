# AI Boundary Test Report

Generated: 2026-07-11

## Scope and Safety Contract

This phase tests the selected-page Qwen and Copilot orchestration at explicit injectable boundaries. All responses are deterministic in-process mocks. The Qwen test replaces `fetch` with a fail-fast sentinel and asserts zero calls. The Copilot test replaces `vscode.lm.selectChatModels()` with a fail-fast sentinel and asserts zero calls.

No repository, fixture, page context, or evidence was sent over a network by these tests.

## Copilot Boundary

### Abstraction status

- `ICopilotClient` defines the injectable `send(...)` boundary.
- `RealCopilotClient` preserves production behavior and delegates to the existing VS Code Language Model implementation.
- Existing exports `askCopilot(...)` and `askCopilotWithUsage(...)` remain available and behavior-compatible.
- `CopilotPageDraftGenerator` defaults to `RealCopilotClient`, so existing command construction is unchanged. Tests inject a mock through its constructor.
- Other repository-wide and agentic Copilot generators still call the legacy exported functions directly. They remain production-compatible but are not yet constructor-injectable.

### Mock test status

Command: `npm run test:copilot-boundary`

Result: **pass**

Verified:

- selected page name and route enter the saved context;
- page evidence enters the saved context;
- Qwen page semantics enter context when available and fresh;
- UI/BFF/BE evidence markers and endpoint data remain available;
- context never exceeds the configured character budget, including the truncation marker;
- password, authorization bearer token, and API-key patterns are masked;
- a deterministic Markdown draft is written with local page metadata;
- success audit records include model, usage, included files, masked-secret count, and success status;
- throwing mocks produce a failed audit record and preserve the error;
- a cancelled token plus a throwing mock produces a cancelled audit record;
- the test fails if production code attempts `vscode.lm` access.

### What remains manual

- VS Code model discovery, authentication, quota, model token counting, streaming, and real cancellation behavior;
- Extension Development Host command/UI behavior;
- real-model document accuracy and latency;
- agentic and repository-wide Copilot generators, which should receive the same injection pattern only when their own boundary suites are added.

## Qwen Boundary

### Abstraction status

- `IQwenClient` defines the injectable `ask(...)` boundary and optional connection diagnostic.
- Existing `QwenClient` implements it without changing endpoint, key, timeout, cancellation, or response handling.
- `QwenPageSemanticAnalyzer` defaults to the real `QwenClient`; tests inject a mock client and model identity.
- Selected-page Qwen input now passes through the existing secret masker and a strict character budget before the client boundary.

### Mock test status

Command: `npm run test:qwen-boundary`

Result: **pass**

Verified:

- page and interaction prompts contain grounding rules and strict-JSON instructions;
- page context and focused evidence are included in the page prompt;
- focused evidence is included in the interaction prompt;
- selected-page Qwen context is secret-masked and character-bounded;
- valid strict JSON is parsed and page/interaction semantic files are written;
- a first run is a cache miss and writes deterministic cache entries;
- a second identical run is a cache hit and does not invoke the mock client;
- invalid JSON creates a local raw debug file, increments failures, and writes a low-confidence semantic artifact;
- a thrown client error does not crash selected-page semantic analysis and is represented as a low-confidence result;
- the test fails if production code attempts `fetch`.

### What remains manual

- real endpoint normalization, HTTP authorization, timeout, cancellation, and provider response variants;
- SecretStorage API-key retrieval;
- connection-test command and Turkish UI notifications;
- semantic usefulness and schema conformance from the configured real model;
- repository-wide and multi-repo Qwen analyzers, which still construct `QwenClient` directly.

## Real AI Calls

Automated tests required neither real Qwen nor real Copilot. Qwen network calls: **0**. VS Code Language Model selections: **0**. Real calls remain manual diagnostics only.

## Remaining Risks

- `parseStrictJson` accepts a JSON object embedded in surrounding text for backward compatibility; this is tolerant parsing rather than a schema validator.
- Qwen semantic output is structurally parsed but not validated field-by-field against the prompt schema.
- Debug files intentionally retain invalid raw model output. Inputs are masked before sending, but model-generated debug output should still be treated as local sensitive diagnostic data.
- Character budgets are deterministic approximations; provider tokenization can differ.
- Cache invalidation covers prompt version, model, identity, and prompt text, but does not encode endpoint/provider implementation.
- Copilot success auditing happens after draft writing. A filesystem failure while appending the audit can still make generation report failure even if the draft exists.
- Full draft-to-gap-to-final-to-quality orchestration is owned by the local documentation QA harness, not by these AI transport-boundary tests.

## Files Covered

- `src/ai/qwenClient.ts`
- `src/ai/copilotClient.ts`
- `src/ai/safeContextFilter.ts`
- `src/ai/copilotAuditLogger.ts`
- `src/pageanalysis/qwenPageSemanticAnalyzer.ts`
- `src/pageanalysis/pageSemanticPrompts.ts`
- `src/pageanalysis/copilotPageDraftGenerator.ts`
- `src/pageanalysis/pageTechnicalAnalysisPrompts.ts`
- `src/semantic/semanticCacheService.ts`
- `scripts/qwen-boundary-tests.js`
- `scripts/copilot-boundary-tests.js`

