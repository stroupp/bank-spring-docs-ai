import * as vscode from "vscode";

export async function indexCurrentRepositoryCommand(): Promise<void> {
  vscode.window.showInformationMessage("Bank Spring Docs: Index Current Repository is scaffolded for the next MVP step.");
}
