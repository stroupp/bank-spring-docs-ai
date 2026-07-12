# AI Integration Test Plan

## Preconditions

1. Run `npm run compile`, `npm test`, `npm run test:qwen-boundary`, and `npm run test:copilot-boundary` first.
2. Use a small test workspace with known, non-sensitive Spring/React sources.
3. Generate local page context, evidence, traceability, and graph artifacts before invoking AI.
4. Inspect the saved context/prompt packs before sending. Confirm secrets are `[MASKED_SECRET]` and context is focused rather than repository-wide.
5. Do not paste or configure production credentials in fixtures, audit reports, or committed files.

## Real Qwen Test

1. Open Bank Spring Docs AI Qwen settings.
2. Configure a local OpenAI-compatible Qwen endpoint, or a DashScope-compatible endpoint when explicitly authorized.
3. If API-key mode is needed, store the key through the extension UI so it remains in VS Code SecretStorage.
4. Run `Bank Spring Docs: Qwen Bağlantısını Test Et`.
5. Select one page whose context and evidence artifacts are already generated.
6. Open `page-context-pack.md` and `page-evidence-pack.md`; confirm only focused source evidence is present.
7. Run selected-page Qwen semantics.
8. Verify `qwen-page-semantics.json` exists and contains `_metadata`, confidence, and uncertainty information.
9. Verify `qwen-interaction-semantics.jsonl` exists when interactions are available.
10. Run the command again without changing inputs and verify cache-hit behavior in the command result/logs.
11. Change one evidence input, regenerate it, rerun semantics, and verify a cache miss/new result.
12. Temporarily return malformed model output in a disposable local endpoint. Verify a low-confidence page semantic artifact and a raw file under the page `.cache/qwen/debug/` folder; the page pipeline must continue.
13. Stop the endpoint and rerun. Verify a Turkish error or low-confidence fallback rather than an unhandled rejection.
14. Confirm no full repository source was sent. Only the bounded selected-page context/evidence payload may cross the client boundary.

Record:

- endpoint class (local/DashScope-compatible; do not record secrets);
- model name;
- elapsed time;
- context character count;
- cache hit/miss;
- output/debug artifact paths;
- whether the output satisfies the requested JSON shape.

## Real Copilot Test

1. Launch the Extension Development Host with F5.
2. Ensure GitHub Copilot is installed, enabled, authenticated, and authorized for the test workspace.
3. Run `Bank Spring Docs: Copilot Tanılama Testi`.
4. Select one already analyzed page.
5. Open the selected page context and evidence packs and confirm focused source references, UI/BFF/BE traceability, and no unmasked secrets.
6. Generate the selected-page Copilot draft.
7. Verify `copilot-draft-context-pack.md` exists and its character count is at or below `bankSpringDocs.copilot.maxContextCharacters`.
8. Verify `copilot-draft-prompt.md` and `copilot-draft.md` exist.
9. Verify the draft metadata comment contains the page, route, branch, source artifacts, input hash, and pipeline version.
10. Open the Copilot audit log and verify model identity, input/output usage estimates, included/skipped files, masked-secret count, duration/status fields where available, and `status: success`.
11. Cancel a disposable request. Verify the audit contains `status: cancelled` and no partial draft is mistaken for a successful output.
12. Trigger a safe failure (for example, sign out in the disposable Development Host), then verify `status: failed`, a useful error, and preserved context/prompt packs.
13. Restore Copilot and run gap detection, repair if needed, final document construction, and quality scoring.
14. Verify final content cites visible sources and marks unsupported details as uncertain.

Record:

- selected model ID/family/version;
- context and output character/token estimates;
- audit path and status;
- draft/final/quality artifact paths;
- cancellation/failure handling result;
- any unsupported or invented statement found during manual review.

## Privacy and Grounding Checklist

- [ ] No full repository is present in an AI context pack.
- [ ] Context is bounded and selected-page-specific.
- [ ] Evidence contains exact relevant snippets and file paths.
- [ ] Passwords, tokens, API keys, authorization headers, and private keys are masked.
- [ ] Qwen/Copilot outputs distinguish evidence from inference.
- [ ] Audit/cache/debug files remain under local `.ai-docs` output.
- [ ] Invalid or unavailable AI output does not prevent local extraction, traceability, or evidence generation.

## Exit Criteria

- Automated boundary commands still pass without external AI access.
- One real Qwen selected-page run succeeds and one failure case degrades safely.
- One real Copilot selected-page run succeeds and success/failure or cancellation is auditable.
- Saved payloads demonstrate focused, bounded, masked context.
- Any provider-specific discrepancy is documented before changing production defaults.

