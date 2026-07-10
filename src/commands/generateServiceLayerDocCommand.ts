import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateServiceLayerDocCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "service-layer");
}
