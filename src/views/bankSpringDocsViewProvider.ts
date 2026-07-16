import * as vscode from "vscode";
import type { QwenConnectionResult } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { AnalyzeRepositoryUrlCommand } from "../commands/analyzeRepositoryUrlCommand";
import { getDefaultBranch } from "../git/branchResolver";
import { MultiRepoInput, MultiRepoManifest, MultiRepoManifestService } from "../multirepo/multiRepoManifestService";
import { SelectedPageStateService } from "../pageanalysis/selectedPageStateService";

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
  useApiKey: boolean;
  semanticCacheEnabled?: boolean;
  semanticMaxFilesPerRun?: number;
  semanticMaxCharactersPerFile?: number;
  apiKey?: string;
};

type WebviewMessage =
  | { type: "ready" }
  | { type: "analyze"; repoUrl: string; branch: string }
  | { type: "command"; command: string }
  | { type: "saveAiProvider"; provider: AiProvider }
  | { type: "saveCopilotModel"; modelId: string }
  | { type: "saveMultiRepoAgenticQwenFlag"; enabled: boolean }
  | { type: "savePageAnalysisQwenOnly"; enabled: boolean }
  | { type: "runFullSelectedPageAnalysis"; qwenOnly: boolean }
  | { type: "saveMultiRepoManifest"; input: MultiRepoInput }
  | { type: "cloneOrUpdateMultiRepos"; input: MultiRepoInput }
  | { type: "analyzeMultiReposLocally" }
  | { type: "generateReactUiAnalysis" }
  | { type: "generateEndToEndFlowMap" }
  | { type: "generateQwenPageSemantics" }
  | { type: "generateLocalKnowledgeGraph" }
  | { type: "saveQwenSettings"; settings: QwenUiSettings }
  | { type: "testQwenConnection"; settings: QwenUiSettings };

