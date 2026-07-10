import * as vscode from "vscode";
import { buildDocumentationPrompt } from "../ai/prompts";
import { askCopilot } from "../ai/copilotClient";
import { maskSecrets } from "../ai/safeContextFilter";
import { ContextPackBuilder } from "../analyzer/contextPackBuilder";
import { MarkdownWriter } from "./markdownWriter";

export class DocumentationGenerator {
  constructor(
    private readonly contextPackBuilder = new ContextPackBuilder(),
    private readonly markdownWriter = new MarkdownWriter()
  ) {}

  async generate(aiDocsPath: string, fileName: string, title: string, repository: string, branch: string, token: vscode.CancellationToken): Promise<string> {
    const contextPack = maskSecrets(await this.contextPackBuilder.buildFromRepoMap(aiDocsPath));
    const prompt = buildDocumentationPrompt(title, contextPack);
    const body = await askCopilot(prompt, token);
    return this.markdownWriter.write(aiDocsPath, fileName, title, repository, branch, body);
  }
}
