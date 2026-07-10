import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateConfigurationDocumentationCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "configuration");
}
