import * as path from "path";
import * as vscode from "vscode";
import {
  createDocumentationModelClient,
  createQwenDocumentationModelClient,
  getResumableQwenPageModelIdentity
} from "../ai/documentationModelClientFactory";
import { EvidencePackBuilder } from "../evidence/evidencePackBuilder";
import { MultiRepoManifestService } from "../multirepo/multiRepoManifestService";
import { CopilotPageDraftGenerator } from "../pageanalysis/copilotPageDraftGenerator";
import { PageContextPackBuilder } from "../pageanalysis/pageContextPackBuilder";
import { PageDocGapDetector } from "../pageanalysis/gapDetection/pageDocGapDetector";
import { FinalPageDocumentBuilder } from "../pageanalysis/finalPageDocumentBuilder";
import { PageCandidate, PageListService } from "../pageanalysis/pageListService";
import { PageOutputFreshnessService } from "../pageanalysis/pageOutputFreshnessService";
import { PagePipelineFreshnessService } from "../pageanalysis/pagePipelineFreshnessService";
import { QwenPageSemanticAnalyzer } from "../pageanalysis/qwenPageSemanticAnalyzer";
import { QwenIterativePageDraftGenerator, QwenIterativePageDraftResult } from "../pageanalysis/qwenIterativePageDraftGenerator";
import { PageSectionRegenerator, Qwen3PageSectionRepairOptions } from "../pageanalysis/gapRepair/pageSectionRegenerator";
import { PageDocumentQualityScorer } from "../pageanalysis/quality/pageDocumentQualityScorer";
import { PageDocumentQualityReportWriter } from "../pageanalysis/quality/pageDocumentQualityReportWriter";
import { SelectedPageStateService } from "../pageanalysis/selectedPageStateService";
import { ArtifactFreshnessService } from "../pageanalysis/artifactFreshnessService";
import { safePathSegment } from "../utils/pathUtils";

const activeFullPageAnalysisRuns = new Set<string>();

export async function buildPageListCommand(context: vscode.ExtensionContext): Promise<PageCandidate | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce UI-BFF-BE manifestini kaydet.");
    return undefined;
  }

  const pages = await new PageListService().list(manifestService.getMultiRepoRoot(manifest));
  if (pages.length === 0) {
    vscode.window.showWarningMessage("Bank Spring Docs: Sayfa bulunamadÄ±. Ã–nce React UI analizi oluÅŸtur.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    pages.map((page) => ({
      label: `${page.route ?? "(route yok)"} - ${page.pageName}`,
      description: `${page.apiCallCount} API | BFF: ${statusLabel(page.bffMatchStatus)} | BE: ${statusLabel(page.beMatchStatus)} | ${confidenceLabel(page.confidence)}`,
      detail: page.file,
      page
    })),
    {
      title: "Sayfa BazlÄ± Analiz Ä°Ã§in Sayfa SeÃ§",
      placeHolder: "Analiz edilecek React sayfasÄ±nÄ± seÃ§"
    }
  );

  if (!selected) {
    return undefined;
  }

  await new SelectedPageStateService(context).saveSelectedPage(selected.page);
  vscode.window.showInformationMessage(`Bank Spring Docs: SeÃ§ili sayfa kaydedildi: ${selected.page.pageName}${selected.page.route ? ` (${selected.page.route})` : ""}.`);
  return selected.page;
}

export function getSelectedPageCommand(context: vscode.ExtensionContext): PageCandidate | undefined {
  return new SelectedPageStateService(context).getSelectedPage();
}

