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
qwen3
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
max_tokens: 163849
Authorization: not sent
```

When the banking settings are saved or tested, the explicitly pasted host is approved only in machine-scoped VS Code settings. Banking mode validates HTTPS and the exact `/v1/chat/completions` path; ports, alternate paths, query strings, embedded credentials, and redirects are rejected. No institutional host is stored in the repository. `ONIKS` is treated as an approved Qwen3 deployment alias only inside this machine-scoped banking mode.

`Qwen Bağlantısını Test Et` saves the visible settings and sends a real, short system/user probe that requests `{"ok":true}`. The result, effective model, and endpoint are displayed inside the modal. The probe does not include repository source. Full document generation keeps using the separate bounded `bankSpringDocs.qwen.generationMaxTokens` and `bankSpringDocs.qwen.contextWindowTokens` settings.

## Selected-Page Qwen3-Only Mode

The selected-page panel has a `Bu sayfanin tum AI adimlarini yalnizca Qwen3 ile calistir` checkbox. It is off by default and does not change `bankSpringDocs.ai.provider`. When enabled, the full-page command creates one explicit Qwen3 client snapshot for semantic analysis, drafting, and gap repair; every provider/model response is validated and the pipeline never falls back to Copilot. The existing deterministic context, final-document, and quality stages remain in place.

Large UI/BFF/BE pages are processed as bounded evidence chunks. The pipeline reads only source files linked to the selected page flow, shares the raw-source budget fairly across UI, BFF, and BE, masks secrets, stores each masked prompt/context/output, recursively reduces evidence ledgers when needed, and resumes completed steps after cancellation or failure.

Generated artifacts are written under the selected page output:

```text
qwen-draft.md
copilot-draft.md                 # compatibility contract for gap/final/quality stages
.qwen3-page-draft/latest-run.json
.qwen3-page-draft/runs/<input-hash>/run-manifest.json
.qwen3-page-draft/runs/<input-hash>/steps/*-prompt.md
```

The advanced limits are `bankSpringDocs.pageAnalysis.qwenMaxSourceFileCharacters`, `bankSpringDocs.pageAnalysis.qwenMaxTotalSourceCharacters`, `bankSpringDocs.pageAnalysis.qwenMaxModelCalls`, and `bankSpringDocs.pageAnalysis.qwenMaxReduceLevels`. Input request size is derived conservatively from `bankSpringDocs.qwen.contextWindowTokens` and `bankSpringDocs.qwen.generationMaxTokens`.

## Full-Pipeline AI Provider

All model-backed documentation stages can use either GitHub Copilot or the configured Qwen endpoint. Select the provider from the side panel or configure:

```json
{
  "bankSpringDocs.ai.provider": "qwen",
  "bankSpringDocs.qwen.enabled": true,
  "bankSpringDocs.qwen.endpoint": "http://localhost:8000/v1/chat/completions",
  "bankSpringDocs.qwen.allowedHosts": ["localhost", "127.0.0.1", "::1"],
  "bankSpringDocs.qwen.model": "qwen3-30b-a3b-instruct",
  "bankSpringDocs.qwen.contextWindowTokens": 131072,
  "bankSpringDocs.qwen.generationMaxTokens": 16384,
  "bankSpringDocs.qwen.generationTimeoutSeconds": 600
}
```

The default provider remains `copilot`. There is no automatic fallback between providers. Existing Copilot command IDs and artifact filenames are retained for compatibility, while audits record the provider and model actually used.

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
