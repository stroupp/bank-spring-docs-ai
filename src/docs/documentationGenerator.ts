import * as vscode from "vscode";
import { buildDocumentationPrompt } from "../ai/prompts";
import { RealCopilotClient } from "../ai/copilotClient";
import { IDocumentationModelClient } from "../ai/documentationModelClient";
import { maskSecrets } from "../ai/safeContextFilter";
import { ContextPackBuilder } from "../analyzer/contextPackBuilder";
import { MarkdownWriter } from "./markdownWriter";

export class DocumentationGenerator {
  constructor(
    private readonly contextPackBuilder = new ContextPackBuilder(),
    private readonly markdownWriter = new MarkdownWriter(),
    private readonly client: IDocumentationModelClient = new RealCopilotClient()
  ) {}

  async generate(aiDocsPath: string, fileName: string, title: string, repository: string, branch: string, token: vscode.CancellationToken): Promise<string> {
    const contextPack = maskSecrets(await this.contextPackBuilder.buildFromRepoMap(aiDocsPath));
    const prompt = buildDocumentationPrompt(title, contextPack);
    const response = await this.client.send(prompt, token);
    if (!response.text.trim()) {
      throw new Error(`${response.provider ?? this.client.provider ?? "AI"} boş doküman yanıtı döndürdü.`);
    }
    return this.markdownWriter.write(
      aiDocsPath,
      fileName,
      title,
      repository,
      branch,
      response.text,
      "generated-docs",
      modelAttribution(response.provider ?? this.client.provider ?? "copilot", response.model.name)
    );
  }
}

function modelAttribution(provider: IDocumentationModelClient["provider"], modelName: string): string {
  return provider === "qwen"
    ? `Bank Spring Docs AI via configured Qwen endpoint (${modelName})`
    : `Bank Spring Docs AI via GitHub Copilot Language Model API (${modelName})`;
}
