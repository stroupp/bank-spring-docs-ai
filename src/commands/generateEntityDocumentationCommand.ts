import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateEntityDocumentationCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "entities");
}
