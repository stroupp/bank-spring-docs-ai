import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateExternalIntegrationsDocCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "external-integrations");
}
