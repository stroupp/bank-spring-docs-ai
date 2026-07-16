import * as vscode from "vscode";
import { createDocumentationModelClient } from "../ai/documentationModelClientFactory";
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
      title: "Bank Spring Docs: AI dokümanı oluşturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      try {
        const modelClient = createDocumentationModelClient(context);
        const providerName = modelClient.provider === "qwen" ? "Qwen" : "Copilot";
        const generatedPath = await new CopilotDocumentationGenerator(undefined, undefined, modelClient).generate(
          lastAnalysis.aiDocsPath,
          lastAnalysis.repositoryName,
          lastAnalysis.branch,
          kind,
          token,
          (message) => progress.report({ message })
        );
        const document = await vscode.workspace.openTextDocument(generatedPath);
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Bank Spring Docs: ${providerName} dokümanı oluşturuldu: ${generatedPath}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Bank Spring Docs: AI dokümanı oluşturulamadı. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
