import * as vscode from "vscode";
import * as path from "path";
import { getDefaultBranch } from "../git/branchResolver";
import { LocalKnowledgeGraphBuilder } from "../graph/localKnowledgeGraphBuilder";
import { MultiRepoCopilotAgenticDocumentationGenerator } from "../docs/multiRepoCopilotAgenticDocumentationGenerator";
import { MultiRepoGitService } from "../multirepo/multiRepoGitService";
import { MultiRepoInput, MultiRepoManifest, MultiRepoManifestService } from "../multirepo/multiRepoManifestService";
import { MultiRepoQualityReportGenerator } from "../multirepo/multiRepoQualityReportGenerator";
import { MultiRepoReactAnalysisService } from "../multirepo/multiRepoReactAnalysisService";
import { MultiRepoSpringAnalysisService } from "../multirepo/multiRepoSpringAnalysisService";
import { MultiRepoTraceabilityService } from "../multirepo/multiRepoTraceabilityService";
import { PageSemanticAnalyzer } from "../semantic/multirepo/pageSemanticAnalyzer";

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
      return new MultiRepoGitService().cloneOrUpdateAll(manifest);
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
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(service.getMultiRepoRoot()));
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
  const multiRepoRoot = manifestService.getMultiRepoRoot();

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

  const multiRepoRoot = manifestService.getMultiRepoRoot();
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
          branch: manifest.branch
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
      return new MultiRepoTraceabilityService().build(manifestService.getMultiRepoRoot(), manifest);
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
  if (!vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", false)) {
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
      return new PageSemanticAnalyzer().analyze(manifestService.getMultiRepoRoot(), context, manifest, token);
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
      return new LocalKnowledgeGraphBuilder().build(manifestService.getMultiRepoRoot(), manifest);
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
      return new MultiRepoQualityReportGenerator().generate(manifestService.getMultiRepoRoot(), manifest);
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

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: UI-BFF-BE Agentic Copilot calisiyor",
      cancellable: true
    },
    async (progress, token) => {
      const multiRepoRoot = manifestService.getMultiRepoRoot();
      progress.report({ message: "React UI indeksleri hazirlaniyor..." });
      await new MultiRepoReactAnalysisService().analyze({
        repoUrl: manifest.repos.ui.url,
        repoRoot: manifest.repos.ui.localPath,
        outputRoot: path.join(multiRepoRoot, "ui"),
        branch: manifest.branch
      });

      const springAnalyzer = new MultiRepoSpringAnalysisService();
      progress.report({ message: "BFF Spring indeksleri hazirlaniyor..." });
      await springAnalyzer.analyze({
        repoUrl: manifest.repos.bff.url,
        repoRoot: manifest.repos.bff.localPath,
        outputRoot: path.join(multiRepoRoot, "bff"),
        branch: manifest.branch,
        role: "bff"
      });

      progress.report({ message: "BE Spring indeksleri hazirlaniyor..." });
      await springAnalyzer.analyze({
        repoUrl: manifest.repos.be.url,
        repoRoot: manifest.repos.be.localPath,
        outputRoot: path.join(multiRepoRoot, "be"),
        branch: manifest.branch,
        role: "be"
      });

      progress.report({ message: "Traceability hazirlaniyor..." });
      await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);

      const shouldRunQwen = vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("multiRepo.agenticRunQwenSemantics", true);
      const qwenEnabled = vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", false);
      if (shouldRunQwen && qwenEnabled) {
        progress.report({ message: "Qwen sayfa semantigi agentic pipeline icin hazirlaniyor..." });
        await new PageSemanticAnalyzer().analyze(multiRepoRoot, context, manifest, token);
      } else if (shouldRunQwen && !qwenEnabled) {
        progress.report({ message: "Qwen semantigi acik degil, agentic pipeline Qwen adimini atladi." });
      }

      progress.report({ message: "Knowledge graph ve kalite raporu hazirlaniyor..." });
      await new LocalKnowledgeGraphBuilder().build(multiRepoRoot, manifest);
      await new MultiRepoQualityReportGenerator().generate(multiRepoRoot, manifest);

      manifest.repos.ui.status = "analyzed";
      manifest.repos.bff.status = "analyzed";
      manifest.repos.be.status = "analyzed";
      manifest.repos.ui.error = undefined;
      manifest.repos.bff.error = undefined;
      manifest.repos.be.error = undefined;
      await manifestService.updateManifest(manifest);

      return new MultiRepoCopilotAgenticDocumentationGenerator().generate(
        multiRepoRoot,
        manifest,
        token,
        (event) => progress.report({
          message: event.message,
          increment: event.phase === "started" ? 100 / 7 : 0
        })
      );
    }
  );

  const document = await vscode.workspace.openTextDocument(result.finalDocumentPath);
  await vscode.window.showTextDocument(document, { preview: false });
  const action = await vscode.window.showInformationMessage(
    `Bank Spring Docs: UI-BFF-BE Agentic Copilot tamamlandi. ${result.requestCount} istek, yaklasik ${result.estimatedTotalTokens} token.`,
    "Final Dokumani Ac",
    "Ara Ciktilari Ac",
    "Audit Log Ac"
  );
  if (action === "Final Dokumani Ac") {
    const finalDocument = await vscode.workspace.openTextDocument(result.finalDocumentPath);
    await vscode.window.showTextDocument(finalDocument, { preview: false });
  }
  if (action === "Ara Ciktilari Ac") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(result.workspaceRoot));
  }
  if (action === "Audit Log Ac") {
    const auditPath = path.join(manifestService.getMultiRepoRoot(), "audit", "copilot-requests.jsonl");
    const auditDocument = await vscode.workspace.openTextDocument(auditPath);
    await vscode.window.showTextDocument(auditDocument, { preview: false });
  }

  return manifest;
}

export async function openUnresolvedMultiRepoMatchesCommand(context: vscode.ExtensionContext): Promise<void> {
  const manifestService = new MultiRepoManifestService(context);
  const unresolvedPath = path.join(manifestService.getMultiRepoRoot(), "traceability", "unresolved-matches.jsonl");
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
