import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateTestAnalysisCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "test-analysis");
}
