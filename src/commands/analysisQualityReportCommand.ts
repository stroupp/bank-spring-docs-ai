import * as vscode from "vscode";
import { AnalysisQualityReportGenerator } from "../analyzer/analysisQualityReportGenerator";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function generateAnalysisQualityReportCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Analiz kalite raporu oluşturuluyor",
      cancellable: false
    },
    async () => {
      const result = await new AnalysisQualityReportGenerator().generate(lastAnalysis.aiDocsPath);
      const document = await vscode.workspace.openTextDocument(result.markdownPath);
      await vscode.window.showTextDocument(document, { preview: false });
      vscode.window.showInformationMessage("Bank Spring Docs: Analiz kalite raporu oluşturuldu.");
    }
  );
}
