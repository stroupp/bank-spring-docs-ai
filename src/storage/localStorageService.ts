import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export class LocalStorageService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getCloneRoot(): string {
    const configuredWorkspace = vscode.workspace.getConfiguration("bankSpringDocs").get<string>("workspaceFolder", "").trim();
    if (configuredWorkspace) {
      return resolveWorkspacePath(configuredWorkspace);
    }
    return path.join(this.context.globalStorageUri.fsPath, "repositories");
  }

  async ensureAiDocs(repoRoot: string): Promise<string> {
    const cacheFolder = vscode.workspace.getConfiguration("bankSpringDocs").get<string>("cacheFolder", ".ai-docs");
    const aiDocsPath = path.join(repoRoot, cacheFolder);
    await fs.mkdir(path.join(aiDocsPath, "summaries", "files"), { recursive: true });
    await fs.mkdir(path.join(aiDocsPath, "summaries", "modules"), { recursive: true });
    await fs.mkdir(path.join(aiDocsPath, "context-packs"), { recursive: true });
    await fs.mkdir(path.join(aiDocsPath, "generated-docs"), { recursive: true });
    return aiDocsPath;
  }
}

function resolveWorkspacePath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    return path.resolve(workspaceFolder, value);
  }

  return path.resolve(value);
}
