import * as path from "path";
import * as vscode from "vscode";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function openGeneratedDocsCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Açılacak çıktı klasörü yok. Önce analiz çalıştır.");
    return;
  }

  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(lastAnalysis.aiDocsPath));
}
