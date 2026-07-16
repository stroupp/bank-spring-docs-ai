import * as vscode from "vscode";
import type { QwenConnectionResult } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { AnalyzeRepositoryUrlCommand } from "../commands/analyzeRepositoryUrlCommand";
import { getDefaultBranch } from "../git/branchResolver";

type AiProvider = "copilot" | "qwen";
type AiProviderUiValue = AiProvider | "invalid";

type QwenUiSettings = {
  enabled: boolean;
  bankingEnvironment: boolean;
  qwenContextWindowTokens: number;
  qwenGenerationMaxTokens: number;
  qwenAnalysisMaxOutputTokens: number;
  qwenReduceMaxOutputTokens: number;
  qwenSynthesisMaxOutputTokens: number;
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  interRequestDelaySeconds: number;
  useApiKey: boolean;
  semanticCacheEnabled?: boolean;
  semanticMaxFilesPerRun?: number;
  semanticMaxCharactersPerFile?: number;
  apiKey?: string;
};

type PanelMessage =
  | { type: "ready" }
  | { type: "selectWorkspace" }
  | { type: "analyze"; repoUrl: string; branch: string }
  | { type: "command"; command: string }
  | { type: "saveAiProvider"; provider: AiProvider }
  | { type: "saveCopilotQwenSemanticPrepass"; enabled: boolean }
  | { type: "saveQwenSettings"; settings: QwenUiSettings }
  | { type: "testQwenConnection"; settings: QwenUiSettings };