export async function analyzeSelectedPageCommand(context: vscode.ExtensionContext): Promise<void> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce UI-BFF-BE manifestini kaydet.");
    return;
  }

  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    const picked = await buildPageListCommand(context);
    if (!picked) {
      return;
    }
    return analyzeSelectedPageCommand(context);
  }

  try {
    await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: SeÃ§ili sayfa analiz ediliyor",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Sayfa context paketi oluÅŸturuluyor..." });
      if (!await ensurePagePipelineFreshness(manifestService.getMultiRepoRoot(manifest), manifest)) {
        return;
      }
      const result = await new PageContextPackBuilder().build(manifestService.getMultiRepoRoot(manifest), manifest, selectedPage);
      progress.report({ message: "Sayfa evidence paketi oluÅŸturuluyor..." });
      await new EvidencePackBuilder().build(result.pageRoot, manifest);
      const document = await vscode.workspace.openTextDocument(result.contextPackPath);
      await vscode.window.showTextDocument(document, { preview: false });
      vscode.window.showInformationMessage(`Bank Spring Docs: Sayfa context paketi oluÅŸturuldu: ${result.contextPackPath}`);
    }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Bank Spring Docs: Secili sayfa analizi tamamlanamadi. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function openSelectedPageContextPackCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const target = vscode.Uri.file(path.join(
    manifestService.getMultiRepoRoot(manifest),
    "page-analysis",
    "pages",
    safePathSegment(selectedPage.pageName || selectedPage.route || "page", "page"),
    "page-context-pack.md"
  ));
  try {
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    vscode.window.showWarningMessage("Bank Spring Docs: Sayfa context paketi bulunamadÄ±. Ã–nce seÃ§ili sayfayÄ± analiz et.");
  }
}

export async function openSelectedPageEvidencePackCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const target = vscode.Uri.file(path.join(
    manifestService.getMultiRepoRoot(manifest),
    "page-analysis",
    "pages",
    safePathSegment(selectedPage.pageName || selectedPage.route || "page", "page"),
    "page-evidence-pack.md"
  ));
  try {
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    vscode.window.showWarningMessage("Bank Spring Docs: Sayfa evidence paketi bulunamadÄ±. Ã–nce seÃ§ili sayfayÄ± analiz et.");
  }
}

export async function generateSelectedPageQwenSemanticsCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  if (!vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", false)) {
    vscode.window.showWarningMessage("Bank Spring Docs: Qwen semantik analiz aktif deÄŸil. Panelden etkinleÅŸtirip ayarlarÄ± kaydet.");
    return;
  }

  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const pageRoot = selectedPageRoot(manifestService.getMultiRepoRoot(manifest), selectedPage);
  if (!await exists(path.join(pageRoot, "page-context-pack.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Sayfa context paketi bulunamadÄ±. Ã–nce seÃ§ili sayfayÄ± analiz et.");
    return;
  }
  await warnIfPageArtifactsStale(pageRoot);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Qwen sayfa semantiÄŸi oluÅŸturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: "Sayfa ve interaction semantik Ã§Ä±ktÄ±larÄ± oluÅŸturuluyor..." });
      const result = await new QwenPageSemanticAnalyzer().analyze(pageRoot, context, token);
      vscode.window.showInformationMessage(
        `Bank Spring Docs: Qwen sayfa semantiÄŸi tamamlandÄ±. Interaction: ${result.analyzedInteractions}, cache: ${result.cacheHits}, hata: ${result.failures}.`
      );
    }
  );
}

export async function generateSelectedPageCopilotDraftCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  const pageRoot = selectedPageRoot(multiRepoRoot, selectedPage);
  if (!await exists(path.join(pageRoot, "page-context-pack.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Sayfa context paketi bulunamadÄ±. Ã–nce seÃ§ili sayfayÄ± analiz et.");
    return;
  }
  await warnIfPageArtifactsStale(pageRoot);

  let modelClient: ReturnType<typeof createDocumentationModelClient>;
  try {
    modelClient = createDocumentationModelClient(context);
  } catch (error) {
    vscode.window.showErrorMessage(`Bank Spring Docs: AI sağlayıcısı hazırlanamadı: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Bank Spring Docs: AI sayfa taslak dokümanı oluşturuluyor",
        cancellable: true
      },
      async (progress, token) => {
        const providerName = modelClient.provider === "qwen" ? "Qwen" : "Copilot";
        progress.report({ message: `${providerName} taslak doküman isteği gönderiliyor...` });
        const result = await new CopilotPageDraftGenerator(modelClient).generate(multiRepoRoot, pageRoot, token);
        const document = await vscode.workspace.openTextDocument(result.draftPath);
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Bank Spring Docs: ${providerName} taslak dokümanı oluşturuldu. Yaklaşık token: ${result.estimatedTotalTokens}.`);
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Bank Spring Docs: AI sayfa taslağı oluşturulamadı: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function detectSelectedPageDocumentGapsCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  const pageRoot = selectedPageRoot(multiRepoRoot, selectedPage);
  if (!await exists(path.join(pageRoot, "copilot-draft.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: AI taslak dokümanı bulunamadı. Önce taslak oluştur.");
    return;
  }
  if (await warnIfOutputStale(pageRoot, "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"])) {
    return;
  }
  const gaps = await new PageDocGapDetector().detect(pageRoot, multiRepoRoot);
  const high = gaps.filter((gap) => gap.severity === "high").length;
  const medium = gaps.filter((gap) => gap.severity === "medium").length;
  const low = gaps.filter((gap) => gap.severity === "low").length;
  const document = await vscode.workspace.openTextDocument(path.join(pageRoot, "detected-gaps.json"));
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage(`Bank Spring Docs: Gap analizi tamamlandÄ±. High: ${high}, Medium: ${medium}, Low: ${low}.`);
}

export async function repairSelectedPageDocumentGapsCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  const pageRoot = selectedPageRoot(multiRepoRoot, selectedPage);
  if (!await exists(path.join(pageRoot, "detected-gaps.json"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Detected gaps bulunamadÄ±. Ã–nce gap analizi yap.");
    return;
  }
  if (await warnIfOutputStale(pageRoot, "detected-gaps.json", ["copilot-draft.md", "page-context-pack.md", "page-evidence-pack.md"])) {
    return;
  }
  let modelClient: ReturnType<typeof createDocumentationModelClient>;
  try {
    modelClient = createDocumentationModelClient(context);
  } catch (error) {
    vscode.window.showErrorMessage(`Bank Spring Docs: AI sağlayıcısı hazırlanamadı: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Bank Spring Docs: Sayfa gap repair Ã§alÄ±ÅŸÄ±yor",
        cancellable: true
      },
      async (progress, token) => {
        progress.report({ message: "Eksik/zayÄ±f bÃ¶lÃ¼mler iÃ§in repair context oluÅŸturuluyor..." });
        const result = await new PageSectionRegenerator(modelClient).repair(multiRepoRoot, pageRoot, token);
        const document = await vscode.workspace.openTextDocument(result.repairedSectionsPath);
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Bank Spring Docs: Gap repair tamamlandÄ±. Gap sayÄ±sÄ±: ${result.repairedGapCount}.`);
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Bank Spring Docs: Gap repair tamamlanamadı: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function buildFinalSelectedPageDocumentCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const pageRoot = selectedPageRoot(manifestService.getMultiRepoRoot(manifest), selectedPage);
  if (!await exists(path.join(pageRoot, "copilot-draft.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: AI taslak dokümanı bulunamadı. Önce taslak oluştur.");
    return;
  }
  if (await warnIfOutputStale(pageRoot, "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"])) {
    return;
  }
  const result = await new FinalPageDocumentBuilder().build(pageRoot);
  const document = await vscode.workspace.openTextDocument(result.finalDocumentPath);
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage("Bank Spring Docs: Final sayfa teknik analiz dokÃ¼manÄ± oluÅŸturuldu.");
}

export async function openFinalSelectedPageDocumentCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const pageRoot = selectedPageRoot(manifestService.getMultiRepoRoot(manifest), selectedPage);
  const target = path.join(pageRoot, "final-page-technical-analysis.md");
  try {
    await warnIfOutputStale(pageRoot, "final-page-technical-analysis.md", ["page-context-pack.md", "page-evidence-pack.md", "copilot-draft.md", "repaired-sections.md"]);
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    vscode.window.showWarningMessage("Bank Spring Docs: Final sayfa dokÃ¼manÄ± bulunamadÄ±. Ã–nce final dokÃ¼manÄ± oluÅŸtur.");
  }
}

export async function scoreSelectedPageDocumentCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  const pageRoot = selectedPageRoot(multiRepoRoot, selectedPage);
  if (!await exists(path.join(pageRoot, "final-page-technical-analysis.md")) && !await exists(path.join(pageRoot, "copilot-draft.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Skorlanacak sayfa dokÃ¼manÄ± bulunamadÄ±. Ã–nce taslak veya final dokÃ¼man oluÅŸtur.");
    return;
  }
  await warnIfOutputStale(pageRoot, await exists(path.join(pageRoot, "final-page-technical-analysis.md")) ? "final-page-technical-analysis.md" : "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"]);
  const score = await new PageDocumentQualityScorer().score(multiRepoRoot, pageRoot);
  const writer = new PageDocumentQualityReportWriter();
  const reportPath = await writer.write(pageRoot, score);
  await writer.writeAggregate(multiRepoRoot);
  const document = await vscode.workspace.openTextDocument(reportPath);
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage(`Bank Spring Docs: Sayfa kalite skoru oluÅŸturuldu. Skor: ${score.score} (${score.grade}).`);
}

export interface FullSelectedPageAnalysisOptions {
  qwenOnly?: boolean;
}

export async function runFullSelectedPageAnalysisCommand(
  context: vscode.ExtensionContext,
  options?: FullSelectedPageAnalysisOptions
): Promise<void> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce UI-BFF-BE manifestini kaydet.");
    return;
  }

  let selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    selectedPage = await buildPageListCommand(context);
    if (!selectedPage) {
      return;
    }
  }

  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  const qwenOnly = options?.qwenOnly
    ?? vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("pageAnalysis.qwenOnly", false);
  const runKey = fullPageAnalysisRunKey(selectedPageRoot(multiRepoRoot, selectedPage));
  if (activeFullPageAnalysisRuns.has(runKey)) {
    vscode.window.showWarningMessage("Bank Spring Docs: Bu sayfa icin tam analiz zaten calisiyor. Mevcut calismanin tamamlanmasini bekleyin.");
    return;
  }
  activeFullPageAnalysisRuns.add(runKey);
  try {
    const modelClient = qwenOnly
      ? createQwenDocumentationModelClient(context)
      : createDocumentationModelClient(context);
    const providerName = qwenOnly ? "Qwen3" : modelClient.provider === "qwen" ? "Qwen" : "Copilot";
    const qwenIdentity = qwenOnly ? getResumableQwenPageModelIdentity(context) : undefined;
    const qwenDraftOptions = qwenIdentity
      ? qwenIterativeOptions(qwenIdentity.model, qwenIdentity.configurationFingerprint, qwenIdentity.family)
      : undefined;
    const qwenCallBudget = qwenOnly
      ? new QwenPageModelCallBudget(qwenDraftOptions?.maxModelCalls ?? 96)
      : undefined;
    const qwenRuntimeDraftOptions = qwenDraftOptions && qwenCallBudget
      ? { ...qwenDraftOptions, onModelCall: (phase: "analysis" | "reduce" | "synthesis") => qwenCallBudget.consume(phase) }
      : qwenDraftOptions;
    const qwenRepairOptions: Qwen3PageSectionRepairOptions | undefined = qwenOnly
      ? qwenRepairOptionsFrom(qwenDraftOptions, qwenCallBudget)
      : undefined;
    let iterativeResult: QwenIterativePageDraftResult | undefined;
    await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: SeÃ§ili sayfa iÃ§in tÃ¼m analiz Ã§alÄ±ÅŸÄ±yor",
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: "1/9 Artifact tazeligi kontrol ediliyor..." });

      if (!await ensurePagePipelineFreshness(multiRepoRoot, manifest)) {
        return;
      }

      progress.report({ message: "2/9 Context paketi olusturuluyor..." });

      const contextResult = await new PageContextPackBuilder().build(multiRepoRoot, manifest, selectedPage);

      progress.report({ message: "3/9 Evidence paketi olusturuluyor..." });
      await new EvidencePackBuilder().build(contextResult.pageRoot, manifest);

      if (qwenOnly || vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", false)) {
        try {
          progress.report({ message: "4/9 Qwen semantigi olusturuluyor..." });
          const semanticAnalyzer = qwenOnly
            ? new QwenPageSemanticAnalyzer(undefined, qwenIdentity?.model, undefined, {
              client: modelClient,
              cacheIdentity: `${qwenDraftOptions?.modelIdentity ?? qwenIdentity?.model ?? "qwen3"}` +
                `@semantic-output-${qwenDraftOptions?.analysisMaxOutputTokens ?? 2048}`,
              expectedModelMarker: "qwen3",
              maxOutputTokens: qwenDraftOptions?.analysisMaxOutputTokens,
              maxGatewayRetries: qwenDraftOptions?.maxGatewayRetries,
              retryBaseDelayMs: qwenDraftOptions?.retryBaseDelayMs,
              onModelCall: () => qwenCallBudget?.consumeSemantic()
            })
            : new QwenPageSemanticAnalyzer();
          const semanticResult = await semanticAnalyzer.analyze(contextResult.pageRoot, context, token);
          if (semanticResult.failures || semanticResult.skippedInteractions) {
            vscode.window.showWarningMessage(
              `Bank Spring Docs: Qwen sayfa semantigi kismi tamamlandi; hata: ${semanticResult.failures}, ` +
              `circuit-breaker ile atlanan interaction: ${semanticResult.skippedInteractions}. Ana iterative dokuman pipeline'i devam ediyor.`
            );
          }
        } catch (error) {
          if (
            token.isCancellationRequested ||
            (qwenOnly && error instanceof Error && (
              error.name === "Qwen3PageSemanticBoundaryError" ||
              error.name === "QwenPageCallBudgetExceededError"
            ))
          ) {
            throw error;
          }
          vscode.window.showWarningMessage(`Bank Spring Docs: Qwen sayfa semantiÄŸi atlandÄ±: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        progress.report({ message: "4/9 Qwen kapali, semantik adimi atlaniyor..." });
      }

      progress.report({ message: `5/9 ${providerName} taslak dokümanı oluşturuluyor...` });
      if (qwenOnly) {
        iterativeResult = await new QwenIterativePageDraftGenerator(
          modelClient,
          qwenRuntimeDraftOptions
        ).generate({
          multiRepoRoot,
          pageRoot: contextResult.pageRoot,
          manifest,
          token,
          onProgress: (update) => progress.report({ message: `5/9 ${update.message}` })
        });
      } else {
        await new CopilotPageDraftGenerator(modelClient).generate(multiRepoRoot, contextResult.pageRoot, token);
      }

      progress.report({ message: "6/9 Gap analizi yapiliyor..." });
      const gaps = await new PageDocGapDetector().detect(contextResult.pageRoot, multiRepoRoot);

      if (gaps.length) {
        progress.report({ message: "7/9 Gap repair calistiriliyor..." });
        const repairResult = await new PageSectionRegenerator(modelClient, qwenRepairOptions).repair(multiRepoRoot, contextResult.pageRoot, token);
        if (qwenOnly && repairResult.missingSections?.length) {
          vscode.window.showWarningMessage(
            `Bank Spring Docs: Qwen3 gap repair ${repairResult.missingSections.length} bolumu tamamlayamadi; ` +
            "mevcut taslak bolumleri korunarak final dokuman olusturulacak."
          );
        }
      } else {
        progress.report({ message: "7/9 Gap bulunmadi, repair atlaniyor..." });
      }

      progress.report({ message: "8/9 Final dokuman olusturuluyor..." });
      const finalResult = await new FinalPageDocumentBuilder().build(contextResult.pageRoot);

      progress.report({ message: "9/9 Kalite skoru olusturuluyor..." });
      const score = await new PageDocumentQualityScorer().score(multiRepoRoot, contextResult.pageRoot);
      const writer = new PageDocumentQualityReportWriter();
      await writer.write(contextResult.pageRoot, score);
      await writer.writeAggregate(multiRepoRoot);

      const document = await vscode.workspace.openTextDocument(finalResult.finalDocumentPath);
      await vscode.window.showTextDocument(document, { preview: false });
      const iterationSummary = iterativeResult
        ? ` Qwen3 chunk: ${iterativeResult.chunkCount}, toplam istek denemesi: ${qwenCallBudget?.used ?? iterativeResult.newModelCallCount}/${qwenCallBudget?.maximum ?? iterativeResult.newModelCallCount}, taslak yeni istegi: ${iterativeResult.newModelCallCount}, yeniden kullanilan adim: ${iterativeResult.reusedStepCount}, coverage uyarisi: ${iterativeResult.warnings?.length ?? 0}.${iterativeResult.runManifestPath ? ` Resume manifesti: ${iterativeResult.runManifestPath}.` : ""}`
        : "";
      vscode.window.showInformationMessage(`Bank Spring Docs: TÃ¼m sayfa analizi tamamlandÄ±. Skor: ${score.score} (${score.grade}).${iterationSummary}`);
    }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel|iptal/i.test(message)) {
      vscode.window.showWarningMessage("Bank Spring Docs: Tum sayfa analizi kullanici tarafindan iptal edildi. Olusan ara dosyalar korundu.");
      return;
    }
    vscode.window.showErrorMessage(`Bank Spring Docs: Tum sayfa analizi tamamlanamadi. Olusan ara dosyalar korundu. Detay: ${message}`);
  } finally {
    activeFullPageAnalysisRuns.delete(runKey);
  }
}

function selectedPageRoot(multiRepoRoot: string, selectedPage: PageCandidate): string {
  return path.join(
    multiRepoRoot,
    "page-analysis",
    "pages",
    safePathSegment(selectedPage.pageName || selectedPage.route || "page", "page")
  );
}

function fullPageAnalysisRunKey(pageRoot: string): string {
  const resolved = path.resolve(pageRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function qwenIterativeOptions(
  model?: string,
  configurationFingerprint?: string,
  modelFamily?: string
): ConstructorParameters<typeof QwenIterativePageDraftGenerator>[1] {
  const config = vscode.workspace.getConfiguration("bankSpringDocs");
  const contextWindowTokens = config.get<number>("qwen.contextWindowTokens", 131072);
  const generationMaxTokens = config.get<number>("qwen.generationMaxTokens", 16384);
  const analysisMaxOutputTokens = Math.min(
    generationMaxTokens,
    readBoundedIntegerSetting(config, "pageAnalysis.qwenAnalysisMaxOutputTokens", 2048, 256, 65536)
  );
  const reduceMaxOutputTokens = Math.min(
    generationMaxTokens,
    readBoundedIntegerSetting(config, "pageAnalysis.qwenReduceMaxOutputTokens", 3072, 256, 65536)
  );
  const synthesisMaxOutputTokens = Math.min(
    generationMaxTokens,
    readBoundedIntegerSetting(config, "pageAnalysis.qwenSynthesisMaxOutputTokens", 4096, 256, 65536)
  );
  const reservedTokens = 2048;
  const largestPhaseOutputTokens = Math.max(
    analysisMaxOutputTokens,
    reduceMaxOutputTokens,
    synthesisMaxOutputTokens
  );
  const safeInputTokens = Math.floor(contextWindowTokens - largestPhaseOutputTokens - reservedTokens);
  const maxInputCharacters = Math.min(60000, safeInputTokens * 3);
  if (!Number.isSafeInteger(maxInputCharacters) || maxInputCharacters < 8001) {
    throw new Error(
      "Qwen3 iteratif sayfa analizi icin context penceresi yetersiz. " +
      "qwen.contextWindowTokens degerini veya qwen.generationMaxTokens ayarini duzeltin."
    );
  }
  // Banking deployments expose Qwen3 through the wire alias ONIKS. The
  // factory adds the family only after validating the exact HTTPS bank
  // endpoint, allowing the iterative boundary to retain its Qwen3 guarantee
  // without changing the model value sent to the server.
  const attestedModel = [modelFamily, model].filter(Boolean).join("/");
  const modelIdentity = [attestedModel, configurationFingerprint].filter(Boolean).join("@");
  return {
    maxInputCharacters,
    maxChunkCharacters: Math.min(42000, maxInputCharacters - 7000),
    maxSourceFileCharacters: readBoundedIntegerSetting(config, "pageAnalysis.qwenMaxSourceFileCharacters", 180000, 12000, 1000000),
    maxTotalSourceCharacters: readBoundedIntegerSetting(config, "pageAnalysis.qwenMaxTotalSourceCharacters", 720000, 30000, 5000000),
    maxModelCalls: readBoundedIntegerSetting(config, "pageAnalysis.qwenMaxModelCalls", 96, 12, 200),
    maxReduceLevels: readBoundedIntegerSetting(config, "pageAnalysis.qwenMaxReduceLevels", 5, 1, 10),
    analysisMaxOutputTokens,
    reduceMaxOutputTokens,
    synthesisMaxOutputTokens,
    maxGatewayRetries: readBoundedIntegerSetting(config, "pageAnalysis.qwenMaxGatewayRetries", 2, 0, 5),
    retryBaseDelayMs: readBoundedIntegerSetting(config, "pageAnalysis.qwenRetryBaseDelayMs", 750, 100, 30000),
    maxAdaptiveSplitDepth: readBoundedIntegerSetting(config, "pageAnalysis.qwenMaxAdaptiveSplitDepth", 3, 0, 8),
    minAdaptiveSplitCharacters: readBoundedIntegerSetting(config, "pageAnalysis.qwenMinAdaptiveSplitCharacters", 4000, 1000, 100000),
    adaptiveSplitOverlapCharacters: readBoundedIntegerSetting(config, "pageAnalysis.qwenAdaptiveSplitOverlapCharacters", 600, 0, 20000),
    finalSectionGroupSize: readBoundedIntegerSetting(config, "pageAnalysis.qwenFinalSectionGroupSize", 4, 1, 17),
    modelIdentity: modelIdentity || "qwen3",
    expectedModelMarker: "qwen3"
  };
}

function qwenRepairOptionsFrom(
  draftOptions: ConstructorParameters<typeof QwenIterativePageDraftGenerator>[1],
  callBudget?: QwenPageModelCallBudget
): Qwen3PageSectionRepairOptions {
  const maxInputCharacters = draftOptions?.maxInputCharacters;
  if (!Number.isSafeInteger(maxInputCharacters) || !maxInputCharacters) {
    throw new Error("Qwen3 gap repair icin provider-derived input butcesi olusturulamadi.");
  }
  return {
    mode: "qwen3",
    maxInputCharacters,
    maxOutputTokens: draftOptions?.synthesisMaxOutputTokens,
    maxGatewayRetries: draftOptions?.maxGatewayRetries,
    retryBaseDelayMs: draftOptions?.retryBaseDelayMs,
    onModelCall: () => callBudget?.consume("repair"),
    expectedModelMarker: draftOptions?.expectedModelMarker ?? "qwen3"
  };
}

class QwenPageModelCallBudget {
  used = 0;
  private semanticUsed = 0;
  private readonly semanticMaximum: number;

  constructor(readonly maximum: number) {
    // Semantic enrichment is optional. Preserve enough attempts for bounded
    // evidence mapping, grouped synthesis and a small repair pass.
    this.semanticMaximum = Math.min(9, Math.max(0, maximum - 12));
  }

  consumeSemantic(): void {
    if (this.semanticUsed >= this.semanticMaximum) {
      const error = new Error(
        `Qwen3 semantik zenginlestirme ${this.semanticMaximum} istek denemesi sinirina ulasti; zorunlu dokuman asamalari icin kapasite korundu.`
      );
      error.name = "QwenSemanticCallBudgetReservedError";
      throw error;
    }
    this.consume("semantic");
    this.semanticUsed += 1;
  }

  consume(phase: "semantic" | "analysis" | "reduce" | "synthesis" | "repair"): void {
    if (this.used >= this.maximum) {
      const error = new Error(
        `Qwen3 tam sayfa pipeline'i ${this.maximum} toplam model istek denemesi sinirina ulasti (${phase}). Ara ciktilar korundu.`
      );
      error.name = "QwenPageCallBudgetExceededError";
      throw error;
    }
    this.used += 1;
  }
}

