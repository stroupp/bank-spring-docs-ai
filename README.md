# Bank Spring Docs AI

Bank Spring Docs AI is a VS Code extension MVP for generating technical documentation from Java Spring Boot repositories hosted in Bitbucket.

The extension analyzes code locally first and writes compact indexes under `.ai-docs/` so Copilot receives only selected context, not the full repository.

## MVP Features

- Command: `Bank Spring Docs: Analyze Repository URL`
- Bitbucket SSH and HTTPS URL input
- Branch input with `release/liv` default
- Local clone or fetch/update into VS Code extension storage
- Java Spring Boot file scan
- Local JSONL indexes:
  - `file-index.jsonl`
  - `spring-components.jsonl`
  - `api-endpoints.jsonl`
- Compact `repo-map.md`

## Security Model

- No database
- No vector database
- No external storage
- No Copilot chat UI automation
- Local file-based indexes only
- Designed to use VS Code Language Model API for AI requests

## Development

```bash
npm install
npm run compile
```

Run the extension from VS Code using the Extension Development Host.

## Türkçe Arayüz

1. VS Code'da `F5` ile **Run Bank Spring Docs AI** debug profilini çalıştırın.
2. Açılan **Extension Development Host** penceresinde sol aktivite çubuğundaki **Bank Spring Docs** ikonuna tıklayın.
3. **Dokümantasyon Paneli** içinde Bitbucket repository URL ve branch bilgisini girin.
4. **Repository Analiz Et** butonuna basın.

Paneldeki açıklamalar, butonlar ve durum mesajları Türkçedir.

## Qwen Yerel Semantik Analiz

Bank Spring Docs AI, isteğe bağlı olarak yerel çalışan Qwen modelleriyle semantik zenginleştirme yapabilir. Qwen çağrıları yerel ve kullanıcı tarafından yapılandırılabilir endpoint üzerinden yapılır.

Örnek endpoint değerleri:

```text
http://localhost:8000/v1/chat/completions
http://localhost:11434/v1/chat/completions
```

Örnek model adları:

```text
Qwen/Qwen3.6-27B
qwen3-coder
qwen2.5-coder
```

API key opsiyoneldir. API key kullanılırsa normal ayar dosyalarına yazılmaz; VS Code SecretStorage içinde `bankSpringDocs.qwen.apiKey` anahtarıyla saklanır.

## Banking Qwen Environment

The Qwen settings modal includes a `Banking environment (ONIKS / internal vLLM)` checkbox. Paste the approved HTTPS endpoint into the endpoint field; it must end exactly with `/v1/chat/completions`. Enabling banking mode leaves that user-supplied endpoint intact, enables Qwen, and presets the approved banking request contract:

```text
Method: POST
Content-Type: application/json
model: ONIKS
temperature: 0.6
max_tokens: 16384
Authorization: not sent
```

Banking form presetleri yarım Qwen3.6-27B profili olarak `maxTokens=16384`, `contextWindowTokens=131072`, `generationMaxTokens=16384` ve analysis/reduce/synthesis `16384` değerlerini kullanır. Bunlar yalnız model-kapasitesi başlangıç değerleridir; endpoint deployment'ının gerçek limitleri daha düşükse özellikle `contextWindowTokens` o gerçek `max_model_len` değerine indirilmelidir.

When the banking settings are saved or tested, the explicitly pasted host is approved only in machine-scoped VS Code settings. Banking mode validates HTTPS and the exact `/v1/chat/completions` path; ports, alternate paths, query strings, embedded credentials, and redirects are rejected. No institutional host is stored in the repository. `ONIKS` is treated as an approved Qwen3 deployment alias only inside this machine-scoped banking mode.

`Qwen Bağlantısını Test Et` saves the visible settings and sends a real, short system/user probe that requests `{"ok":true}` with a fixed 64-token output cap. The result, effective model, and endpoint are displayed inside the modal. The probe does not include repository source and never inherits a very large configured generation cap. Full document generation keeps using the separate bounded `bankSpringDocs.qwen.generationMaxTokens` and `bankSpringDocs.qwen.contextWindowTokens` settings.

## Selected-Page Qwen3.6-Only Mode

The selected-page panel has a `Bu sayfanin tum AI adimlarini yalnizca Qwen3.6 ile calistir` checkbox. It is on by default for fresh installations and does not change `bankSpringDocs.ai.provider`. When enabled, the full-page command creates one explicit Qwen3.6 client snapshot and runs deterministic page-flow/context/evidence artifacts directly through evidence ledgers, bounded reduction, grouped synthesis, and evidence-backed gap repair. It never runs the Qwen semantic pre-pass and never falls back to Copilot. The existing deterministic final-document and quality stages remain in place.

