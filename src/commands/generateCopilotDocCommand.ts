import * as vscode from "vscode";
import { CopilotDocumentationGenerator } from "../docs/copilotDocumentationGenerator";
import { LocalDocumentKind } from "../docs/localDocumentationGenerator";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function generateCopilotDocCommand(context: vscode.ExtensionContext, kind: LocalDocumentKind): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Copilot dokümanı oluşturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      try {
        const generatedPath = await new CopilotDocumentationGenerator().generate(
          lastAnalysis.aiDocsPath,
          lastAnalysis.repositoryName,
          lastAnalysis.branch,
          kind,
          token,
          (message) => progress.report({ message })
        );
        const document = await vscode.workspace.openTextDocument(generatedPath);
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Bank Spring Docs: Copilot dokümanı oluşturuldu: ${generatedPath}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Bank Spring Docs: Copilot dokümanı oluşturulamadı. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
