import * as path from "path";
import * as vscode from "vscode";
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
import { PageSectionRegenerator } from "../pageanalysis/gapRepair/pageSectionRegenerator";
import { PageDocumentQualityScorer } from "../pageanalysis/quality/pageDocumentQualityScorer";
import { PageDocumentQualityReportWriter } from "../pageanalysis/quality/pageDocumentQualityReportWriter";
import { SelectedPageStateService } from "../pageanalysis/selectedPageStateService";
import { ArtifactFreshnessService } from "../pageanalysis/artifactFreshnessService";
import { safeName } from "../utils/pathUtils";

export async function buildPageListCommand(context: vscode.ExtensionContext): Promise<PageCandidate | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce UI-BFF-BE manifestini kaydet.");
    return undefined;
  }

  const pages = await new PageListService().list(manifestService.getMultiRepoRoot());
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
      if (!await ensurePagePipelineFreshness(manifestService.getMultiRepoRoot(), manifest)) {
        return;
      }
      const result = await new PageContextPackBuilder().build(manifestService.getMultiRepoRoot(), manifest, selectedPage);
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
  const target = vscode.Uri.file(path.join(
    manifestService.getMultiRepoRoot(),
    "page-analysis",
    "pages",
    safeName(selectedPage.pageName || selectedPage.route || "page"),
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
  const target = vscode.Uri.file(path.join(
    manifestService.getMultiRepoRoot(),
    "page-analysis",
    "pages",
    safeName(selectedPage.pageName || selectedPage.route || "page"),
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
  const pageRoot = selectedPageRoot(manifestService.getMultiRepoRoot(), selectedPage);
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
  const pageRoot = selectedPageRoot(manifestService.getMultiRepoRoot(), selectedPage);
  if (!await exists(path.join(pageRoot, "page-context-pack.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Sayfa context paketi bulunamadÄ±. Ã–nce seÃ§ili sayfayÄ± analiz et.");
    return;
  }
  await warnIfPageArtifactsStale(pageRoot);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Copilot sayfa taslak dokÃ¼manÄ± oluÅŸturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: "Copilot taslak dokÃ¼man isteÄŸi gÃ¶nderiliyor..." });
      const result = await new CopilotPageDraftGenerator().generate(manifestService.getMultiRepoRoot(), pageRoot, token);
      const document = await vscode.workspace.openTextDocument(result.draftPath);
      await vscode.window.showTextDocument(document, { preview: false });
      vscode.window.showInformationMessage(`Bank Spring Docs: Copilot taslak dokÃ¼manÄ± oluÅŸturuldu. YaklaÅŸÄ±k token: ${result.estimatedTotalTokens}.`);
    }
  );
}

export async function detectSelectedPageDocumentGapsCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const manifestService = new MultiRepoManifestService(context);
  const multiRepoRoot = manifestService.getMultiRepoRoot();
  const pageRoot = selectedPageRoot(multiRepoRoot, selectedPage);
  if (!await exists(path.join(pageRoot, "copilot-draft.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Copilot taslak dokÃ¼manÄ± bulunamadÄ±. Ã–nce taslak oluÅŸtur.");
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
  const multiRepoRoot = manifestService.getMultiRepoRoot();
  const pageRoot = selectedPageRoot(multiRepoRoot, selectedPage);
  if (!await exists(path.join(pageRoot, "detected-gaps.json"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Detected gaps bulunamadÄ±. Ã–nce gap analizi yap.");
    return;
  }
  if (await warnIfOutputStale(pageRoot, "detected-gaps.json", ["copilot-draft.md", "page-context-pack.md", "page-evidence-pack.md"])) {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Sayfa gap repair Ã§alÄ±ÅŸÄ±yor",
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: "Eksik/zayÄ±f bÃ¶lÃ¼mler iÃ§in repair context oluÅŸturuluyor..." });
      const result = await new PageSectionRegenerator().repair(multiRepoRoot, pageRoot, token);
      const document = await vscode.workspace.openTextDocument(result.repairedSectionsPath);
      await vscode.window.showTextDocument(document, { preview: false });
      vscode.window.showInformationMessage(`Bank Spring Docs: Gap repair tamamlandÄ±. Gap sayÄ±sÄ±: ${result.repairedGapCount}.`);
    }
  );
}

export async function buildFinalSelectedPageDocumentCommand(context: vscode.ExtensionContext): Promise<void> {
  const selectedPage = new SelectedPageStateService(context).getSelectedPage();
  if (!selectedPage) {
    vscode.window.showWarningMessage("Bank Spring Docs: Ã–nce sayfa listesinden bir sayfa seÃ§.");
    return;
  }
  const pageRoot = selectedPageRoot(new MultiRepoManifestService(context).getMultiRepoRoot(), selectedPage);
  if (!await exists(path.join(pageRoot, "copilot-draft.md"))) {
    vscode.window.showWarningMessage("Bank Spring Docs: Copilot taslak dokÃ¼manÄ± bulunamadÄ±. Ã–nce taslak oluÅŸtur.");
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
  const pageRoot = selectedPageRoot(new MultiRepoManifestService(context).getMultiRepoRoot(), selectedPage);
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
  const multiRepoRoot = manifestService.getMultiRepoRoot();
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

export async function runFullSelectedPageAnalysisCommand(context: vscode.ExtensionContext): Promise<void> {
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

  const multiRepoRoot = manifestService.getMultiRepoRoot();
  try {
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

      if (vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", false)) {
        try {
          progress.report({ message: "4/9 Qwen semantigi olusturuluyor..." });
          await new QwenPageSemanticAnalyzer().analyze(contextResult.pageRoot, context, token);
        } catch (error) {
          vscode.window.showWarningMessage(`Bank Spring Docs: Qwen sayfa semantiÄŸi atlandÄ±: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        progress.report({ message: "4/9 Qwen kapali, semantik adimi atlaniyor..." });
      }

      progress.report({ message: "5/9 Copilot taslak dokumani olusturuluyor..." });
      await new CopilotPageDraftGenerator().generate(multiRepoRoot, contextResult.pageRoot, token);

      progress.report({ message: "6/9 Gap analizi yapiliyor..." });
      const gaps = await new PageDocGapDetector().detect(contextResult.pageRoot, multiRepoRoot);

      if (gaps.length) {
        progress.report({ message: "7/9 Gap repair calistiriliyor..." });
        await new PageSectionRegenerator().repair(multiRepoRoot, contextResult.pageRoot, token);
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
      vscode.window.showInformationMessage(`Bank Spring Docs: TÃ¼m sayfa analizi tamamlandÄ±. Skor: ${score.score} (${score.grade}).`);
    }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) {
      vscode.window.showWarningMessage("Bank Spring Docs: Tum sayfa analizi kullanici tarafindan iptal edildi. Olusan ara dosyalar korundu.");
      return;
    }
    vscode.window.showErrorMessage(`Bank Spring Docs: Tum sayfa analizi tamamlanamadi. Olusan ara dosyalar korundu. Detay: ${message}`);
  }
}

function selectedPageRoot(multiRepoRoot: string, selectedPage: PageCandidate): string {
  return path.join(multiRepoRoot, "page-analysis", "pages", safeName(selectedPage.pageName || selectedPage.route || "page"));
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
