import * as vscode from "vscode";

export function getDefaultBranch(): string {
  return vscode.workspace.getConfiguration("bankSpringDocs").get<string>("defaultBranch", "release/liv");
}

export function resolveBranch(input: string | undefined, defaultBranch = getDefaultBranch()): string {
  const branch = input?.trim();
  return branch ? branch : defaultBranch;
}