Copilot page analysis also has an advanced `Copilot sayfa analizinde Qwen semantik on adimini ve context'ini kullan` checkbox, backed by `bankSpringDocs.pageAnalysis.copilotQwenSemanticPrepassEnabled`. It is off by default. Enabling it lets Qwen enrich the separate Copilot workflow; disabling it keeps semantic artifacts out of Copilot draft/repair context. Qwen-only analysis always bypasses this semantic pre-pass and excludes old semantic artifacts from iterative context and repair. Copilot context is packed by balanced Markdown sections so late BFF, Feign/outbound, and BE evidence cannot be starved by a large leading UI section. Per-artifact source/sent/truncation decisions are recorded in `copilot-draft-context-selection.json`.

Large UI/BFF/BE pages are processed as bounded evidence chunks. The pipeline reads only source files linked to the selected page flow, shares the raw-source budget fairly across UI, BFF, and BE, masks secrets, stores each masked prompt/context/output, recursively reduces evidence ledgers when needed, and resumes completed steps after cancellation or failure.

Qwen-only publishing also creates an evidence-bound `UML ve Akış Diyagramları` section without another model request. Mermaid source and the local `page-flow-uml.svg` fallback are generated deterministically from `page-flow.json`, so the final Markdown preview can display UI → BFF → BE → repository/entity mappings even when Mermaid rendering is unavailable. Opening or completing a final page analysis opens the Markdown preview beside the source document.

Generated artifacts are written under the selected page output:

```text
qwen-draft.md
copilot-draft.md                 # compatibility contract for gap/final/quality stages
.qwen3-page-draft/latest-run.json
.qwen3-page-draft/runs/<input-hash>/run-manifest.json
.qwen3-page-draft/runs/<input-hash>/steps/*-prompt.md
```

The advanced limits are `bankSpringDocs.pageAnalysis.qwenMaxSourceFileCharacters`, `bankSpringDocs.pageAnalysis.qwenMaxTotalSourceCharacters`, `bankSpringDocs.pageAnalysis.qwenMaxModelCalls`, and `bankSpringDocs.pageAnalysis.qwenMaxReduceLevels`. Input request size is derived conservatively from `bankSpringDocs.qwen.contextWindowTokens` and the largest phase-specific output budget. Every Qwen path shares one FIFO request gate in the VS Code extension host, so separate commands and client instances cannot overlap HTTP requests. `bankSpringDocs.qwen.interRequestDelaySeconds` starts after a response/error settles and delays only the next queued Qwen call; its default is 15 seconds and `0` disables it. Retries re-enter the same queue.

Qwen-only page analysis uses separate bounded output budgets for evidence chunk analysis, ledger reduction, and grouped final synthesis. Transient `429`, `502`, `503`, `504`, and network-timeout failures are retried with bounded exponential backoff. Size-correlated `413`, context-window, output-length, and exhausted timeout/504 failures split only the affected evidence chunk into smaller overlapping children; capacity errors such as persistent `503` are not multiplied through adaptive splitting. Final section groups also subdivide after a size-correlated failure. Completed sibling steps remain resumable, and synthesis-only tuning reuses unchanged evidence maps.

For Qwen3.6, evidence and ledger-reduce requests use the official non-thinking profile (`temperature=0.7`, `top_p=0.8`, `top_k=20`, `presence_penalty=1.5`); synthesis and genuine gap repair use the precise-coding thinking profile (`temperature=0.6`, `top_p=0.95`, `top_k=20`, `presence_penalty=0`). Local/banking vLLM requests send `chat_template_kwargs.enable_thinking`; DashScope-compatible endpoints use top-level `enable_thinking`.

Extracted findings are retained as facts only when their source reference is the supplied chunk label or a visible path in that chunk; otherwise they are demoted to uncertainties. Aggregate source references and uncertainties are projected into their final canonical sections. Qwen gap repair uses one target section per request with the full configured synthesis ceiling, and a missing repair heading is omitted so it cannot overwrite a useful existing draft section. The Copilot page-draft and repair paths do not use these Qwen-only controls.

For a deployment whose real total model context is still 16K, use this lower compatibility profile instead of the Qwen3.6 half-capacity defaults:

```json
{
  "bankSpringDocs.qwen.contextWindowTokens": 16000,
  "bankSpringDocs.qwen.generationMaxTokens": 4096,
  "bankSpringDocs.qwen.maxTokens": 4096,
  "bankSpringDocs.qwen.interRequestDelaySeconds": 15,
  "bankSpringDocs.pageAnalysis.qwenAnalysisMaxOutputTokens": 2048,
  "bankSpringDocs.pageAnalysis.qwenReduceMaxOutputTokens": 3072,
  "bankSpringDocs.pageAnalysis.qwenSynthesisMaxOutputTokens": 4096
}
```

