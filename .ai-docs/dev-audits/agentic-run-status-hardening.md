# Agentic UI-BFF-BE Run Status Hardening

## Purpose

The previous Agentic UI-BFF-BE run stopped on the first Copilot step after receiving an empty text response. The prompt and context remained on disk, but no audit entry, failure summary, or final document explained the stopping point.

This change adds a persistent run lifecycle that begins before local UI analysis and remains available after success, failure, or cancellation.

The later `cross-layer-diagrams` failure also exposed two providers with the same model ID. Earlier steps used vendor `copilot`; the failed step selected `copilotcli`. Model selection is now pinned to the standard `copilot` vendor for the lifetime of one Agentic generator.

## Generated Status Files

Every new Agentic run writes:

```text
.ai-docs/multi-repo/copilot-workspace/agentic-ui-bff-be/<runId>/run-status.json
.ai-docs/multi-repo/copilot-workspace/agentic-ui-bff-be/<runId>/run-status.md
.ai-docs/multi-repo/copilot-workspace/agentic-ui-bff-be/latest-run-status.json
.ai-docs/multi-repo/copilot-workspace/agentic-ui-bff-be/latest-run-status.md
```

The run-local files are canonical for that run. The `latest-*` files are convenience mirrors for the most recently updated run.

## Lifecycle Coverage

The status records:

- React UI local analysis;
- Spring BFF local analysis;
- Spring BE local analysis;
- UI-BFF-BE traceability;
- Qwen semantics, including partial failure counts or skipped reason;
- local knowledge graph;
- multi-repository quality report;
- manifest update;
- all seven Copilot steps;
- final document write;
- success run summary write.

Each phase records pending/running/completed/skipped/failed/cancelled state, timestamps, safe details, and retained artifact paths. Overall status is running/completed/failed/cancelled.

## Empty Copilot Response Behavior

Before a Copilot request, the active phase records:

- prompt and context paths;
- request-started state;
- context character count;
- masked-secret count;
- included index/source identifiers.

After a response, it records model metadata, token estimates, duration, response-received state, and output character count. An empty response therefore produces an auditable failed phase with `outputCharacters: 0` instead of disappearing between prompt creation and success-only audit logging.

Failed and cancelled Copilot requests now also write best-effort entries to `multi-repo/audit/copilot-requests.jsonl`.

## Model Provider Pinning

- VS Code model selection uses `{ vendor: "copilot", id: configuredModelId }`.
- Returned metadata is filtered again defensively, so a `copilotcli` model with the same ID cannot be selected.
- One `RealCopilotClient` instance pins the chosen standard model across all seven Agentic steps.
- If the configured model is unavailable from the standard provider, the pipeline fails explicitly instead of silently switching providers.
- The Webview model picker also lists only standard `copilot` provider models.

## Resume Behavior

When the latest status belongs to the same project/branch and is failed or cancelled, the command offers:

- `Kaldığı Yerden Devam Et`
- `Yeni Analiz Başlat`
- `İptal`

Resume keeps the same run ID and workspace. It validates a contiguous artifact prefix, reuses completed local/Qwen/Copilot phases, and retries from the first failed, incomplete, or invalid phase. Prior failed attempt evidence is archived in status history.

Retry artifacts use attempt-specific names such as:

```text
cross-layer-diagrams-attempt-2-prompt.md
cross-layer-diagrams-attempt-2-context.md
cross-layer-diagrams-attempt-2.md
```

Completed Copilot outputs are loaded in canonical step order and supplied as previous-step context. Reused steps do not produce duplicate Copilot requests or audit entries.

## User-Facing Failure Handling

The command now catches pipeline failures instead of leaving an unhandled command rejection. The Turkish UI reports that partial outputs were retained and offers actions to open either the run status or the run workspace.

Status persistence errors do not replace the original analyzer/Copilot error.

## Safety

- Status files contain metadata and paths, not prompt or source contents.
- Error messages are secret-masked and bounded.
- Writes use sibling temporary files followed by rename.
- Existing commands and final-document paths remain unchanged.
- Qwen and Copilot boundary tests use mocks only.

## Verification

Passed:

```text
npm run compile
npm run test:agentic-status
npm run test:copilot-boundary
npm run test:copilot-model-selection
npm test
npm run test:fixtures
npm run test:qwen-boundary
```

The focused tests cover running/completed/failed/cancelled status, atomic JSON/Markdown mirrors, retained artifacts, duplicate provider IDs, and resume from five completed Copilot steps with only diagrams and final synthesis requested again.

## Remaining Work

- No automatic in-request Copilot retry is enabled; recovery uses the auditable resume path.
- Qwen exposes a failure count but not the individual failed item identities/errors.
- Concurrent Agentic runs still share local index/graph/quality outputs and should not be started simultaneously.
- A provider exception before any response cannot record selected model details because the current Copilot client returns them only with a response.