export class BankSpringDocsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "bankSpringDocs.dashboard";
  private webviewView: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly analyzeCommand: AnalyzeRepositoryUrlCommand
  ) {
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if ((
        event.affectsConfiguration("bankSpringDocs.ai.provider")
        || event.affectsConfiguration("bankSpringDocs.pageAnalysis.qwenOnly")
      ) && this.webviewView) {
        this.postSettings(this.webviewView);
      }
    }));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(webviewView, message));
    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = undefined;
      }
    });
  }

  private async handleMessage(webviewView: vscode.WebviewView, message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      this.postSettings(webviewView);
      await this.postMultiRepoManifest(webviewView);
      this.postSelectedPage(webviewView);
      return;
    }

    if (message.type === "saveMultiRepoManifest") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "Manifest kaydediliyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.saveMultiRepoManifest", message.input);
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "Manifest kaydedildi." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "cloneOrUpdateMultiRepos") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "UI, BFF ve BE repoları klonlanıyor veya güncelleniyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.cloneOrUpdateMultiRepos", message.input);
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "Çoklu repo hazırlama işlemi tamamlandı." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "analyzeMultiReposLocally") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "BFF ve BE repoları yerel olarak analiz ediliyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.analyzeMultiReposLocally");
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "Yerel analiz tamamlandı." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "generateReactUiAnalysis") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "React UI repo yerel olarak analiz ediliyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.generateReactUiAnalysis");
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "React UI analizi tamamlandı." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "generateEndToEndFlowMap") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "Uçtan uca akış eşleşmeleri oluşturuluyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.generateEndToEndFlowMap");
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "Uçtan uca akış haritası oluşturuldu." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "generateQwenPageSemantics") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "Qwen ile sayfa semantiği oluşturuluyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.generateQwenPageSemantics");
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "Qwen sayfa semantiği oluşturuldu." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "generateLocalKnowledgeGraph") {
      try {
        webviewView.webview.postMessage({ type: "multiRepoBusy", message: "Lokal bilgi grafiği oluşturuluyor..." });
        const manifest = await vscode.commands.executeCommand<MultiRepoManifest | undefined>("bankSpringDocs.generateLocalKnowledgeGraph");
        await this.postMultiRepoManifest(webviewView, manifest);
        webviewView.webview.postMessage({ type: "multiRepoDone", message: "Lokal bilgi grafiği oluşturuldu." });
      } catch (error) {
        webviewView.webview.postMessage({ type: "multiRepoError", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "command") {
      try {
        await vscode.commands.executeCommand(message.command);
        if (message.command === "bankSpringDocs.buildPageList") {
          this.postSelectedPage(webviewView);
        }
      } catch (error) {
        webviewView.webview.postMessage({
          type: "error",
          message: `Komut tamamlanamadı: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "runFullSelectedPageAnalysis") {
      webviewView.webview.postMessage({ type: "pageAnalysisRunState", running: true });
      try {
        await vscode.commands.executeCommand("bankSpringDocs.runFullSelectedPageAnalysis", {
          qwenOnly: Boolean(message.qwenOnly)
        });
      } catch (error) {
        webviewView.webview.postMessage({
          type: "error",
          message: `Komut tamamlanamadı: ${error instanceof Error ? error.message : String(error)}`
        });
      } finally {
        webviewView.webview.postMessage({ type: "pageAnalysisRunState", running: false });
      }
      return;
    }

    if (message.type === "saveAiProvider") {
      if (message.provider !== "copilot" && message.provider !== "qwen") {
        webviewView.webview.postMessage({ type: "error", message: "Geçersiz AI doküman sağlayıcısı seçildi." });
        return;
      }
      try {
        await vscode.workspace.getConfiguration("bankSpringDocs").update("ai.provider", message.provider, vscode.ConfigurationTarget.Global);
        this.postSettings(webviewView);
        webviewView.webview.postMessage({
          type: "aiProviderSaved",
          message: `AI doküman sağlayıcısı ${message.provider === "qwen" ? "Qwen" : "GitHub Copilot"} olarak kaydedildi.`
        });
      } catch (error) {
        webviewView.webview.postMessage({
          type: "error",
          message: `AI doküman sağlayıcısı kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "saveCopilotModel") {
      await vscode.workspace.getConfiguration("bankSpringDocs").update("copilot.modelId", message.modelId, vscode.ConfigurationTarget.Global);
      this.postSettings(webviewView);
      webviewView.webview.postMessage({ type: "copilotModelSaved", message: "Copilot modeli kaydedildi." });
      return;
    }

    if (message.type === "saveMultiRepoAgenticQwenFlag") {
      await vscode.workspace.getConfiguration("bankSpringDocs").update("multiRepo.agenticRunQwenSemantics", message.enabled, vscode.ConfigurationTarget.Global);
      this.postSettings(webviewView);
      return;
    }

    if (message.type === "savePageAnalysisQwenOnly") {
      try {
        await vscode.workspace.getConfiguration("bankSpringDocs").update("pageAnalysis.qwenOnly", Boolean(message.enabled), vscode.ConfigurationTarget.Global);
        this.postSettings(webviewView);
      } catch (error) {
        webviewView.webview.postMessage({
          type: "error",
          message: `Qwen3-only sayfa ayari kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "saveQwenSettings") {
      try {
        await saveQwenLimitSettings(message.settings);
        await vscode.commands.executeCommand("bankSpringDocs.saveQwenSettings", message.settings);
        this.postSettings(webviewView);
      } catch (error) {
        webviewView.webview.postMessage({
          type: "error",
          message: `Qwen ayarları kaydedilemedi: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return;
    }

    if (message.type === "testQwenConnection") {
      webviewView.webview.postMessage({
        type: "qwenTestResult",
        testing: true,
        message: "Qwen endpoint'ine kısa test isteği gönderiliyor..."
      });
      try {
        await saveQwenLimitSettings(message.settings);
        const result = await vscode.commands.executeCommand<QwenConnectionResult>("bankSpringDocs.testQwenConnection", message.settings);
        webviewView.webview.postMessage({
          type: "qwenTestResult",
          testing: false,
          ok: result?.ok ?? false,
          message: result?.message ?? "Qwen bağlantı testi sonuç döndürmedi.",
          model: result?.model,
          endpoint: result?.endpoint
        });
      } catch (error) {
        webviewView.webview.postMessage({
          type: "qwenTestResult",
          testing: false,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      this.postSettings(webviewView);
      return;
    }

    const repoUrl = message.repoUrl.trim();
    const branch = message.branch.trim() || getDefaultBranch();
    if (!repoUrl) {
      webviewView.webview.postMessage({ type: "error", message: "Bitbucket repository URL alanı zorunludur." });
      return;
    }

    try {
      webviewView.webview.postMessage({ type: "busy", message: "Repository hazırlanıyor ve yerel analiz başlatılıyor..." });
      const result = await this.analyzeCommand.analyzeRepository(repoUrl, branch);
      webviewView.webview.postMessage({
        type: "done",
        message: `Analiz tamamlandı. ${result.indexedFiles} dosya indekslendi.`,
        aiDocsPath: result.aiDocsPath
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      webviewView.webview.postMessage({ type: "error", message: messageText });
    }
  }

  private postSettings(webviewView: vscode.WebviewView): void {
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    const provider = normalizeAiProvider(config.get<string>("ai.provider", "copilot"));
    const modelsPromise = provider === "copilot" ? this.getCopilotModels() : Promise.resolve([]);
    modelsPromise.then((models) => {
      webviewView.webview.postMessage({
        type: "copilotModels",
        selectedModelId: config.get<string>("copilot.modelId", ""),
        models
      });
    });
    webviewView.webview.postMessage({
      type: "settings",
      defaultBranch: getDefaultBranch(),
      ai: {
        provider
      },
      qwen: {
        ...new QwenSettingsService(this.context).getSettings(),
        qwenContextWindowTokens: config.get<number>("qwen.contextWindowTokens", 131072),
        qwenGenerationMaxTokens: config.get<number>("qwen.generationMaxTokens", 16384),
        qwenAnalysisMaxOutputTokens: config.get<number>("pageAnalysis.qwenAnalysisMaxOutputTokens", 2048),
        qwenReduceMaxOutputTokens: config.get<number>("pageAnalysis.qwenReduceMaxOutputTokens", 3072),
        qwenSynthesisMaxOutputTokens: config.get<number>("pageAnalysis.qwenSynthesisMaxOutputTokens", 4096)
      },
      semantic: {
        cacheEnabled: config.get<boolean>("semantic.cacheEnabled", true),
        maxFilesPerRun: config.get<number>("semantic.maxFilesPerRun", 50),
        maxCharactersPerFile: config.get<number>("semantic.maxCharactersPerFile", 20000)
      },
      multiRepo: {
        agenticRunQwenSemantics: config.get<boolean>("multiRepo.agenticRunQwenSemantics", true)
      },
      pageAnalysis: {
        qwenOnly: config.get<boolean>("pageAnalysis.qwenOnly", false)
      }
    });
  }

  private async getCopilotModels(): Promise<Array<{ id: string; name: string; vendor: string; family: string; maxInputTokens: number }>> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      return models.map((model) => ({
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        maxInputTokens: model.maxInputTokens
      }));
    } catch {
      return [];
    }
  }

  private async postMultiRepoManifest(webviewView: vscode.WebviewView, manifest?: MultiRepoManifest): Promise<void> {
    const currentManifest = manifest ?? await new MultiRepoManifestService(this.context).readManifest();
    webviewView.webview.postMessage({
      type: "multiRepoManifest",
      manifest: currentManifest
    });
  }

  private postSelectedPage(webviewView: vscode.WebviewView): void {
    webviewView.webview.postMessage({
      type: "selectedPage",
      page: new SelectedPageStateService(this.context).getSelectedPage()
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
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .shell {
      display: grid;
      gap: 12px;
      padding: 12px;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .title {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    h1, h2, h3 {
      margin: 0;
    }

    h1 {
      font-size: 16px;
      font-weight: 750;
    }

    h2 {
      font-size: 13px;
      font-weight: 700;
    }

    .muted {
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .iconActions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }

    .iconButton {
      width: 30px;
      min-height: 30px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      font-size: 15px;
    }

    .section, .scenario {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
    }

    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .tabButton {
      min-height: 34px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-color: var(--vscode-panel-border);
    }

    .tabButton.active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .tabPanel {
      display: none;
      gap: 12px;
    }

    .tabPanel.open {
      display: grid;
    }

    .section {
      padding: 12px;
      display: grid;
      gap: 10px;
    }

    .scenario {
      padding: 10px;
      display: grid;
      gap: 8px;
    }

    .scenarioHeader {
      display: grid;
      gap: 3px;
    }

    .scenarioList {
      display: grid;
      gap: 8px;
    }

    label {
      display: grid;
      gap: 5px;
      font-weight: 650;
    }

    .checkLabel {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }

    input {
      box-sizing: border-box;
      width: 100%;
      min-height: 32px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-font-family);
    }

    select {
      box-sizing: border-box;
      width: 100%;
      min-height: 32px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 7px 8px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      font-family: var(--vscode-font-family);
    }

    input[type="checkbox"] {
      width: auto;
      min-height: auto;
    }

    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    button {
      min-height: 32px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 7px 9px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-family: var(--vscode-font-family);
      font-weight: 650;
      cursor: pointer;
    }

    button.secondary, button.ghost {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.ghost {
      border-color: var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
    }

    .buttonGrid {
      display: grid;
      gap: 7px;
    }

    .status {
      min-height: 46px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 9px;
      background: var(--vscode-sideBar-background);
      line-height: 1.4;
      word-break: break-word;
    }

    .status strong {
      display: block;
      margin-bottom: 3px;
    }

    .statusGrid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 7px;
    }

    .statusPill {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      background: var(--vscode-sideBar-background);
    }

    .statusPill span {
      display: block;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .modalBackdrop {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 20;
      background: rgba(0, 0, 0, 0.45);
      align-items: stretch;
      justify-content: center;
      padding: 10px;
    }

    .modalBackdrop.open {
      display: flex;
    }

    .modal {
      width: 100%;
      max-height: 96vh;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      align-self: center;
    }

    .modalHeader, .modalFooter {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .modalFooter {
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 0;
      display: grid;
    }

    .modalBody {
      padding: 12px;
      display: grid;
      gap: 10px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div class="title">
        <h1>Bank Spring Docs AI</h1>
        <div class="muted">Branch: <strong id="defaultBranch">release/liv</strong></div>
      </div>
      <div class="iconActions">
        <button class="iconButton ghost" data-command="bankSpringDocs.openDashboard" title="Büyük paneli aç" type="button">↗</button>
        <button class="iconButton ghost" id="openQwenSettingsButton" title="Qwen ayarları" type="button">⚙</button>
      </div>
    </section>

    <section class="section">
      <label>
        AI Doküman Sağlayıcısı
        <select id="aiProviderSelect">
          <option value="invalid" disabled>Geçersiz sağlayıcı ayarı</option>
          <option value="copilot">GitHub Copilot</option>
          <option value="qwen">Qwen (Yapılandırılmış Endpoint)</option>
        </select>
      </label>
      <div class="muted">Seçim, tüm AI destekli doküman üretim adımlarında kullanılır. Yerel analiz adımları değişmez.</div>
    </section>

    <nav class="tabs" aria-label="Analiz sekmeleri">
      <button class="tabButton active" data-tab="springTab" type="button">Spring Repo</button>
      <button class="tabButton" data-tab="multiRepoTab" type="button">UI - BFF - BE</button>
    </nav>

    <section class="tabPanel open" id="springTab">
    <section class="section">
      <h2>Repository Analizi</h2>
      <label>
        Bitbucket URL
        <input id="repoUrl" type="text" placeholder="git@bitbucket.org:project/repo.git">
      </label>
      <label>
        Branch
        <input id="branch" type="text" placeholder="Boş bırakılırsa release/liv">
      </label>
      <button id="analyzeButton">Repository Analiz Et</button>
      <div class="status" id="status">
        <strong>Hazır</strong>
        Repository URL girip analizi başlatabilirsin.
      </div>
    </section>

    <section class="scenarioList">
      <div class="scenario">
        <div class="scenarioHeader">
          <h2>Yerel Dokümantasyon</h2>
          <div class="muted">İndekslerden hızlı Markdown üretir.</div>
        </div>
        <div class="buttonGrid">
          <button data-command="bankSpringDocs.generateAllLocalDocs">Tüm Yerel Dokümanlar</button>
          <button class="secondary" data-command="bankSpringDocs.generateAnalysisQualityReport">Analiz Kalite Raporu</button>
        </div>
      </div>

      <div class="scenario">
        <div class="scenarioHeader">
          <h2>Qwen Semantik</h2>
          <div class="muted">Sınıf, endpoint ve dependency açıklamaları.</div>
        </div>
        <div class="buttonGrid">
          <button data-command="bankSpringDocs.generateQwenSemanticAnalysis">Semantik Analiz Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.generateEnrichedRepoMap">Zengin Repo Haritası</button>
          <button class="secondary" id="quickTestQwenButton" type="button">Bağlantıyı Test Et</button>
        </div>
      </div>

      <div class="scenario">
        <div class="scenarioHeader">
          <h2>AI Dokümantasyon</h2>
          <div class="muted">Kompakt context ile seçili sağlayıcı üzerinden AI dokümanı üretir.</div>
        </div>
        <label>
          Copilot Modeli (yalnızca Copilot seçiliyken)
          <select id="copilotModelSelect">
            <option value="">Varsayılan kullanılacak</option>
          </select>
        </label>
        <div class="buttonGrid">
          <button data-command="bankSpringDocs.generateAgenticCopilotBackendDocs">Agentic Backend Analizi Başlat</button>
          <button data-command="bankSpringDocs.generateAllCopilotDocs">Tüm AI Dokümanları</button>
          <button class="secondary" data-command="bankSpringDocs.runCopilotDiagnostics">Copilot Tanılama Testi</button>
          <button class="secondary" data-command="bankSpringDocs.openLastCopilotContext">Son Context'i Aç</button>
          <button class="secondary" data-command="bankSpringDocs.openLastCopilotPrompt">Son Prompt'u Aç</button>
        </div>
      </div>

      <div class="scenario">
        <div class="scenarioHeader">
          <h2>İnceleme</h2>
          <div class="muted">Çıktılar ve bakım araçları.</div>
        </div>
        <div class="buttonGrid">
          <button data-command="bankSpringDocs.openRepoMap">Repo Haritası</button>
          <button class="secondary" data-command="bankSpringDocs.openGeneratedDocs">Çıktı Klasörü</button>
          <button class="secondary" data-command="bankSpringDocs.openCopilotAuditLog">Audit Log</button>
        </div>
      </div>
    </section>
    </section>

    <section class="tabPanel" id="multiRepoTab">
      <section class="section">
        <h2>UI - BFF - BE Analizi</h2>
        <label>
          Proje Adı
          <input id="multiProjectName" type="text" placeholder="Customer Management">
        </label>
        <label>
          Ortak Branch
          <input id="multiBranch" type="text" value="release/liv">
        </label>
        <label>
          UI Repo URL
          <input id="multiUiRepoUrl" type="text" placeholder="git@bitbucket.org:project/customer-ui.git">
        </label>
        <label>
          BFF Repo URL
          <input id="multiBffRepoUrl" type="text" placeholder="git@bitbucket.org:project/customer-bff.git">
        </label>
        <label>
          BE Repo URL
          <input id="multiBeRepoUrl" type="text" placeholder="git@bitbucket.org:project/customer-service.git">
        </label>
        <div class="buttonGrid">
          <button id="saveMultiManifestButton" type="button">Manifesti Kaydet</button>
          <button id="cloneMultiReposButton" type="button">Repoları Klonla / Güncelle</button>
          <button class="secondary" id="analyzeMultiReposButton" type="button">Tüm Repoları Yerel Analiz Et</button>
          <button class="secondary" id="generateReactUiAnalysisButton" type="button">React UI Analizi Oluştur</button>
          <button class="secondary" id="generateEndToEndFlowMapButton" type="button">Uçtan Uca Akış Haritası Oluştur</button>
          <button class="secondary" id="generateLocalKnowledgeGraphButton" type="button">Lokal Bilgi Grafiği Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.generateMultiRepoQualityReport">Coklu Repo Kalite Raporu</button>
          <button class="secondary" data-command="bankSpringDocs.generateMultiRepoAgenticCopilotDocs">Agentic UI-BFF-BE Dokümantasyon</button>
          <button class="secondary" id="generateQwenPageSemanticsButton" type="button">Qwen ile Sayfa Semantiği Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.generatePageTechnicalAnalysis">Sayfa Bazlı Teknik Analiz Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.openUnresolvedMultiRepoMatches">Eşleşmeyen Akışları Aç</button>
          <button class="secondary" data-command="bankSpringDocs.openMultiRepoOutputFolder">Çıktı Klasörünü Aç</button>
          <label class="checkLabel">
            <input id="agenticRunQwenSemantics" type="checkbox">
            Agentic pipeline Qwen semantiÄŸini kullansÄ±n
          </label>
        </div>
        <div class="status" id="multiRepoStatus">
          <strong>Hazır</strong>
          Proje ve repository URL bilgilerini girip manifesti kaydedebilirsin.
        </div>
      </section>

      <section class="section">
        <h2>Sayfa Bazlı Analiz</h2>
        <div class="statusGrid">
          <div class="statusPill">
            <strong>Seçili Sayfa</strong>
            <span id="selectedPageStatus">Henüz sayfa seçilmedi</span>
          </div>
        </div>
        <label class="checkLabel">
          <input id="pageAnalysisQwenOnly" type="checkbox">
          Bu sayfanın tüm AI adımlarını yalnızca Qwen3 ile çalıştır
        </label>
        <div class="muted">Yalnızca tam sayfa analizi için geçerlidir; global AI sağlayıcısı ve Copilot akışı değişmez.</div>
        <div class="buttonGrid">
          <button class="secondary" data-command="bankSpringDocs.buildPageList">Sayfa Listesini Yenile</button>
          <button class="secondary" data-command="bankSpringDocs.analyzeSelectedPage">Seçili Sayfayı Analiz Et</button>
          <button class="secondary" data-command="bankSpringDocs.openSelectedPageContextPack">Context Paketini Aç</button>
          <button class="secondary" data-command="bankSpringDocs.openSelectedPageEvidencePack">Evidence Paketini Aç</button>
          <button class="secondary" data-command="bankSpringDocs.generateSelectedPageQwenSemantics">Qwen Semantiği Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.generateSelectedPageCopilotDraft">AI Taslak Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.detectSelectedPageDocumentGaps">Gap Analizi Yap</button>
          <button class="secondary" data-command="bankSpringDocs.repairSelectedPageDocumentGaps">Gap Repair Çalıştır</button>
          <button class="secondary" data-command="bankSpringDocs.buildFinalSelectedPageDocument">Final Dokümanı Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.scoreSelectedPageDocument">Kalite Skoru Oluştur</button>
          <button class="secondary" data-command="bankSpringDocs.openFinalSelectedPageDocument">Final Dokümanı Aç</button>
          <button id="runFullSelectedPageAnalysisButton" type="button">Tüm Sayfa Analizini Çalıştır</button>
        </div>
      </section>

      <section class="section">
        <h2>Durum</h2>
        <div class="statusGrid">
          <div class="statusPill"><strong>UI Repo</strong><span id="multiUiStatus">Hazır değil</span></div>
          <div class="statusPill"><strong>BFF Repo</strong><span id="multiBffStatus">Hazır değil</span></div>
          <div class="statusPill"><strong>BE Repo</strong><span id="multiBeStatus">Hazır değil</span></div>
          <div class="statusPill"><strong>Traceability</strong><span id="multiTraceabilityStatus">Oluşturulmadı</span></div>
        </div>
      </section>
    </section>
  </main>

  <div class="modalBackdrop" id="qwenModal" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="modalHeader">
        <div>
          <h2>Qwen Ayarları</h2>
          <div class="muted">Endpoint, API key ve semantik cache ayarları. Onaylı host listesi ile uzun AI doküman üretim limitleri VS Code makine ayarlarındadır.</div>
        </div>
        <button class="iconButton ghost" id="closeQwenSettingsButton" type="button">×</button>
      </div>
      <div class="modalBody">
        <label class="checkLabel">
          <input id="qwenEnabled" type="checkbox">
          Qwen entegrasyonu aktif (semantik analiz ve AI doküman üretimi)
        </label>
        <label class="checkLabel">
          <input id="qwenBankingEnvironment" type="checkbox">
          Banking environment (ONIKS / internal vLLM)
        </label>
        <div class="muted">Bu mod model adını ONIKS yapar ve API key kullanımını kapatır. Aşağıdaki alana bankanın tam OpenAI-compatible <code>/v1/chat/completions</code> URL'sini yapıştırabilirsin.</div>
        <label>
          Qwen Endpoint
          <input id="qwenEndpoint" type="text" placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1">
        </label>
        <label>
          Model
          <input id="qwenModel" type="text" placeholder="qwen3">
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
        <div class="muted"><strong>Qwen-only context ve aşama limitleri</strong><br>Bu alanlar Copilot'u etkilemez. Banking için başlangıç önerisi: context 16384, tam üretim 4096, analysis 2048, reduce 3072, synthesis 4096.</div>
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
        <label>
          Sayfa synthesis çıktı bütçesi (token)
          <input id="qwenSynthesisMaxOutputTokens" type="number" min="256" max="65536" step="256">
        </label>
        <label class="checkLabel">
          <input id="qwenUseApiKey" type="checkbox">
          API Key kullan
        </label>
        <label>
          API Key
          <input id="qwenApiKey" type="password" placeholder="Boş bırakılırsa mevcut gizli değer korunur">
        </label>
        <label class="checkLabel">
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
    const tabButtons = document.querySelectorAll(".tabButton");
    const repoUrl = document.getElementById("repoUrl");
    const branch = document.getElementById("branch");
    const analyzeButton = document.getElementById("analyzeButton");
    const status = document.getElementById("status");
    const aiProviderSelect = document.getElementById("aiProviderSelect");
    const copilotModelSelect = document.getElementById("copilotModelSelect");
    const multiProjectName = document.getElementById("multiProjectName");
    const multiBranch = document.getElementById("multiBranch");
    const multiUiRepoUrl = document.getElementById("multiUiRepoUrl");
    const multiBffRepoUrl = document.getElementById("multiBffRepoUrl");
    const multiBeRepoUrl = document.getElementById("multiBeRepoUrl");
    const saveMultiManifestButton = document.getElementById("saveMultiManifestButton");
    const cloneMultiReposButton = document.getElementById("cloneMultiReposButton");
    const analyzeMultiReposButton = document.getElementById("analyzeMultiReposButton");
    const generateReactUiAnalysisButton = document.getElementById("generateReactUiAnalysisButton");
    const generateEndToEndFlowMapButton = document.getElementById("generateEndToEndFlowMapButton");
    const generateLocalKnowledgeGraphButton = document.getElementById("generateLocalKnowledgeGraphButton");
    const generateQwenPageSemanticsButton = document.getElementById("generateQwenPageSemanticsButton");
    const agenticRunQwenSemantics = document.getElementById("agenticRunQwenSemantics");
    const multiRepoStatus = document.getElementById("multiRepoStatus");
    const multiUiStatus = document.getElementById("multiUiStatus");
    const multiBffStatus = document.getElementById("multiBffStatus");
    const multiBeStatus = document.getElementById("multiBeStatus");
    const multiTraceabilityStatus = document.getElementById("multiTraceabilityStatus");
    const selectedPageStatus = document.getElementById("selectedPageStatus");
    const pageAnalysisQwenOnly = document.getElementById("pageAnalysisQwenOnly");
    const runFullSelectedPageAnalysisButton = document.getElementById("runFullSelectedPageAnalysisButton");
    const defaultBranch = document.getElementById("defaultBranch");
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

    function setMultiStatus(title, message) {
      multiRepoStatus.innerHTML = "<strong>" + title + "</strong>" + message;
    }

    function readMultiRepoInput() {
      return {
        projectName: multiProjectName.value,
        branch: multiBranch.value,
        uiRepoUrl: multiUiRepoUrl.value,
        bffRepoUrl: multiBffRepoUrl.value,
        beRepoUrl: multiBeRepoUrl.value
      };
    }

    function statusLabel(statusValue) {
      if (statusValue === "ready") {
        return "Hazır";
      }
      if (statusValue === "analyzed") {
        return "Analiz Edildi";
      }
      if (statusValue === "error") {
        return "Hata";
      }
      return "Hazır değil";
    }

    function applyMultiRepoManifest(manifest) {
      if (!manifest) {
        return;
      }

      multiProjectName.value = manifest.projectName || "";
      multiBranch.value = manifest.branch || "release/liv";
      multiUiRepoUrl.value = manifest.repos?.ui?.url || "";
      multiBffRepoUrl.value = manifest.repos?.bff?.url || "";
      multiBeRepoUrl.value = manifest.repos?.be?.url || "";
      multiUiStatus.textContent = statusLabel(manifest.repos?.ui?.status) + (manifest.repos?.ui?.error ? " - " + manifest.repos.ui.error : "");
      multiBffStatus.textContent = statusLabel(manifest.repos?.bff?.status) + (manifest.repos?.bff?.error ? " - " + manifest.repos.bff.error : "");
      multiBeStatus.textContent = statusLabel(manifest.repos?.be?.status) + (manifest.repos?.be?.error ? " - " + manifest.repos.be.error : "");
      multiTraceabilityStatus.textContent = "Oluşturulmadı";
    }

    function applySelectedPage(page) {
      if (!page) {
        selectedPageStatus.textContent = "Henüz sayfa seçilmedi";
        return;
      }
      selectedPageStatus.textContent =
        (page.route || "route yok") +
        " · " +
        page.pageName +
        " · API: " +
        page.apiCallCount +
        " · BFF: " +
        page.bffMatchStatus +
        " · BE: " +
        page.beMatchStatus +
        " · Güven: " +
        page.confidence;
    }

    function setActiveTab(tabId) {
      tabButtons.forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tabId);
      });
      document.querySelectorAll(".tabPanel").forEach((panel) => {
        panel.classList.toggle("open", panel.id === tabId);
      });
    }

    function renderCopilotModels(models, selectedModelId) {
      const current = selectedModelId || copilotModelSelect.value;
      copilotModelSelect.innerHTML = "";
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "Varsayılan kullanılacak";
      copilotModelSelect.appendChild(defaultOption);

      models.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name + " · " + model.vendor + "/" + model.family + " · " + model.maxInputTokens + " token";
        copilotModelSelect.appendChild(option);
      });
      copilotModelSelect.value = current;
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
          qwenMaxTokens.value = "163849";
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
        temperature: Number(qwenTemperature.value || "0.1"),
        maxTokens: Number(qwenMaxTokens.value || "4096"),
        timeoutSeconds: Number(qwenTimeoutSeconds.value || "120"),
        qwenContextWindowTokens: Number(qwenContextWindowTokens.value || "131072"),
        qwenGenerationMaxTokens: Number(qwenGenerationMaxTokens.value || "16384"),
        qwenAnalysisMaxOutputTokens: Number(qwenAnalysisMaxOutputTokens.value || "2048"),
        qwenReduceMaxOutputTokens: Number(qwenReduceMaxOutputTokens.value || "3072"),
        qwenSynthesisMaxOutputTokens: Number(qwenSynthesisMaxOutputTokens.value || "4096"),
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

    copilotModelSelect.addEventListener("change", () => {
      vscode.postMessage({ type: "saveCopilotModel", modelId: copilotModelSelect.value });
    });

    agenticRunQwenSemantics.addEventListener("change", () => {
      vscode.postMessage({ type: "saveMultiRepoAgenticQwenFlag", enabled: agenticRunQwenSemantics.checked });
    });

    pageAnalysisQwenOnly.addEventListener("change", () => {
      vscode.postMessage({ type: "savePageAnalysisQwenOnly", enabled: pageAnalysisQwenOnly.checked });
    });

    runFullSelectedPageAnalysisButton.addEventListener("click", () => {
      runFullSelectedPageAnalysisButton.disabled = true;
      vscode.postMessage({ type: "runFullSelectedPageAnalysis", qwenOnly: pageAnalysisQwenOnly.checked });
    });

    tabButtons.forEach((button) => {
      button.addEventListener("click", () => setActiveTab(button.dataset.tab));
    });

    saveMultiManifestButton.addEventListener("click", () => {
      saveMultiManifestButton.disabled = true;
      setMultiStatus("Kaydediliyor", "Çoklu repo manifesti yazılıyor...");
      vscode.postMessage({ type: "saveMultiRepoManifest", input: readMultiRepoInput() });
    });

    cloneMultiReposButton.addEventListener("click", () => {
      cloneMultiReposButton.disabled = true;
      setMultiStatus("Çalışıyor", "UI, BFF ve BE repoları hazırlanıyor...");
      vscode.postMessage({ type: "cloneOrUpdateMultiRepos", input: readMultiRepoInput() });
    });

    analyzeMultiReposButton.addEventListener("click", () => {
      analyzeMultiReposButton.disabled = true;
      setMultiStatus("Çalışıyor", "BFF ve BE Spring indeksleri oluşturuluyor...");
      vscode.postMessage({ type: "analyzeMultiReposLocally" });
    });

    generateReactUiAnalysisButton.addEventListener("click", () => {
      generateReactUiAnalysisButton.disabled = true;
      setMultiStatus("Çalışıyor", "React UI indeksleri oluşturuluyor...");
      vscode.postMessage({ type: "generateReactUiAnalysis" });
    });

    generateEndToEndFlowMapButton.addEventListener("click", () => {
      generateEndToEndFlowMapButton.disabled = true;
      setMultiStatus("Çalışıyor", "UI -> BFF -> BE akış eşleşmeleri oluşturuluyor...");
      vscode.postMessage({ type: "generateEndToEndFlowMap" });
    });

    generateLocalKnowledgeGraphButton.addEventListener("click", () => {
      generateLocalKnowledgeGraphButton.disabled = true;
      setMultiStatus("Çalışıyor", "Lokal bilgi grafiği oluşturuluyor...");
      vscode.postMessage({ type: "generateLocalKnowledgeGraph" });
    });

    generateQwenPageSemanticsButton.addEventListener("click", () => {
      generateQwenPageSemanticsButton.disabled = true;
      setMultiStatus("Çalışıyor", "Qwen sayfa semantiği oluşturuluyor...");
      vscode.postMessage({ type: "generateQwenPageSemantics" });
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

    quickTestQwenButton.addEventListener("click", () => {
      setModalOpen(true);
      renderQwenTestResult(true, false, "Qwen endpoint'ine kısa istek gönderiliyor.");
      vscode.postMessage({ type: "testQwenConnection", settings: readQwenSettings() });
    });

    testQwenButton.addEventListener("click", () => {
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
        branch.placeholder = "Boş bırakılırsa " + message.defaultBranch;
        aiProviderSelect.value = message.ai?.provider === "qwen"
          ? "qwen"
          : message.ai?.provider === "copilot" ? "copilot" : "invalid";
        copilotModelSelect.disabled = aiProviderSelect.value === "qwen";
        if (aiProviderSelect.value === "invalid") {
          setStatus("Ayar Hatası", "bankSpringDocs.ai.provider değeri copilot veya qwen olmalıdır.");
        }
        if (!multiBranch.value) {
          multiBranch.value = message.defaultBranch;
        }
        if (message.qwen) {
          qwenEnabled.checked = Boolean(message.qwen.enabled);
          qwenBankingEnvironment.checked = Boolean(message.qwen.bankingEnvironment);
          qwenEndpoint.value = message.qwen.endpoint || "";
          qwenModel.value = message.qwen.model || "";
          qwenTemperature.value = String(message.qwen.temperature ?? 0.1);
          qwenMaxTokens.value = String(message.qwen.maxTokens ?? 4096);
          qwenTimeoutSeconds.value = String(message.qwen.timeoutSeconds ?? 120);
          qwenContextWindowTokens.value = String(message.qwen.qwenContextWindowTokens ?? 131072);
          qwenGenerationMaxTokens.value = String(message.qwen.qwenGenerationMaxTokens ?? 16384);
          qwenAnalysisMaxOutputTokens.value = String(message.qwen.qwenAnalysisMaxOutputTokens ?? 2048);
          qwenReduceMaxOutputTokens.value = String(message.qwen.qwenReduceMaxOutputTokens ?? 3072);
          qwenSynthesisMaxOutputTokens.value = String(message.qwen.qwenSynthesisMaxOutputTokens ?? 4096);
          qwenUseApiKey.checked = Boolean(message.qwen.useApiKey);
          applyBankingEnvironmentState(qwenBankingEnvironment.checked);
        }
        if (message.semantic) {
          semanticCacheEnabled.checked = Boolean(message.semantic.cacheEnabled);
          semanticMaxFilesPerRun.value = String(message.semantic.maxFilesPerRun ?? 50);
          semanticMaxCharactersPerFile.value = String(message.semantic.maxCharactersPerFile ?? 20000);
        }
        if (message.multiRepo) {
          agenticRunQwenSemantics.checked = Boolean(message.multiRepo.agenticRunQwenSemantics);
        }
        if (message.pageAnalysis) {
          pageAnalysisQwenOnly.checked = Boolean(message.pageAnalysis.qwenOnly);
        }
      }
      if (message.type === "copilotModels") {
        renderCopilotModels(message.models || [], message.selectedModelId || "");
      }
      if (message.type === "copilotModelSaved") {
        setStatus("Copilot", message.message);
      }
      if (message.type === "aiProviderSaved") {
        setStatus("AI Sağlayıcısı", message.message);
      }
      if (message.type === "qwenTestResult") {
        renderQwenTestResult(message.testing, message.ok, message.message, message.model, message.endpoint);
      }
      if (message.type === "busy") {
        analyzeButton.disabled = true;
        setStatus("Çalışıyor", message.message);
      }
      if (message.type === "done") {
        analyzeButton.disabled = false;
        setStatus("Tamamlandı", message.message + "<br><br><span class='muted'>" + message.aiDocsPath + "</span>");
      }
      if (message.type === "error") {
        analyzeButton.disabled = false;
        setStatus("Hata", message.message);
      }
      if (message.type === "multiRepoManifest") {
        applyMultiRepoManifest(message.manifest);
      }
      if (message.type === "selectedPage") {
        applySelectedPage(message.page);
      }
      if (message.type === "pageAnalysisRunState") {
        runFullSelectedPageAnalysisButton.disabled = Boolean(message.running);
        runFullSelectedPageAnalysisButton.textContent = message.running
          ? "Tüm Sayfa Analizi Çalışıyor..."
          : "Tüm Sayfa Analizini Çalıştır";
      }
      if (message.type === "multiRepoBusy") {
        saveMultiManifestButton.disabled = true;
        cloneMultiReposButton.disabled = true;
        analyzeMultiReposButton.disabled = true;
        generateReactUiAnalysisButton.disabled = true;
        generateEndToEndFlowMapButton.disabled = true;
        generateLocalKnowledgeGraphButton.disabled = true;
        generateQwenPageSemanticsButton.disabled = true;
        setMultiStatus("Çalışıyor", message.message);
      }
      if (message.type === "multiRepoDone") {
        saveMultiManifestButton.disabled = false;
        cloneMultiReposButton.disabled = false;
        analyzeMultiReposButton.disabled = false;
        generateReactUiAnalysisButton.disabled = false;
        generateEndToEndFlowMapButton.disabled = false;
        generateLocalKnowledgeGraphButton.disabled = false;
        generateQwenPageSemanticsButton.disabled = false;
        if (message.message.includes("akış haritası") || message.message.includes("akÄ±ÅŸ haritasÄ±")) {
          multiTraceabilityStatus.textContent = "Tamamlandı";
        }
        setMultiStatus("Tamamlandı", message.message);
      }
      if (message.type === "multiRepoError") {
        saveMultiManifestButton.disabled = false;
        cloneMultiReposButton.disabled = false;
        analyzeMultiReposButton.disabled = false;
        generateReactUiAnalysisButton.disabled = false;
        generateEndToEndFlowMapButton.disabled = false;
        generateLocalKnowledgeGraphButton.disabled = false;
        generateQwenPageSemanticsButton.disabled = false;
        setMultiStatus("Hata", message.message);
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
