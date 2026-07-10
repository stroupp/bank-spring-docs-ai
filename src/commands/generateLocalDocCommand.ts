import * as vscode from "vscode";
import { LocalDocumentKind, LocalDocumentationGenerator } from "../docs/localDocumentationGenerator";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function generateLocalDocCommand(context: vscode.ExtensionContext, kind: LocalDocumentKind): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Doküman oluşturuluyor",
      cancellable: false
    },
    async () => {
      const generatedPath = await new LocalDocumentationGenerator().generate(lastAnalysis.aiDocsPath, kind);
      const document = await vscode.workspace.openTextDocument(generatedPath);
      await vscode.window.showTextDocument(document, { preview: false });
      vscode.window.showInformationMessage(`Bank Spring Docs: Doküman oluşturuldu: ${generatedPath}`);
    }
  );
}
