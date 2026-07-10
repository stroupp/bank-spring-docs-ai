import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateRepositoryLayerDocCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "repository-layer");
}
