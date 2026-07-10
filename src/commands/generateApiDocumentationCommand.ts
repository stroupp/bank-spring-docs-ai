import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateApiDocumentationCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "api-endpoints");
}
