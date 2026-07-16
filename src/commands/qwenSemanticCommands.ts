import * as vscode from "vscode";
import { ClassSemanticAnalyzer } from "../semantic/classSemanticAnalyzer";
import { DependencySemanticAnalyzer } from "../semantic/dependencySemanticAnalyzer";
import { EndpointSemanticAnalyzer } from "../semantic/endpointSemanticAnalyzer";
import { EnrichedRepoMapBuilder } from "../semantic/enrichedRepoMapBuilder";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function generateQwenSemanticAnalysisCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }
  if (!vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("qwen.enabled", true)) {
    vscode.window.showWarningMessage("Bank Spring Docs: Qwen semantik analiz aktif değil. Panelden etkinleştirip ayarları kaydet.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Qwen semantik analiz oluşturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: "Sınıf açıklamaları oluşturuluyor..." });
      const classStats = await new ClassSemanticAnalyzer().analyze(lastAnalysis.repoRoot, lastAnalysis.aiDocsPath, context, token);
      progress.report({ message: "Endpoint açıklamaları oluşturuluyor..." });
      const endpointStats = await new EndpointSemanticAnalyzer().analyze(lastAnalysis.repoRoot, lastAnalysis.aiDocsPath, context, token);
      progress.report({ message: "Bağımlılık açıklamaları oluşturuluyor..." });
      const dependencyStats = await new DependencySemanticAnalyzer().analyze(lastAnalysis.aiDocsPath, context, token);
      vscode.window.showInformationMessage(
        `Bank Spring Docs: Qwen semantik analiz tamamlandı. Sınıf ${classStats.analyzed}/${classStats.cacheHits} cache, endpoint ${endpointStats.analyzed}/${endpointStats.cacheHits} cache, bağımlılık ${dependencyStats.analyzed}/${dependencyStats.cacheHits} cache, hata ${classStats.failures + endpointStats.failures + dependencyStats.failures}.`
      );
    }
  );
}

export async function generateEnrichedRepoMapCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }
  const target = await new EnrichedRepoMapBuilder().build(lastAnalysis.aiDocsPath);
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage("Bank Spring Docs: Zenginleştirilmiş repo haritası oluşturuldu.");
}
