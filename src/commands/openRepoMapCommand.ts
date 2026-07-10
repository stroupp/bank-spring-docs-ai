import * as path from "path";
import * as vscode from "vscode";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function openRepoMapCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Açılacak repo haritası yok. Önce analiz çalıştır.");
    return;
  }

  const document = await vscode.workspace.openTextDocument(path.join(lastAnalysis.aiDocsPath, "repo-map.md"));
  await vscode.window.showTextDocument(document, { preview: false });
}
