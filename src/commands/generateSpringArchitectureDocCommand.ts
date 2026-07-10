import * as vscode from "vscode";
import { generateLocalDocCommand } from "./generateLocalDocCommand";

export async function generateSpringArchitectureDocCommand(context: vscode.ExtensionContext): Promise<void> {
  await generateLocalDocCommand(context, "spring-architecture");
}
