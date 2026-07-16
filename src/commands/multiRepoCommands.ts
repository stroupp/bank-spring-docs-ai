import * as vscode from "vscode";
import * as path from "path";
import { getDefaultBranch } from "../git/branchResolver";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { createDocumentationModelClient, getConfiguredDocumentationModelIdentity } from "../ai/documentationModelClientFactory";
import { LocalKnowledgeGraphBuilder } from "../graph/localKnowledgeGraphBuilder";
import { MultiRepoCopilotAgenticDocumentationGenerator } from "../docs/multiRepoCopilotAgenticDocumentationGenerator";
import { MultiRepoAgenticRunStatusWriter } from "../docs/multiRepoAgenticRunStatus";
import { MultiRepoGitService } from "../multirepo/multiRepoGitService";
import { MultiRepoInput, MultiRepoManifest, MultiRepoManifestService } from "../multirepo/multiRepoManifestService";
import { MultiRepoQualityReportGenerator } from "../multirepo/multiRepoQualityReportGenerator";
import { MultiRepoReactAnalysisService } from "../multirepo/multiRepoReactAnalysisService";
import { MultiRepoSpringAnalysisService } from "../multirepo/multiRepoSpringAnalysisService";
import { MultiRepoTraceabilityService } from "../multirepo/multiRepoTraceabilityService";
import { MultiRepoArtifactIdentityService } from "../multirepo/multiRepoArtifactIdentityService";
import { PipelineArtifactReceiptService } from "../multirepo/pipelineArtifactReceiptService";
import { PageSemanticAnalyzer } from "../semantic/multirepo/pageSemanticAnalyzer";
import { SelectedPageStateService } from "../pageanalysis/selectedPageStateService";

export async function openUiBffBeAnalysisPanelCommand(): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.bankSpringDocs");
}

export async function saveMultiRepoManifestCommand(
  context: vscode.ExtensionContext,
  input?: MultiRepoInput
): Promise<MultiRepoManifest | undefined> {
  const manifestInput = input ?? await promptForManifestInput(context);
  if (!manifestInput) {
    return undefined;
  }

  const service = new MultiRepoManifestService(context);
  const manifest = await service.saveManifest(manifestInput);
  await new SelectedPageStateService(context).clearSelectedPage();
  vscode.window.showInformationMessage("Bank Spring Docs: Coklu repo manifesti kaydedildi.");
  return manifest;
}

export async function cloneOrUpdateMultiReposCommand(
  context: vscode.ExtensionContext,
  input?: MultiRepoInput
): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = input ? await manifestService.saveManifest(input) : await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Coklu repolar hazirlaniyor",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "UI, BFF ve BE repolari clone/fetch ediliyor..." });
      return new MultiRepoGitService(manifestService.getCloneRoot()).cloneOrUpdateAll(manifest);
    }
  );

  const updatedManifest = await manifestService.updateManifest(result.manifest);
  if (result.failed.length > 0) {
    vscode.window.showWarningMessage(
      `Bank Spring Docs: ${result.cloned.length} repo hazirlandi, ${result.failed.length} repo hata aldi. Manifest detaylarini kontrol et.`
    );
  } else {
    vscode.window.showInformationMessage("Bank Spring Docs: Tum coklu repolar hazir.");
  }

  return updatedManifest;
}

export async function openMultiRepoOutputFolderCommand(context: vscode.ExtensionContext): Promise<void> {
  const service = new MultiRepoManifestService(context);
  const manifest = await service.readManifest();
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(service.getMultiRepoRoot(manifest)));
}

export async function analyzeMultiReposLocallyCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const failed: string[] = [];
  const analyzed: string[] = [];
  const springAnalyzer = new MultiRepoSpringAnalysisService();
  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: BFF ve BE yerel analiz ediliyor",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "BFF Spring indeksleri olusturuluyor..." });
      try {
        await springAnalyzer.analyze({
          repoUrl: manifest.repos.bff.url,
          repoRoot: manifest.repos.bff.localPath,
          outputRoot: path.join(multiRepoRoot, "bff"),
          branch: manifest.branch,
          pipelineIdentity: manifest.pipelineIdentity,
          role: "bff"
        });
        manifest.repos.bff.status = "analyzed";
        manifest.repos.bff.error = undefined;
        analyzed.push("BFF");
      } catch (error) {
        manifest.repos.bff.status = "error";
        manifest.repos.bff.error = error instanceof Error ? error.message : String(error);
        failed.push(`BFF: ${manifest.repos.bff.error}`);
      }

      progress.report({ message: "BE Spring indeksleri olusturuluyor..." });
      try {
        await springAnalyzer.analyze({
          repoUrl: manifest.repos.be.url,
          repoRoot: manifest.repos.be.localPath,
          outputRoot: path.join(multiRepoRoot, "be"),
          branch: manifest.branch,
          pipelineIdentity: manifest.pipelineIdentity,
          role: "be"
        });
        manifest.repos.be.status = "analyzed";
        manifest.repos.be.error = undefined;
        analyzed.push("BE");
      } catch (error) {
        manifest.repos.be.status = "error";
        manifest.repos.be.error = error instanceof Error ? error.message : String(error);
        failed.push(`BE: ${manifest.repos.be.error}`);
      }

      if (manifest.repos.ui.status === "not-analyzed") {
        manifest.repos.ui.status = manifest.repos.ui.url ? "ready" : "not-analyzed";
      }
    }
  );

  const updated = await manifestService.updateManifest(manifest);
  if (failed.length > 0) {
    vscode.window.showWarningMessage(`Bank Spring Docs: ${analyzed.join(", ") || "Repo"} analiz tamamlandi, ${failed.length} hata var.`);
  } else {
    vscode.window.showInformationMessage("Bank Spring Docs: BFF ve BE yerel analizleri tamamlandi.");
  }

  return updated;
}

export async function generateReactUiAnalysisCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Bank Spring Docs: React UI analizi olusturuluyor",
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: "React dosyalari taraniyor ve UI indeksleri uretiliyor..." });
        return new MultiRepoReactAnalysisService().analyze({
          repoUrl: manifest.repos.ui.url,
          repoRoot: manifest.repos.ui.localPath,
          outputRoot: path.join(multiRepoRoot, "ui"),
          branch: manifest.branch,
          pipelineIdentity: manifest.pipelineIdentity
        });
      }
    );

    manifest.repos.ui.status = "analyzed";
    manifest.repos.ui.error = undefined;
    const updated = await manifestService.updateManifest(manifest);
    vscode.window.showInformationMessage(
      `Bank Spring Docs: React UI analizi tamamlandi. ${result.indexedFiles} dosya, ${result.routes} route, ${result.apiCalls} API cagrisi indekslendi.`
    );
    return updated;
  } catch (error) {
    manifest.repos.ui.status = "error";
    manifest.repos.ui.error = error instanceof Error ? error.message : String(error);
    const updated = await manifestService.updateManifest(manifest);
    vscode.window.showErrorMessage(`Bank Spring Docs: React UI analizi hatasi: ${manifest.repos.ui.error}`);
    return updated;
  }
}

export async function generateEndToEndFlowMapCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Uctan uca akis haritasi olusturuluyor",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "UI -> BFF -> BE eslesmeleri hesaplaniyor..." });
      return new MultiRepoTraceabilityService().build(manifestService.getMultiRepoRoot(manifest), manifest);
    }
  );

  const updated = await manifestService.updateManifest(manifest);
  vscode.window.showInformationMessage(
    `Bank Spring Docs: Akis haritasi tamamlandi. UI-BFF ${result.uiToBffMatches}, BFF-BE ${result.bffToBeMatches}, unresolved ${result.unresolved}.`
  );
  return updated;
}

export async function generateQwenPageSemanticsCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }
  if (!vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", true)) {
    vscode.window.showWarningMessage("Bank Spring Docs: Qwen semantik analiz aktif degil. Panelden etkinlestirip ayarlari kaydet.");
    return manifest;
  }

  const stats = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Qwen sayfa semantigi olusturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: "UI interaction ve page-flow context paketleri hazirlaniyor..." });
      const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
      await new MultiRepoArtifactIdentityService().assertCompatible(multiRepoRoot, manifest);
      await new PipelineArtifactReceiptService().assertTraceabilityCompatible(multiRepoRoot, manifest);
      return new PageSemanticAnalyzer().analyze(multiRepoRoot, context, manifest, token);
    }
  );

  vscode.window.showInformationMessage(
    `Bank Spring Docs: Qwen sayfa semantigi tamamlandi. Interaction ${stats.interactionsAnalyzed}/${stats.interactionCacheHits} cache, flow ${stats.pageFlowsAnalyzed}/${stats.pageFlowCacheHits} cache, hata ${stats.failures}.`
  );
  return manifest;
}

export async function generateLocalKnowledgeGraphCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Lokal bilgi grafigi olusturuluyor",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "JSONL indekslerden node ve edge dosyalari uretiliyor..." });
      return new LocalKnowledgeGraphBuilder().build(manifestService.getMultiRepoRoot(manifest), manifest);
    }
  );

  vscode.window.showInformationMessage(`Bank Spring Docs: Lokal bilgi grafigi olusturuldu. ${result.nodes} node, ${result.edges} edge.`);
  return manifest;
}

export async function generateMultiRepoQualityReportCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Coklu repo kalite raporu olusturuluyor",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Yerel JSONL artifact dosyalari denetleniyor..." });
      return new MultiRepoQualityReportGenerator().generate(manifestService.getMultiRepoRoot(manifest), manifest);
    }
  );

  await vscode.window.showTextDocument(vscode.Uri.file(result.markdownPath), { preview: false });
  vscode.window.showInformationMessage(
    `Bank Spring Docs: Coklu repo kalite raporu hazir. Puan ${result.score}/100, kritik bulgu ${result.criticalFindings}.`
  );
  return manifest;
}

export async function generateMultiRepoAgenticCopilotDocsCommand(context: vscode.ExtensionContext): Promise<MultiRepoManifest | undefined> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  if (!manifest) {
    vscode.window.showWarningMessage("Bank Spring Docs: Once coklu repo manifesti kaydet.");
    return undefined;
  }

  const multiRepoRoot = manifestService.getMultiRepoRoot(manifest);
  let modelClient: ReturnType<typeof createDocumentationModelClient>;
  let generationIdentity: ReturnType<typeof getConfiguredDocumentationModelIdentity>;
  try {
    modelClient = createDocumentationModelClient(context);
    generationIdentity = getConfiguredDocumentationModelIdentity(context);
  } catch (error) {
    vscode.window.showErrorMessage(`Bank Spring Docs: AI sağlayıcısı hazırlanamadı: ${errorText(error)}`);
    return manifest;
  }
  const providerName = modelClient.provider === "qwen" ? "Qwen" : "Copilot";
  let runStatus: MultiRepoAgenticRunStatusWriter;
  try {
    const resumable = await MultiRepoAgenticRunStatusWriter.loadLatestResumable(multiRepoRoot, manifest, generationIdentity);
    if (resumable) {
      const previous = resumable.snapshot();
      const completedGenerationSteps = previous.phases.filter((phase) => phase.category === "copilot" && phase.status === "completed").length;
      const action = await vscode.window.showWarningMessage(
        `Bank Spring Docs: Önceki Agentic çalışma '${previous.currentPhase ?? "bilinmeyen aşama"}' aşamasında durdu. ${completedGenerationSteps} ${providerName} adımı yeniden kullanılabilir.`,
        { modal: true },
        "Kaldığı Yerden Devam Et",
        "Yeni Analiz Başlat",
        "İptal"
      );
      if (action === "Kaldığı Yerden Devam Et") {
        runStatus = resumable;
        await runStatus.prepareResume();
      } else if (action === "Yeni Analiz Başlat") {
        runStatus = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest, undefined, generationIdentity);
      } else {
        return manifest;
      }
    } else {
      runStatus = await MultiRepoAgenticRunStatusWriter.create(multiRepoRoot, manifest, undefined, generationIdentity);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Bank Spring Docs: Agentic çalışma durumu oluşturulamadı: ${errorText(error)}`);
    return manifest;
  }

  let cancelled = false;
  let result;
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Bank Spring Docs: UI-BFF-BE Agentic ${providerName} çalışıyor`,
        cancellable: true
      },
      async (progress, token) => {
        const ensureNotCancelled = (): void => {
          if (token.isCancellationRequested) {
            throw new Error("Agentic analysis was cancelled by the user.");
          }
          };
        try {
          ensureNotCancelled();
          if (runStatus.isPhaseReusable("local-ui-analysis")) {
            progress.report({ message: "React UI analizi önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("local-ui-analysis");
            progress.report({ message: "React UI indeksleri hazırlanıyor..." });
            const uiResult = await new MultiRepoReactAnalysisService().analyze({
              repoUrl: manifest.repos.ui.url,
              repoRoot: manifest.repos.ui.localPath,
              outputRoot: path.join(multiRepoRoot, "ui"),
              branch: manifest.branch,
              pipelineIdentity: manifest.pipelineIdentity
            });
            await runStatus.completePhase("local-ui-analysis", {
              details: { ...uiResult },
              artifacts: [path.join(uiResult.outputRoot, "repo-map.md"), path.join(uiResult.outputRoot, "manifest.json")]
            });
          }

          ensureNotCancelled();
          const springAnalyzer = new MultiRepoSpringAnalysisService();
          if (runStatus.isPhaseReusable("local-bff-analysis")) {
            progress.report({ message: "BFF analizi önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("local-bff-analysis");
            progress.report({ message: "BFF Spring indeksleri hazırlanıyor..." });
            const bffResult = await springAnalyzer.analyze({
              repoUrl: manifest.repos.bff.url,
              repoRoot: manifest.repos.bff.localPath,
              outputRoot: path.join(multiRepoRoot, "bff"),
              branch: manifest.branch,
              pipelineIdentity: manifest.pipelineIdentity,
              role: "bff"
            });
            await runStatus.completePhase("local-bff-analysis", {
              details: { ...bffResult },
              artifacts: [path.join(bffResult.outputRoot, "repo-map.md"), path.join(bffResult.outputRoot, "manifest.json")]
            });
          }

          ensureNotCancelled();
          if (runStatus.isPhaseReusable("local-be-analysis")) {
            progress.report({ message: "BE analizi önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("local-be-analysis");
            progress.report({ message: "BE Spring indeksleri hazırlanıyor..." });
            const beResult = await springAnalyzer.analyze({
              repoUrl: manifest.repos.be.url,
              repoRoot: manifest.repos.be.localPath,
              outputRoot: path.join(multiRepoRoot, "be"),
              branch: manifest.branch,
              pipelineIdentity: manifest.pipelineIdentity,
              role: "be"
            });
            await runStatus.completePhase("local-be-analysis", {
              details: { ...beResult },
              artifacts: [path.join(beResult.outputRoot, "repo-map.md"), path.join(beResult.outputRoot, "manifest.json")]
            });
          }

          ensureNotCancelled();
          if (runStatus.isPhaseReusable("local-traceability")) {
            progress.report({ message: "Traceability önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("local-traceability");
            progress.report({ message: "Traceability hazırlanıyor..." });
            const traceabilityResult = await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);
            await runStatus.completePhase("local-traceability", {
              details: { ...traceabilityResult },
              artifacts: [traceabilityResult.reportPath, path.join(multiRepoRoot, "traceability", "traceability-report.json")]
            });
          }

          ensureNotCancelled();
          const shouldRunQwen = vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("multiRepo.agenticRunQwenSemantics", true);
          const qwenEnabled = vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", true);
          if (runStatus.isPhaseReusable("qwen-semantics")) {
            progress.report({ message: "Qwen semantiği önceki çalışmadan yeniden kullanılıyor..." });
          } else if (shouldRunQwen && qwenEnabled) {
            await runStatus.startPhase("qwen-semantics");
            progress.report({ message: "Qwen sayfa semantiği Agentic pipeline için hazırlanıyor..." });
            const qwenStats = await new PageSemanticAnalyzer().analyze(multiRepoRoot, context, manifest, token);
            await runStatus.updatePhase("qwen-semantics", {
              details: { ...qwenStats, partial: qwenStats.failures > 0 },
              artifacts: [
                path.join(multiRepoRoot, "ui", "semantic", "interaction-semantics.jsonl"),
                path.join(multiRepoRoot, "traceability", "semantic", "page-flow-semantics.jsonl")
              ]
            });
            ensureNotCancelled();
            await runStatus.completePhase("qwen-semantics", { details: { warning: qwenStats.failures > 0 ? `${qwenStats.failures} semantic item(s) failed.` : undefined } });
            if (qwenStats.failures > 0) {
              progress.report({ message: `Qwen semantik analizi kısmen tamamlandı; ${qwenStats.failures} hata çalışma durumuna kaydedildi.` });
            }
          } else {
            const reason = shouldRunQwen ? "Qwen is disabled in settings." : "Agentic Qwen semantics is disabled in settings.";
            await runStatus.skipPhase("qwen-semantics", reason);
            progress.report({ message: "Qwen semantiği kapalı; Agentic pipeline bu adımı atladı." });
          }

          ensureNotCancelled();
          if (runStatus.isPhaseReusable("knowledge-graph")) {
            progress.report({ message: "Knowledge graph önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("knowledge-graph");
            progress.report({ message: "Knowledge graph hazırlanıyor..." });
            const graphResult = await new LocalKnowledgeGraphBuilder().build(multiRepoRoot, manifest);
            await runStatus.completePhase("knowledge-graph", {
              details: { ...graphResult },
              artifacts: [graphResult.summaryPath, path.join(graphResult.graphRoot, "graph-summary.json")]
            });
          }

          ensureNotCancelled();
          if (runStatus.isPhaseReusable("quality-report")) {
            progress.report({ message: "Kalite raporu önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("quality-report");
            progress.report({ message: "Çoklu repo kalite raporu hazırlanıyor..." });
            const qualityResult = await new MultiRepoQualityReportGenerator().generate(multiRepoRoot, manifest);
            await runStatus.completePhase("quality-report", {
              details: { ...qualityResult },
              artifacts: [qualityResult.markdownPath, qualityResult.jsonPath]
            });
          }

          ensureNotCancelled();
          if (runStatus.isPhaseReusable("manifest-update")) {
            progress.report({ message: "Manifest önceki çalışmadan yeniden kullanılıyor..." });
          } else {
            await runStatus.startPhase("manifest-update");
            manifest.repos.ui.status = "analyzed";
            manifest.repos.bff.status = "analyzed";
            manifest.repos.be.status = "analyzed";
            manifest.repos.ui.error = undefined;
            manifest.repos.bff.error = undefined;
            manifest.repos.be.error = undefined;
            await manifestService.updateManifest(manifest);
            await runStatus.completePhase("manifest-update", { artifacts: [path.join(multiRepoRoot, "manifest.json")] });
          }

          ensureNotCancelled();
          return await new MultiRepoCopilotAgenticDocumentationGenerator(undefined, modelClient).generate(
            multiRepoRoot,
            manifest,
            token,
            (event) => progress.report({
              message: event.message,
              increment: event.phase === "started" ? 100 / 7 : 0
            }),
            runStatus
          );
        } catch (error) {
          cancelled = token.isCancellationRequested || /cancel/i.test(errorText(error));
          if (runStatus.snapshot().status === "running") {
            try {
              await runStatus.finishFailure(error, cancelled);
            } catch {
              // Preserve the pipeline error if status persistence also fails.
            }
          }
          throw error;
        }
      }
    );
  } catch (error) {
    const phaseId = runStatus.snapshot().currentPhase ?? "unknown";
    const action = cancelled
      ? await vscode.window.showWarningMessage(
        "Bank Spring Docs: Agentic analiz iptal edildi. Tamamlanan ara çıktılar ve çalışma durumu korundu.",
        "Çalışma Durumunu Aç",
        "Ara Çıktıları Aç"
      )
      : await vscode.window.showErrorMessage(
        `Bank Spring Docs: Agentic analiz '${phaseId}' aşamasında başarısız oldu. Çalışma durumu ve ara çıktılar korundu.`,
        "Çalışma Durumunu Aç",
        "Ara Çıktıları Aç"
      );
    if (action === "Çalışma Durumunu Aç") {
      await vscode.window.showTextDocument(vscode.Uri.file(runStatus.runStatusMarkdownPath), { preview: false });
    }
    if (action === "Ara Çıktıları Aç") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(runStatus.workspaceRoot));
    }
    return manifest;
  }

  const document = await vscode.workspace.openTextDocument(result.finalDocumentPath);
  await vscode.window.showTextDocument(document, { preview: false });
  const action = await vscode.window.showInformationMessage(
    `Bank Spring Docs: UI-BFF-BE Agentic ${providerName} tamamlandı. ${result.newRequestCount} yeni istek, ${result.reusedStepCount} yeniden kullanılan adım, toplam ${result.requestCount} istek denemesi.`,
    "Final Dokumani Ac",
    "Ara Ciktilari Ac",
    "Audit Log Ac",
    "Çalışma Durumunu Aç"
  );
  if (action === "Final Dokumani Ac") {
    const finalDocument = await vscode.workspace.openTextDocument(result.finalDocumentPath);
    await vscode.window.showTextDocument(finalDocument, { preview: false });
  }
  if (action === "Ara Ciktilari Ac") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(result.workspaceRoot));
  }
  if (action === "Audit Log Ac") {
    const auditPath = path.join(manifestService.getMultiRepoRoot(manifest), "audit", "copilot-requests.jsonl");
    const auditDocument = await vscode.workspace.openTextDocument(auditPath);
    await vscode.window.showTextDocument(auditDocument, { preview: false });
  }
  if (action === "Çalışma Durumunu Aç") {
    await vscode.window.showTextDocument(vscode.Uri.file(runStatus.runStatusMarkdownPath), { preview: false });
  }

  return manifest;
}

export async function openUnresolvedMultiRepoMatchesCommand(context: vscode.ExtensionContext): Promise<void> {
  const manifestService = new MultiRepoManifestService(context);
  const manifest = await manifestService.readManifest();
  const unresolvedPath = path.join(manifestService.getMultiRepoRoot(manifest), "traceability", "unresolved-matches.jsonl");
  await vscode.workspace.fs.stat(vscode.Uri.file(unresolvedPath)).then(
    async () => vscode.window.showTextDocument(vscode.Uri.file(unresolvedPath), { preview: false }),
    async () => {
      vscode.window.showWarningMessage("Bank Spring Docs: Eslesmeyen akis dosyasi bulunamadi. Once uctan uca akis haritasi olustur.");
    }
  );
}

export async function multiRepoPhaseNotImplementedCommand(featureName: string): Promise<void> {
  vscode.window.showInformationMessage(`Bank Spring Docs: ${featureName} Phase A sonrasinda eklenecek.`);
}

function errorText(error: unknown): string {
  return maskSecretsWithStats(error instanceof Error ? error.message : String(error)).text.slice(0, 1000);
}

async function promptForManifestInput(context: vscode.ExtensionContext): Promise<MultiRepoInput | undefined> {
  const previous = await new MultiRepoManifestService(context).readManifest();
  const projectName = await vscode.window.showInputBox({
    title: "Proje Adi",
    value: previous?.projectName ?? "",
    prompt: "UI - BFF - BE analiz projesinin adini gir."
  });
  if (projectName === undefined) {
    return undefined;
  }

  const branch = await vscode.window.showInputBox({
    title: "Ortak Branch",
    value: previous?.branch ?? getDefaultBranch(),
    prompt: "Uc repository icin kullanilacak branch."
  });
  if (branch === undefined) {
    return undefined;
  }

  const uiRepoUrl = await vscode.window.showInputBox({
    title: "UI Repo URL",
    value: previous?.repos.ui.url ?? "",
    prompt: "React UI repository URL."
  });
  if (uiRepoUrl === undefined) {
    return undefined;
  }

  const bffRepoUrl = await vscode.window.showInputBox({
    title: "BFF Repo URL",
    value: previous?.repos.bff.url ?? "",
    prompt: "Spring BFF repository URL."
  });
  if (bffRepoUrl === undefined) {
    return undefined;
  }

  const beRepoUrl = await vscode.window.showInputBox({
    title: "BE Repo URL",
    value: previous?.repos.be.url ?? "",
    prompt: "Spring BE repository URL."
  });
  if (beRepoUrl === undefined) {
    return undefined;
  }

  return {
    projectName,
    branch: branch || getDefaultBranch(),
    uiRepoUrl,
    bffRepoUrl,
    beRepoUrl
  };
}
