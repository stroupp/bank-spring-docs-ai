import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateRepositoryOverviewCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "repository-overview");
}