export class BankSpringDocsPanel {
  static currentPanel: BankSpringDocsPanel | undefined;
  private readonly configurationListener: vscode.Disposable;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly analyzeCommand: AnalyzeRepositoryUrlCommand
  ) {
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("bankSpringDocs.ai.provider")
        || event.affectsConfiguration("bankSpringDocs.pageAnalysis.copilotQwenSemanticPrepassEnabled")
      ) {
        this.postSettings();
      }
    });
    this.panel.onDidDispose(() => {
      this.configurationListener.dispose();
      BankSpringDocsPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => this.handleMessage(message));
  }

  static open(context: vscode.ExtensionContext, analyzeCommand: AnalyzeRepositoryUrlCommand): void {
    if (BankSpringDocsPanel.currentPanel) {
      BankSpringDocsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      BankSpringDocsPanel.currentPanel.postSettings();
      return;
    }

    const panel = vscode.window.createWebviewPanel("bankSpringDocs.dashboardPanel", "Bank Spring Docs AI", vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
      retainContextWhenHidden: true
    });

    const instance = new BankSpringDocsPanel(panel, context, analyzeCommand);
    BankSpringDocsPanel.currentPanel = instance;
    panel.webview.html = instance.getHtml();
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    if (message.type === "ready") {
      this.postSettings();
      return;
    }

    if (message.type === "selectWorkspace") {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Bank Spring Docs çalışma klasörü seç"
      });
      const folder = selected?.[0]?.fsPath;
      if (folder) {
        await vscode.workspace.getConfiguration("bankSpringDocs").update("workspaceFolder", folder, vscode.ConfigurationTarget.Global);
        this.postSettings();
      }
      return;
    }

    if (message.type === "command") {
      try {
        await vscode.commands.executeCommand(message.command);
      } catch (error) {
        this.panel.webview.postMessage({
          type: "error",
          message: `Komut tamamlanamadı: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "saveAiProvider") {
      if (message.provider !== "copilot" && message.provider !== "qwen") {
        this.panel.webview.postMessage({ type: "error", message: "Geçersiz AI doküman sağlayıcısı seçildi." });
        return;
      }
      try {
        await vscode.workspace.getConfiguration("bankSpringDocs").update("ai.provider", message.provider, vscode.ConfigurationTarget.Global);
        this.postSettings();
        this.panel.webview.postMessage({
          type: "aiProviderSaved",
          message: `AI doküman sağlayıcısı ${message.provider === "qwen" ? "Qwen" : "GitHub Copilot"} olarak kaydedildi.`
        });
      } catch (error) {
        this.panel.webview.postMessage({
          type: "error",
          message: `AI doküman sağlayıcısı kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "saveCopilotQwenSemanticPrepass") {
      try {
        await vscode.workspace.getConfiguration("bankSpringDocs").update(
          "pageAnalysis.copilotQwenSemanticPrepassEnabled",
          Boolean(message.enabled),
          vscode.ConfigurationTarget.Global
        );
        this.postSettings();
      } catch (error) {
        this.panel.webview.postMessage({
          type: "error",
          message: `Copilot Qwen semantik ön adım ayarı kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "saveQwenSettings") {
      try {
        await saveQwenLimitSettings(message.settings);
        await vscode.commands.executeCommand("bankSpringDocs.saveQwenSettings", message.settings);
        this.postSettings();
      } catch (error) {
        this.panel.webview.postMessage({
          type: "error",
          message: `Qwen ayarları kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "testQwenConnection") {
      this.panel.webview.postMessage({
        type: "qwenTestResult",
        testing: true,
        message: "Qwen endpoint'ine kısa test isteği gönderiliyor..."
      });
      try {
        await saveQwenLimitSettings(message.settings);
        const result = await vscode.commands.executeCommand<QwenConnectionResult>("bankSpringDocs.testQwenConnection", message.settings);
        this.panel.webview.postMessage({
          type: "qwenTestResult",
          testing: false,
          ok: result?.ok ?? false,
          message: result?.message ?? "Qwen bağlantı testi sonuç döndürmedi.",
          model: result?.model,
          endpoint: result?.endpoint
        });
      } catch (error) {
        this.panel.webview.postMessage({
          type: "qwenTestResult",
          testing: false,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      this.postSettings();
      return;
    }

    const repoUrl = message.repoUrl.trim();
    const branch = message.branch.trim() || getDefaultBranch();
    if (!repoUrl) {
      this.panel.webview.postMessage({ type: "error", message: "Bitbucket repository URL alanı zorunludur." });
      return;
    }

    try {
      this.panel.webview.postMessage({ type: "busy", message: "Repository hazırlanıyor ve yerel analiz başlatılıyor..." });
      const result = await this.analyzeCommand.analyzeRepository(repoUrl, branch);
      this.panel.webview.postMessage({
        type: "done",
        message: `Analiz tamamlandı. ${result.indexedFiles} dosya indekslendi.`,
        aiDocsPath: result.aiDocsPath
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.panel.webview.postMessage({ type: "error", message: messageText });
    }
  }

  private postSettings(): void {
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    this.panel.webview.postMessage({
      type: "settings",
      defaultBranch: getDefaultBranch(),
      workspaceFolder: config.get<string>("workspaceFolder", ""),
      ai: {
        provider: normalizeAiProvider(config.get<string>("ai.provider", "qwen"))
      },
      qwen: {
        ...new QwenSettingsService(this.context).getSettings(),
        qwenContextWindowTokens: config.get<number>("qwen.contextWindowTokens", 131072),
        qwenGenerationMaxTokens: config.get<number>("qwen.generationMaxTokens", 16384),
        qwenAnalysisMaxOutputTokens: config.get<number>("pageAnalysis.qwenAnalysisMaxOutputTokens", 16384),
        qwenReduceMaxOutputTokens: config.get<number>("pageAnalysis.qwenReduceMaxOutputTokens", 16384),
        qwenSynthesisMaxOutputTokens: config.get<number>("pageAnalysis.qwenSynthesisMaxOutputTokens", 16384)
      },
      semantic: {
        cacheEnabled: config.get<boolean>("semantic.cacheEnabled", true),
        maxFilesPerRun: config.get<number>("semantic.maxFilesPerRun", 50),
        maxCharactersPerFile: config.get<number>("semantic.maxCharactersPerFile", 20000)
      },
      pageAnalysis: {
        copilotQwenSemanticPrepassEnabled: config.get<boolean>("pageAnalysis.copilotQwenSemanticPrepassEnabled", false)
      }
    });
  }

  private getHtml(): string {
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bank Spring Docs AI</title>
  <style>
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 18px;
    }

    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    h1, h2, h3 {
      margin: 0;
    }

    h1 {
      font-size: 26px;
      font-weight: 750;
    }

    h2 {
      font-size: 16px;
      font-weight: 700;
    }

    h3 {
      font-size: 13px;
      font-weight: 700;
    }

    .muted {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }

    .headerActions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(340px, 0.9fr) minmax(420px, 1.3fr);
      gap: 18px;
      align-items: start;
    }

    .panel, .scenario {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
    }

    .panel {
      padding: 16px;
      display: grid;
      gap: 14px;
    }

    .scenarioGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .scenario {
      padding: 14px;
      display: grid;
      gap: 12px;
    }

    .scenarioHeader {
      display: grid;
      gap: 4px;
      min-height: 58px;
    }

    .buttonGrid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }

    label {
      display: grid;
      gap: 6px;
      font-weight: 650;
    }

    input, select {
      box-sizing: border-box;
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 8px 10px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-font-family);
    }

    select {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
    }

    input:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    input[type="checkbox"] {
      width: auto;
      min-height: auto;
    }

    .checkLabel {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }

    button {
      min-height: 34px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 8px 11px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-family: var(--vscode-font-family);
      font-weight: 650;
      cursor: pointer;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    button.ghost {
      color: var(--vscode-foreground);
      background: transparent;
      border-color: var(--vscode-panel-border);
    }

    .folderRow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: end;
    }

    .status {
      min-height: 72px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      background: var(--vscode-editor-background);
      line-height: 1.45;
      word-break: break-word;
    }

    .status strong {
      display: block;
      margin-bottom: 4px;
    }

    .modalBackdrop {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 20;
      background: rgba(0, 0, 0, 0.45);
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .modalBackdrop.open {
      display: flex;
    }

    .modal {
      width: min(720px, 100%);
      max-height: min(760px, 92vh);
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      box-shadow: 0 16px 44px rgba(0, 0, 0, 0.35);
    }

    .modalHeader, .modalFooter {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .modalFooter {
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 0;
      justify-content: flex-end;
    }

    .modalBody {
      padding: 16px;
      display: grid;
      gap: 14px;
    }

    .formGrid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .wide {
      grid-column: 1 / -1;
    }

    @media (max-width: 860px) {
      .layout, .scenarioGrid, .formGrid {
        grid-template-columns: 1fr;
      }

      header {
        display: grid;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        <h1>Bank Spring Docs AI</h1>
        <div class="muted">Java Spring Boot repository'lerini yerelde analiz eder, semantik olarak zenginleştirir ve kompakt AI context paketleri üretir.</div>
        <div class="muted">Varsayılan branch: <strong id="defaultBranch">release/liv</strong></div>
      </div>
      <div class="headerActions">
        <button class="ghost" id="openQwenSettingsButton" type="button">Qwen Ayarları</button>
        <button class="ghost" data-command="bankSpringDocs.openGeneratedDocs" type="button">Çıktı Klasörü</button>
      </div>
    </header>

    <section class="panel">
      <label>
        AI Doküman Sağlayıcısı
        <select id="aiProviderSelect">
          <option value="invalid" disabled>Geçersiz sağlayıcı ayarı</option>
          <option value="copilot">GitHub Copilot</option>
          <option value="qwen">Qwen (Yapılandırılmış Endpoint)</option>
        </select>
      </label>
      <div class="muted">Seçim, tüm AI destekli doküman üretim adımlarında kullanılır. Yerel analiz adımları değişmez.</div>
      <label class="checkLabel">
        <input id="copilotQwenSemanticPrepassEnabled" type="checkbox">
        Gelişmiş: Copilot sayfa analizinde Qwen semantik ön adımını ve context'ini kullan
      </label>
      <div class="muted">Varsayılan olarak kapalıdır ve yalnız Copilot'u zenginleştirir. Qwen-only akışı semantic ön adımı ve eski semantic artifact'leri her zaman atlar.</div>
    </section>

    <section class="layout">
      <div class="panel">
        <h2>Repository Analizi</h2>
        <label>
          Bitbucket Repository URL
          <input id="repoUrl" type="text" placeholder="ssh://git@bitbucket.bank.local/project/repo.git">
        </label>
        <label>
          Branch
          <input id="branch" type="text" placeholder="Boş bırakılırsa release/liv kullanılır">
        </label>
        <div class="folderRow">
          <label>
            Çalışma Klasörü
            <input id="workspaceFolder" type="text" readonly placeholder="Seçilmezse VS Code global storage kullanılır">
          </label>
          <button id="selectWorkspaceButton" type="button">Seç</button>
        </div>
        <button id="analyzeButton">Repository Analiz Et</button>
        <div class="status" id="status">
          <strong>Hazır</strong>
          Önce repository analizi çalıştır. Sonra yerel doküman, Qwen zenginleştirme veya AI dokümantasyon senaryolarını seçebilirsin.
        </div>
      </div>

      <div class="scenarioGrid">
        <section class="scenario">
          <div class="scenarioHeader">
            <h2>1. Yerel Dokümantasyon</h2>
            <div class="muted">Copilot veya Qwen gerekmeden indekslerden Markdown üretir.</div>
          </div>
          <div class="buttonGrid">
            <button data-command="bankSpringDocs.generateAllLocalDocs">Tüm Yerel Dokümanları Oluştur</button>
            <button class="secondary" data-command="bankSpringDocs.generateRepositoryOverview">Repository Özeti</button>
            <button class="secondary" data-command="bankSpringDocs.generateApiDocumentation">API Dokümantasyonu</button>
            <button class="secondary" data-command="bankSpringDocs.generateAnalysisQualityReport">Analiz Kalite Raporu</button>
          </div>
        </section>

        <section class="scenario">
          <div class="scenarioHeader">
            <h2>2. Qwen Semantik Zenginleştirme</h2>
            <div class="muted">Yerel veya yapılandırılmış Qwen endpoint'iyle sınıf, endpoint ve bağımlılık açıklamaları üretir.</div>
          </div>
          <div class="buttonGrid">
            <button data-command="bankSpringDocs.generateQwenSemanticAnalysis">Qwen ile Semantik Analiz Oluştur</button>
            <button class="secondary" data-command="bankSpringDocs.generateEnrichedRepoMap">Zenginleştirilmiş Repo Haritası</button>
            <button class="secondary" id="quickTestQwenButton" type="button">Qwen Bağlantısını Test Et</button>
          </div>
        </section>

        <section class="scenario">
          <div class="scenarioHeader">
            <h2>3. AI Dokümantasyonu</h2>
            <div class="muted">Tam repo değil, sadece kompakt ve maskelenmiş context paketleri seçili AI sağlayıcısına gönderilir.</div>
          </div>
          <div class="buttonGrid">
            <button data-command="bankSpringDocs.generateAllCopilotDocs">Tüm AI Dokümanlarını Oluştur</button>
            <button class="secondary" data-command="bankSpringDocs.generateCopilotSpringArchitecture">AI Spring Mimari</button>
            <button class="secondary" data-command="bankSpringDocs.generateCopilotApiDocumentation">AI API Dokümanı</button>
            <button class="secondary" data-command="bankSpringDocs.runCopilotDiagnostics">Copilot Tanılama Testi</button>
            <button class="secondary" data-command="bankSpringDocs.openLastCopilotContext">Son Context Paketini Aç</button>
          </div>
        </section>

        <section class="scenario">
          <div class="scenarioHeader">
            <h2>4. İnceleme ve Bakım</h2>
            <div class="muted">Üretilen çıktıları, audit logları ve yerel cache'i yönetir.</div>
          </div>
          <div class="buttonGrid">
            <button data-command="bankSpringDocs.openRepoMap">Repo Haritasını Aç</button>
            <button class="secondary" data-command="bankSpringDocs.openGeneratedDocs">Çıktı Klasörünü Aç</button>
            <button class="secondary" data-command="bankSpringDocs.openCopilotAuditLog">AI Audit Log Aç</button>
            <button class="secondary" data-command="bankSpringDocs.clearLocalCache">Yerel Önbelleği Temizle</button>
          </div>
        </section>
      </div>
    </section>
  </main>

  <div class="modalBackdrop" id="qwenModal" role="dialog" aria-modal="true" aria-labelledby="qwenModalTitle">
    <div class="modal">
      <div class="modalHeader">
        <div>
          <h2 id="qwenModalTitle">Qwen Ayarları</h2>
          <div class="muted">Endpoint, model, API key ve semantik cache ayarları burada yönetilir. Onaylı host listesi ile uzun AI doküman üretim limitleri VS Code makine ayarlarındadır.</div>
        </div>
        <button class="ghost" id="closeQwenSettingsButton" type="button">Kapat</button>
      </div>
      <div class="modalBody">
        <label class="checkLabel wide">
          <input id="qwenEnabled" type="checkbox">
          Qwen entegrasyonu aktif (semantik analiz ve AI doküman üretimi)
        </label>
        <label class="checkLabel wide">
          <input id="qwenBankingEnvironment" type="checkbox">
          Banking environment (ONIKS / internal vLLM)
        </label>
        <div class="muted">Bu mod model adını ONIKS yapar ve API key kullanımını kapatır. Aşağıdaki alana bankanın tam OpenAI-compatible <code>/v1/chat/completions</code> URL'sini yapıştırabilirsin.</div>
        <div class="formGrid">
          <label class="wide">
            Qwen Endpoint
            <input id="qwenEndpoint" type="text" placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1">
          </label>
          <label>
            Model
            <input id="qwenModel" type="text" placeholder="Qwen/Qwen3.6-27B">
          </label>
          <label>
            Temperature
            <input id="qwenTemperature" type="number" min="0" max="2" step="0.1">
          </label>
          <label>
            Semantik Max Token
            <input id="qwenMaxTokens" type="number" min="256" step="256">
          </label>
          <label>
            Semantik Timeout
            <input id="qwenTimeoutSeconds" type="number" min="5" step="5">
          </label>
        <label>
          İstekler arası bekleme (saniye; 0 kapatır)
          <input id="qwenInterRequestDelaySeconds" type="number" min="0" max="300" step="1">
        </label>
        <div class="muted wide"><strong>Qwen3.6 sampling</strong><br>Evidence/reduce çağrıları non-thinking; synthesis ve gerçek gap repair çağrıları precise-coding thinking profiliyle otomatik gönderilir.</div>
        <div class="muted wide"><strong>Qwen-only context ve aşama limitleri</strong><br>Yarım Qwen3.6-27B profili context 131072 ve çıktı tavanları 16384 kullanır. Bunlar model kapasitesinin yarısıdır; endpoint deployment'ının gerçek <code>max_model_len</code> değeri daha düşükse context mutlaka o değere indirilmelidir. Bu alanlar Copilot'u etkilemez.</div>
          <label>
            Toplam context window (token)
            <input id="qwenContextWindowTokens" type="number" min="8192" step="1024">
          </label>
          <label>
            Tam doküman üretim üst sınırı (token)
            <input id="qwenGenerationMaxTokens" type="number" min="256" step="256">
          </label>
          <label>
            Sayfa analysis çıktı bütçesi (token)
            <input id="qwenAnalysisMaxOutputTokens" type="number" min="256" max="65536" step="256">
          </label>
          <label>
            Sayfa reduce çıktı bütçesi (token)
            <input id="qwenReduceMaxOutputTokens" type="number" min="256" max="65536" step="256">
          </label>
          <label class="wide">
            Sayfa synthesis çıktı bütçesi (token)
            <input id="qwenSynthesisMaxOutputTokens" type="number" min="256" max="65536" step="256">
          </label>
          <label class="checkLabel wide">
            <input id="qwenUseApiKey" type="checkbox">
            API Key kullan
          </label>
          <label class="wide">
            API Key
            <input id="qwenApiKey" type="password" placeholder="Boş bırakılırsa mevcut gizli değer korunur">
          </label>
          <label class="checkLabel wide">
            <input id="semanticCacheEnabled" type="checkbox">
            Semantik cache aktif
          </label>
          <label>
            Run başına maksimum öğe
            <input id="semanticMaxFilesPerRun" type="number" min="1" step="1">
          </label>
          <label>
            Dosya başına maksimum karakter
            <input id="semanticMaxCharactersPerFile" type="number" min="1000" step="1000">
          </label>
        </div>
        <div class="muted">Bağlantı testi, bu formdaki ayarlarla Qwen'e gerçek ve kısa bir OpenAI-compatible istek gönderir; sonucu başarı veya hata olarak gösterir.</div>
        <div class="muted" id="qwenTestResult" role="status" aria-live="polite">Henüz bağlantı testi çalıştırılmadı.</div>
      </div>
      <div class="modalFooter">
        <button class="secondary" id="testQwenButton" type="button">Qwen Bağlantısını Test Et</button>
        <button id="saveQwenButton" type="button">Qwen Ayarlarını Kaydet</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const repoUrl = document.getElementById("repoUrl");
    const branch = document.getElementById("branch");
    const analyzeButton = document.getElementById("analyzeButton");
    const selectWorkspaceButton = document.getElementById("selectWorkspaceButton");
    const workspaceFolder = document.getElementById("workspaceFolder");
    const status = document.getElementById("status");
    const defaultBranch = document.getElementById("defaultBranch");
    const aiProviderSelect = document.getElementById("aiProviderSelect");
    const copilotQwenSemanticPrepassEnabled = document.getElementById("copilotQwenSemanticPrepassEnabled");
    const qwenModal = document.getElementById("qwenModal");
    const openQwenSettingsButton = document.getElementById("openQwenSettingsButton");
    const closeQwenSettingsButton = document.getElementById("closeQwenSettingsButton");
    const quickTestQwenButton = document.getElementById("quickTestQwenButton");
    const qwenEnabled = document.getElementById("qwenEnabled");
    const qwenBankingEnvironment = document.getElementById("qwenBankingEnvironment");
    const qwenEndpoint = document.getElementById("qwenEndpoint");
    const qwenModel = document.getElementById("qwenModel");
    const qwenTemperature = document.getElementById("qwenTemperature");
    const qwenMaxTokens = document.getElementById("qwenMaxTokens");
    const qwenTimeoutSeconds = document.getElementById("qwenTimeoutSeconds");
    const qwenInterRequestDelaySeconds = document.getElementById("qwenInterRequestDelaySeconds");
    const qwenContextWindowTokens = document.getElementById("qwenContextWindowTokens");
    const qwenGenerationMaxTokens = document.getElementById("qwenGenerationMaxTokens");
    const qwenAnalysisMaxOutputTokens = document.getElementById("qwenAnalysisMaxOutputTokens");
    const qwenReduceMaxOutputTokens = document.getElementById("qwenReduceMaxOutputTokens");
    const qwenSynthesisMaxOutputTokens = document.getElementById("qwenSynthesisMaxOutputTokens");
    const qwenUseApiKey = document.getElementById("qwenUseApiKey");
    const qwenApiKey = document.getElementById("qwenApiKey");
    const semanticCacheEnabled = document.getElementById("semanticCacheEnabled");
    const semanticMaxFilesPerRun = document.getElementById("semanticMaxFilesPerRun");
    const semanticMaxCharactersPerFile = document.getElementById("semanticMaxCharactersPerFile");
    const qwenTestResult = document.getElementById("qwenTestResult");
    const testQwenButton = document.getElementById("testQwenButton");
    const saveQwenButton = document.getElementById("saveQwenButton");

    function setStatus(title, message) {
      status.innerHTML = "<strong>" + title + "</strong>" + message;
    }

    function setModalOpen(open) {
      qwenModal.classList.toggle("open", open);
    }

    function applyBankingEnvironmentState(enabled, applyDefaults = false) {
      if (enabled) {
        qwenEnabled.checked = true;
        qwenModel.value = "ONIKS";
        qwenUseApiKey.checked = false;
        qwenApiKey.value = "";
        if (applyDefaults) {
          qwenTemperature.value = "0.6";
          qwenMaxTokens.value = "16384";
          qwenContextWindowTokens.value = "131072";
          qwenGenerationMaxTokens.value = "16384";
          qwenAnalysisMaxOutputTokens.value = "16384";
          qwenReduceMaxOutputTokens.value = "16384";
          qwenSynthesisMaxOutputTokens.value = "16384";
        }
      }
      qwenModel.disabled = enabled;
      qwenUseApiKey.disabled = enabled;
      qwenApiKey.disabled = enabled;
    }

    function renderQwenTestResult(testing, ok, message, model, endpoint) {
      testQwenButton.disabled = Boolean(testing);
      quickTestQwenButton.disabled = Boolean(testing);
      const prefix = testing ? "Test ediliyor: " : ok ? "Başarılı: " : "Başarısız: ";
      const details = [model, endpoint].filter(Boolean).join(" · ");
      qwenTestResult.textContent = prefix + message + (details ? " (" + details + ")" : "");
    }

    function readQwenSettings() {
      return {
        enabled: qwenEnabled.checked,
        bankingEnvironment: qwenBankingEnvironment.checked,
        endpoint: qwenEndpoint.value,
        model: qwenModel.value,
        temperature: Number(qwenTemperature.value || "0.6"),
        maxTokens: Number(qwenMaxTokens.value || "16384"),
        timeoutSeconds: Number(qwenTimeoutSeconds.value || "120"),
        interRequestDelaySeconds: Number(qwenInterRequestDelaySeconds.value || "15"),
        qwenContextWindowTokens: Number(qwenContextWindowTokens.value || "131072"),
        qwenGenerationMaxTokens: Number(qwenGenerationMaxTokens.value || "16384"),
        qwenAnalysisMaxOutputTokens: Number(qwenAnalysisMaxOutputTokens.value || "16384"),
        qwenReduceMaxOutputTokens: Number(qwenReduceMaxOutputTokens.value || "16384"),
        qwenSynthesisMaxOutputTokens: Number(qwenSynthesisMaxOutputTokens.value || "16384"),
        useApiKey: qwenUseApiKey.checked,
        semanticCacheEnabled: semanticCacheEnabled.checked,
        semanticMaxFilesPerRun: Number(semanticMaxFilesPerRun.value || "50"),
        semanticMaxCharactersPerFile: Number(semanticMaxCharactersPerFile.value || "20000"),
        apiKey: qwenApiKey.value || undefined
      };
    }

    analyzeButton.addEventListener("click", () => {
      analyzeButton.disabled = true;
      setStatus("Analiz başlatıldı", "Git clone/fetch ve Spring indeksleme işlemleri çalışıyor...");
      vscode.postMessage({ type: "analyze", repoUrl: repoUrl.value, branch: branch.value });
    });

    aiProviderSelect.addEventListener("change", () => {
      vscode.postMessage({ type: "saveAiProvider", provider: aiProviderSelect.value });
    });

    copilotQwenSemanticPrepassEnabled.addEventListener("change", () => {
      vscode.postMessage({
        type: "saveCopilotQwenSemanticPrepass",
        enabled: copilotQwenSemanticPrepassEnabled.checked
      });
    });

    selectWorkspaceButton.addEventListener("click", () => {
      vscode.postMessage({ type: "selectWorkspace" });
    });

    openQwenSettingsButton.addEventListener("click", () => setModalOpen(true));
    closeQwenSettingsButton.addEventListener("click", () => setModalOpen(false));
    qwenModal.addEventListener("click", (event) => {
      if (event.target === qwenModal) {
        setModalOpen(false);
      }
    });

    qwenBankingEnvironment.addEventListener("change", () => {
      applyBankingEnvironmentState(qwenBankingEnvironment.checked, true);
    });

    testQwenButton.addEventListener("click", () => {
      renderQwenTestResult(true, false, "Qwen endpoint'ine kısa istek gönderiliyor.");
      vscode.postMessage({ type: "testQwenConnection", settings: readQwenSettings() });
    });

    quickTestQwenButton.addEventListener("click", () => {
      setModalOpen(true);
      renderQwenTestResult(true, false, "Qwen endpoint'ine kısa istek gönderiliyor.");
      vscode.postMessage({ type: "testQwenConnection", settings: readQwenSettings() });
    });

    saveQwenButton.addEventListener("click", () => {
      vscode.postMessage({ type: "saveQwenSettings", settings: readQwenSettings() });
      qwenApiKey.value = "";
      setModalOpen(false);
    });

    document.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "command", command: button.dataset.command });
      });
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "settings") {
        defaultBranch.textContent = message.defaultBranch;
        workspaceFolder.value = message.workspaceFolder || "";
        branch.placeholder = "Boş bırakılırsa " + message.defaultBranch + " kullanılır";
        aiProviderSelect.value = message.ai?.provider === "qwen"
          ? "qwen"
          : message.ai?.provider === "copilot" ? "copilot" : "invalid";
        if (aiProviderSelect.value === "invalid") {
          setStatus("Ayar Hatası", "bankSpringDocs.ai.provider değeri copilot veya qwen olmalıdır.");
        }
        if (message.qwen) {
          qwenEnabled.checked = Boolean(message.qwen.enabled);
          qwenBankingEnvironment.checked = Boolean(message.qwen.bankingEnvironment);
          qwenEndpoint.value = message.qwen.endpoint || "";
          qwenModel.value = message.qwen.model || "";
          qwenTemperature.value = String(message.qwen.temperature ?? 0.6);
          qwenMaxTokens.value = String(message.qwen.maxTokens ?? 16384);
          qwenTimeoutSeconds.value = String(message.qwen.timeoutSeconds ?? 120);
          qwenInterRequestDelaySeconds.value = String(message.qwen.interRequestDelaySeconds ?? 15);
          qwenContextWindowTokens.value = String(message.qwen.qwenContextWindowTokens ?? 131072);
          qwenGenerationMaxTokens.value = String(message.qwen.qwenGenerationMaxTokens ?? 16384);
          qwenAnalysisMaxOutputTokens.value = String(message.qwen.qwenAnalysisMaxOutputTokens ?? 16384);
          qwenReduceMaxOutputTokens.value = String(message.qwen.qwenReduceMaxOutputTokens ?? 16384);
          qwenSynthesisMaxOutputTokens.value = String(message.qwen.qwenSynthesisMaxOutputTokens ?? 16384);
          qwenUseApiKey.checked = Boolean(message.qwen.useApiKey);
          applyBankingEnvironmentState(qwenBankingEnvironment.checked);
        }
        if (message.semantic) {
          semanticCacheEnabled.checked = Boolean(message.semantic.cacheEnabled);
          semanticMaxFilesPerRun.value = String(message.semantic.maxFilesPerRun ?? 50);
          semanticMaxCharactersPerFile.value = String(message.semantic.maxCharactersPerFile ?? 20000);
        }
        if (message.pageAnalysis) {
          copilotQwenSemanticPrepassEnabled.checked = Boolean(message.pageAnalysis.copilotQwenSemanticPrepassEnabled);
        }
      }
      if (message.type === "busy") {
        analyzeButton.disabled = true;
        setStatus("Çalışıyor", message.message);
      }
      if (message.type === "aiProviderSaved") {
        setStatus("AI Sağlayıcısı", message.message);
      }
      if (message.type === "qwenTestResult") {
        renderQwenTestResult(message.testing, message.ok, message.message, message.model, message.endpoint);
      }
      if (message.type === "done") {
        analyzeButton.disabled = false;
        setStatus("Tamamlandı", message.message + "<br><br><span class='muted'>" + message.aiDocsPath + "</span>");
      }
      if (message.type === "error") {
        analyzeButton.disabled = false;
        setStatus("Hata", message.message);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function normalizeAiProvider(value: unknown): AiProviderUiValue {
  return value === "copilot" || value === "qwen" ? value : "invalid";
}

async function saveQwenLimitSettings(settings: QwenUiSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration("bankSpringDocs");
  qwenLimitValue(settings.interRequestDelaySeconds, "Qwen istekler arası bekleme", 0, 300);
  const contextWindow = qwenLimitValue(settings.qwenContextWindowTokens, "Qwen context window", 8192);
  const generationCap = qwenLimitValue(settings.qwenGenerationMaxTokens, "Qwen generation cap", 256);
  const analysisOutput = qwenLimitValue(settings.qwenAnalysisMaxOutputTokens, "Qwen analysis output", 256, 65536);
  const reduceOutput = qwenLimitValue(settings.qwenReduceMaxOutputTokens, "Qwen reduce output", 256, 65536);
  const synthesisOutput = qwenLimitValue(settings.qwenSynthesisMaxOutputTokens, "Qwen synthesis output", 256, 65536);
  validateQwenPageBudgets(contextWindow, generationCap, [analysisOutput, reduceOutput, synthesisOutput]);
  const updates: Array<[string, number]> = [
    ["qwen.contextWindowTokens", contextWindow],
    ["qwen.generationMaxTokens", generationCap],
    ["pageAnalysis.qwenAnalysisMaxOutputTokens", analysisOutput],
    ["pageAnalysis.qwenReduceMaxOutputTokens", reduceOutput],
    ["pageAnalysis.qwenSynthesisMaxOutputTokens", synthesisOutput]
  ];
  for (const [key, value] of updates) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

function validateQwenPageBudgets(contextWindow: number, generationCap: number, phaseOutputs: number[]): void {
  const largestPhaseOutput = Math.max(...phaseOutputs);
  if (largestPhaseOutput > generationCap) {
    throw new Error("Qwen sayfa aşaması çıktı bütçeleri tam doküman üretim üst sınırını aşamaz.");
  }
  const safeInputCharacters = Math.min(60000, Math.floor(contextWindow - largestPhaseOutput - 2048) * 3);
  if (safeInputCharacters < 8001) {
    throw new Error("Qwen context window, çıktı bütçeleri ve 2048 token güvenlik rezervi için yetersiz.");
  }
}

function qwenLimitValue(value: number, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} değeri ${minimum}-${maximum} aralığında olmalıdır.`);
  }
  return Math.floor(value);
}
