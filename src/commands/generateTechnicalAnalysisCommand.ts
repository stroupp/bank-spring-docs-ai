import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateTechnicalAnalysisCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "technical-analysis");
}
