import * as fs from "fs/promises";
import * as vscode from "vscode";
import { AnalysisStateService } from "../storage/analysisStateService";

export async function clearLocalCacheCommand(context: vscode.ExtensionContext): Promise<void> {
  const answer = await vscode.window.showWarningMessage("Clear Bank Spring Docs local clone/index cache?", { modal: true }, "Clear Cache");
  if (answer !== "Clear Cache") {
    return;
  }
  await fs.rm(context.globalStorageUri.fsPath, { recursive: true, force: true });
  await new AnalysisStateService(context).clearLastAnalysis();
  vscode.window.showInformationMessage("Bank Spring Docs: Local cache cleared.");
}