`qwen.maxTokens` is the general/connection-test cap; the Qwen-only page pipeline uses the phase-specific values above, each capped by `qwen.generationMaxTokens`. `qwenMaxTotalSourceCharacters` is an aggregate source budget distributed over many calls, not a single-request input size.

## Full-Pipeline AI Provider

All model-backed documentation stages can use either GitHub Copilot or the configured Qwen endpoint. Select the provider from the side panel or configure:

```json
{
  "bankSpringDocs.ai.provider": "qwen",
  "bankSpringDocs.qwen.enabled": true,
  "bankSpringDocs.qwen.endpoint": "http://localhost:8000/v1/chat/completions",
  "bankSpringDocs.qwen.allowedHosts": ["localhost", "127.0.0.1", "::1"],
  "bankSpringDocs.qwen.model": "Qwen/Qwen3.6-27B",
  "bankSpringDocs.qwen.temperature": 0.6,
  "bankSpringDocs.qwen.contextWindowTokens": 131072,
  "bankSpringDocs.qwen.maxTokens": 16384,
  "bankSpringDocs.qwen.generationMaxTokens": 16384,
  "bankSpringDocs.qwen.interRequestDelaySeconds": 15,
  "bankSpringDocs.qwen.generationTimeoutSeconds": 600,
  "bankSpringDocs.pageAnalysis.qwenAnalysisMaxOutputTokens": 16384,
  "bankSpringDocs.pageAnalysis.qwenReduceMaxOutputTokens": 16384,
  "bankSpringDocs.pageAnalysis.qwenSynthesisMaxOutputTokens": 16384
}
```

Fresh installations default to the Qwen provider, enable Qwen, select `Qwen/Qwen3.6-27B`, and enable selected-page Qwen-only mode. There is no automatic fallback between providers. Existing Copilot selections and command IDs remain available and artifact filenames are retained for compatibility, while audits record the provider and model actually used.

Qwen3.6 supports a native 262144-token context and recommends 32768 output tokens for most queries. The defaults intentionally use half of both capacities: 131072 context and 16384 output. `bankSpringDocs.qwen.contextWindowTokens` must still reflect the endpoint deployment's real `max_model_len`; do not use 131072 when an internal gateway or vLLM deployment exposes a smaller limit.

Qwen calls require a trusted VS Code workspace. The endpoint and exact-host allowlist are machine-scoped settings, so repository workspace settings cannot redirect evidence. Saving or testing banking mode approves the explicitly pasted host there; non-banking hosts can be managed through `bankSpringDocs.qwen.allowedHosts`, and loopback hosts are allowed by default.

The provider option affects single-repository AI documents, backend Agentic documents, UI-BFF-BE Agentic documents, selected-page drafts, and gap repair. Deterministic local extraction, traceability, graph, freshness, and quality stages are unchanged.

## Yeni Çıktı Klasörleri

```text
.ai-docs/
  analysis-report.md
  analysis-report.json
  audit/
    copilot-requests.jsonl
  context-packs/
    last-copilot-context.md
  semantic/
    classes/
    endpoints/
    dependencies/
    modules/
    debug/
  enriched/
    enriched-repo-map.md
    enriched-components.jsonl
    enriched-endpoints.jsonl
    enriched-dependencies.jsonl
```

## Önerilen Kullanım Akışı

1. `Bank Spring Docs: Paneli Aç` komutuyla paneli açın.
2. Bitbucket repository URL ve branch bilgisini girin.
3. Çalışma klasörünü seçin.
4. `Repository Analiz Et` ile yerel indeksleri oluşturun.
5. Qwen ayarlarını girin ve `Qwen Ayarlarını Kaydet` butonuna basın.
6. `Qwen Bağlantısını Test Et` ile yerel model bağlantısını doğrulayın.
7. `Qwen ile Semantik Analiz Oluştur` komutunu çalıştırın.
8. `Zenginleştirilmiş Repo Haritası Oluştur` komutunu çalıştırın.
9. Yerel dokümanları veya seçili AI sağlayıcısıyla AI dokümanlarını oluşturun.

AI doküman üretiminde tam repository gönderilmez. Yalnızca `.ai-docs` altındaki kompakt indeksler, repo map ve varsa zenginleştirilmiş repo map kullanılır. Selected-page Qwen3-only modu ek olarak sadece page-flow ile ilişkilendirilmiş, sınırlı UI/BFF/BE kaynak dosyalarını iteratif kanıt olarak kullanır. Context preview aktifse model çağrısından önce gönderilecek context dosyası kullanıcı onayına sunulur.
