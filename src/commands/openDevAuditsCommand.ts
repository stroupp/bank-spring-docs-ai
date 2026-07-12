import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export async function openDevAuditsCommand(context: vscode.ExtensionContext): Promise<void> {
  const candidates = [
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => path.join(folder.uri.fsPath, ".ai-docs", "dev-audits")),
    path.join(context.extensionPath, ".ai-docs", "dev-audits")
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(candidate));
      return;
    }
  }
  vscode.window.showWarningMessage("Bank Spring Docs: Geliştirici denetim raporları bulunamadı. Önce proje audit adımlarını çalıştır.");
}

async function exists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
