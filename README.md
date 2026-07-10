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
9. Yerel veya Copilot dokümanlarını oluşturun.

Copilot doküman üretiminde tam repository gönderilmez. Yalnızca `.ai-docs` altındaki kompakt indeksler, repo map ve varsa zenginleştirilmiş repo map kullanılır. Context preview aktifse Copilot çağrısından önce gönderilecek context dosyası kullanıcı onayına sunulur.
