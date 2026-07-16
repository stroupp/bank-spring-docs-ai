# Qwen Full-Pipeline Generation Provider

## Outcome

Bank Spring Docs AI now has one global documentation provider setting:

```text
bankSpringDocs.ai.provider = copilot | qwen
```

The default remains `copilot`. Selecting `qwen` routes every active model-backed documentation stage through the configured OpenAI-compatible Qwen endpoint. There is no automatic provider fallback.

## Covered Pipelines

- single-repository generated documents;
- single-repository Agentic backend documentation;
- UI-BFF-BE seven-step Agentic documentation;
- selected-page draft generation;
- selected-page gap repair;
- the legacy documentation generator boundary.

Local extraction, traceability matching, graph construction, artifact freshness, gap detection, final merging, and quality scoring remain deterministic TypeScript stages.

## Compatibility

Existing command IDs, generated filenames, workspace folders, and `copilot-requests.jsonl` remain available for backward compatibility. Audit entries now include the truthful `provider`, model metadata, provider token usage when returned, finish reason, and request ID.

Single-document, page-draft, backend Agentic, and page gap-repair paths record failed/cancelled requests as well as successful responses. Provider error text is secret-masked and Qwen HTTP response bodies are deliberately omitted.

## Qwen Request Behavior

- instructions and evidence are sent as separate `system` and `user` messages;
- empty responses and `finish_reason=length` are rejected;
- cancellation and timeout failures are reported separately;
- reasoning content is ignored and is not persisted;
- a conservative prompt/output preflight checks the configured context window using a denser Turkish/code estimate plus chat-template overhead;
- the default generation timeout is 600 seconds;
- the default generation output limit is 16,384 tokens;
- the default configured context window is 131,072 tokens.

## Resume Safety

New UI-BFF-BE Agentic runs record their generation provider, configured model, and a secret-free Qwen deployment/generation fingerprint. The fingerprint covers the normalized endpoint, model, temperature, timeout, output limit, and context-window setting. A failed run is resumable only when the current provider, model, and recorded fingerprint are compatible. A Copilot run is therefore not silently resumed with Qwen, and a Qwen run is not silently resumed against another endpoint or generation configuration.

Legacy run IDs, phase IDs, and `copilot-workspace` paths are retained so existing status readers continue to work.

## Banking Safety Improvements

- Qwen semantic contexts are secret-masked before transmission and context-pack persistence.
- Cancellation stops semantic loops instead of being recorded as an ordinary item failure.
- model prompts treat repository comments and artifact text as untrusted evidence rather than executable instructions.
- no full repository is sent by the provider switch; existing bounded context/evidence selection remains in force.
- artifact-controlled source paths are resolved and checked against their repository root before any semantic source read.
- Qwen HTTP error bodies and endpoint credentials/query details are not copied into generation errors or audits.
- Qwen calls require a trusted VS Code workspace; the endpoint and exact-host allowlist are machine-scoped so repository settings cannot redirect evidence.
- API keys remain in VS Code SecretStorage.

Provider changes are synchronized across both Webviews. Invalid provider settings are shown explicitly, and model/HTTP failures are caught at the command boundary with Turkish UI errors. Agentic run-status writes retry transient Windows file locks and retain a bounded overwrite fallback so resumable status is not lost solely because an antivirus or indexer briefly holds the destination.

The extension does not enforce that the configured endpoint is physically local. A bank deployment must use an approved internal endpoint and network egress policy.

## Recommended Bank Configuration

```json
{
  "bankSpringDocs.ai.provider": "qwen",
  "bankSpringDocs.qwen.enabled": true,
  "bankSpringDocs.qwen.endpoint": "https://approved-internal-qwen.example/v1/chat/completions",
  "bankSpringDocs.qwen.allowedHosts": ["approved-internal-qwen.example"],
  "bankSpringDocs.qwen.model": "<exact-pinned-model-name>",
  "bankSpringDocs.qwen.contextWindowTokens": 131072,
  "bankSpringDocs.qwen.generationMaxTokens": 16384,
  "bankSpringDocs.qwen.generationTimeoutSeconds": 600
}
```

Pin the exact model checkpoint/digest and set the context value to the inference server's real configured capacity, not only the checkpoint's advertised maximum.

## Known Limitations

- Qwen document requests currently use non-streaming OpenAI-compatible responses.
- Existing artifact names still contain `copilot` for compatibility.
- The legacy audit filename is still `copilot-requests.jsonl`, although each new entry identifies its actual provider.
- `qwen.enabled` gates all Qwen integration; the existing Agentic semantics flag separately decides whether the optional Qwen semantic phase runs inside the multi-repo Agentic pipeline.
- The extension enforces an exact endpoint-host allowlist, but bank deployment policy must still govern that machine setting, TLS/mTLS, DNS, and network egress.
- Hybrid-thinking Qwen server behavior is not negotiated automatically; use a validated Instruct/server profile whose final-answer token behavior is known.
- Model quality must be validated against bank-owned representative repositories before Copilot is disabled operationally.

## Verification

Mock-only tests cover provider selection, Qwen role separation, usage/model metadata, truncation rejection, context preflight, absence of automatic fallback, Agentic provider/model resume pinning, and transient Windows run-status rename recovery. Existing Copilot and Qwen boundary tests remain in place and do not make live AI calls.
