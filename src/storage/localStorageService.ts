import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ensureWithin, ensureWithinOrEqual } from "../utils/pathUtils";

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
    const configured = vscode.workspace.getConfiguration("bankSpringDocs").get<string>("cacheFolder", ".ai-docs");
    const aiDocsPath = resolveContainedCachePath(repoRoot, configured);
    await assertPathContainedForWrite(repoRoot, aiDocsPath);
    await fs.mkdir(path.join(aiDocsPath, "summaries", "files"), { recursive: true });
    await fs.mkdir(path.join(aiDocsPath, "summaries", "modules"), { recursive: true });
    await fs.mkdir(path.join(aiDocsPath, "context-packs"), { recursive: true });
    await fs.mkdir(path.join(aiDocsPath, "generated-docs"), { recursive: true });
    await assertCanonicalPathContained(repoRoot, aiDocsPath);
    return aiDocsPath;
  }
}

export function resolveContainedCachePath(repoRoot: string, configuredValue: string): string {
  const value = configuredValue.trim() || ".ai-docs";
  const segments = value.split(/[\\/]+/);
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("bankSpringDocs.cacheFolder must be a relative child folder without '.' or '..' path segments.");
  }
  const target = path.resolve(repoRoot, value);
  if (!ensureWithin(repoRoot, target)) {
    throw new Error("bankSpringDocs.cacheFolder must resolve inside the repository root.");
  }
  return target;
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

export async function assertPathContainedForWrite(parentRoot: string, target: string): Promise<void> {
  if (!ensureWithin(parentRoot, target)) {
    throw new Error("The target path must be a child of the configured storage root.");
  }
  await assertExistingPathContained(parentRoot, target);
}

async function assertExistingPathContained(repoRoot: string, target: string): Promise<void> {
  const rootReal = await fs.realpath(repoRoot);
  let candidate = target;
  while (true) {
    try {
      const candidateReal = await fs.realpath(candidate);
      if (!ensureWithinOrEqual(rootReal, candidateReal)) {
        throw new Error("The target path resolves through a link outside the configured storage root.");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

async function assertCanonicalPathContained(repoRoot: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([fs.realpath(repoRoot), fs.realpath(target)]);
  if (!ensureWithin(rootReal, targetReal)) {
    throw new Error("The target path is not contained in the configured storage root.");
  }
}