function readBoundedIntegerSetting(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = config.get<number>(key, fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`bankSpringDocs.${key} ayari ${minimum}-${maximum} araliginda bir tam sayi olmalidir.`);
  }
  return value;
}

async function ensurePagePipelineFreshness(multiRepoRoot: string, manifest: NonNullable<Awaited<ReturnType<MultiRepoManifestService["readManifest"]>>>): Promise<boolean> {
  const result = await new PagePipelineFreshnessService().ensure(multiRepoRoot, manifest);
  const highIssues = result.issues.filter((issue) => issue.severity === "high");
  if (highIssues.length) {
    vscode.window.showWarningMessage(
      `Bank Spring Docs: Sayfa analizi baslatilamadi. ${highIssues.length} zorunlu temel artifact eksik. Once UI, BFF ve BE yerel analizlerini calistir. Detay: ${result.reportPath}`
    );
    return false;
  }
  const warnings = result.issues.filter((issue) => issue.severity !== "high");
  if (warnings.length) {
    vscode.window.showWarningMessage(`Bank Spring Docs: Sayfa analizi ${warnings.length} artifact uyarisi ile devam ediyor. Detay: ${result.reportPath}`);
  }
  return true;
}

async function warnIfOutputStale(pageRoot: string, target: string, dependencies: string[]): Promise<boolean> {
  const existingDependencies: string[] = [];
  for (const dependency of dependencies) {
    if (await exists(path.join(pageRoot, dependency))) {
      existingDependencies.push(dependency);
    }
  }
  const result = await new PageOutputFreshnessService().check(pageRoot, target, existingDependencies);
  const staleIssues = result.issues.filter((issue) => issue.problem === "stale-target");
  if (staleIssues.length) {
    vscode.window.showWarningMessage(
      `Bank Spring Docs: ${target} eski gorunuyor (${staleIssues.length} stale dependency). Detay: ${result.reportPath}`
    );
  }
  return staleIssues.length > 0;
}

async function warnIfPageArtifactsStale(pageRoot: string): Promise<void> {
  const result = await new ArtifactFreshnessService().check(pageRoot);
  if (result.warnings.length) {
    vscode.window.showWarningMessage(
      `Bank Spring Docs: Sayfa artifactlerinde ${result.warnings.length} eksik/eski girdi uyarisi var. Islem devam edecek. Detay: ${result.reportPath}`
    );
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

function statusLabel(status: string): string {
  if (status === "matched") {
    return "eÅŸleÅŸti";
  }
  if (status === "partial") {
    return "kÄ±smi";
  }
  if (status === "none") {
    return "yok";
  }
  return "bilinmiyor";
}

function confidenceLabel(confidence: string): string {
  if (confidence === "high") {
    return "yÃ¼ksek gÃ¼ven";
  }
  if (confidence === "medium") {
    return "orta gÃ¼ven";
  }
  if (confidence === "low") {
    return "dÃ¼ÅŸÃ¼k gÃ¼ven";
  }
  return "gÃ¼ven bilinmiyor";
}
