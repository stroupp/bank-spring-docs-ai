import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { ContextPackBuilder } from "../analyzer/contextPackBuilder";
import { buildCopilotDocumentationRequest } from "../ai/prompts";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { askCopilotWithUsage, CopilotModelInfo, CopilotUsageEstimate } from "../ai/copilotClient";
import { LocalDocumentKind } from "./localDocumentationGenerator";
import { MarkdownWriter } from "./markdownWriter";
import { CopilotAuditLogger } from "../ai/copilotAuditLogger";

const documentMeta: Record<LocalDocumentKind, { fileName: string; title: string }> = {
  "repository-overview": { fileName: "copilot-repository-overview.md", title: "Repository Overview" },
  "spring-architecture": { fileName: "copilot-spring-architecture.md", title: "Spring Architecture" },
  "api-endpoints": { fileName: "copilot-api-endpoints.md", title: "API Endpoints" },
  "service-layer": { fileName: "copilot-service-layer.md", title: "Service Layer" },
  "repository-layer": { fileName: "copilot-repository-layer.md", title: "Repository Layer" },
  entities: { fileName: "copilot-database-entities.md", title: "Database Entities" },
  configuration: { fileName: "copilot-configuration.md", title: "Configuration" },
  "external-integrations": { fileName: "copilot-external-integrations.md", title: "External Integrations" },
  "test-analysis": { fileName: "copilot-test-analysis.md", title: "Test Analysis" },
  "technical-analysis": { fileName: "copilot-technical-analysis.md", title: "Technical Analysis" }
};

export class CopilotDocumentationGenerator {
  constructor(
    private readonly contextPackBuilder = new ContextPackBuilder(),
    private readonly markdownWriter = new MarkdownWriter()
  ) {}

  async generate(
    aiDocsPath: string,
    repositoryName: string,
    branch: string,
    kind: LocalDocumentKind,
    token: vscode.CancellationToken,
    onProgress?: (message: string, usage: CopilotUsageEstimate) => void
  ): Promise<string> {
    const meta = documentMeta[kind];
    const rawContext = await this.contextPackBuilder.buildForDocumentWithMetadata(aiDocsPath, kind);
    const safe = maskSecretsWithStats(rawContext.content);
    const contextPackPath = await this.writeContextPack(aiDocsPath, kind, safe.text);
    const contextSelectionPath = await this.writeContextSelectionAudit(aiDocsPath, kind, rawContext.contextSelection, safe.text.length);
    const shouldContinue = await this.confirmContextPreview(aiDocsPath, kind, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, contextPackPath);
    if (!shouldContinue) {
      await this.audit(aiDocsPath, kind, repositoryName, branch, contextPackPath, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, "cancelled", undefined, undefined, undefined, undefined, false, false, undefined, undefined, undefined, undefined, contextSelectionPath);
      throw new Error("Copilot isteği kullanıcı tarafından iptal edildi.");
    }

    const prompt = buildCopilotDocumentationRequest(meta.title, safe.text);
    const promptPackPath = await this.writePromptPack(aiDocsPath, kind, prompt.combinedText);
    const startedAt = Date.now();
    try {
      onProgress?.(`Copilot isteği başladı (${prompt.profile})`, estimateUsage(prompt.combinedText.length, 0));
      const response = await askCopilotWithUsage(prompt, token, (usage) => {
        onProgress?.(formatUsageProgress(kind, usage), usage);
      });
      const output = await this.markdownWriter.write(
        aiDocsPath,
        meta.fileName,
        meta.title,
        repositoryName,
        branch,
        response.text,
        "copiloted-generated-docs",
        "Bank Spring Docs AI via GitHub Copilot Language Model API"
      );
      await this.audit(aiDocsPath, kind, repositoryName, branch, contextPackPath, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, "success", undefined, response.usage, response.model, startedAt, true, true, prompt.profile, prompt.instructions.length, prompt.userPrompt.length, promptPackPath, contextSelectionPath);
      return output;
    } catch (error) {
      await this.audit(aiDocsPath, kind, repositoryName, branch, contextPackPath, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, "failed", error instanceof Error ? error.message : String(error), undefined, undefined, startedAt, true, false, prompt.profile, prompt.instructions.length, prompt.userPrompt.length, promptPackPath, contextSelectionPath);
      throw error;
    }
  }

  private async writeContextPack(aiDocsPath: string, kind: LocalDocumentKind, context: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dir = path.join(aiDocsPath, "context-packs");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${kind}-${timestamp}.md`);
    const last = path.join(dir, "last-copilot-context.md");
    await fs.writeFile(target, context, "utf8");
    await fs.writeFile(last, context, "utf8");
    return target;
  }

  private async writePromptPack(aiDocsPath: string, kind: LocalDocumentKind, prompt: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dir = path.join(aiDocsPath, "context-packs");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${kind}-copilot-prompt-${timestamp}.md`);
    const last = path.join(dir, "last-copilot-prompt.md");
    await fs.writeFile(target, prompt, "utf8");
    await fs.writeFile(last, prompt, "utf8");
    return target;
  }

  private async writeContextSelectionAudit(aiDocsPath: string, kind: LocalDocumentKind, contextSelection: unknown, safeCharacters: number): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dir = path.join(aiDocsPath, "audit", "context-selection");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${kind}-${timestamp}.json`);
    await fs.writeFile(target, JSON.stringify({
      generatedAt: new Date().toISOString(),
      docType: kind,
      safeCharacters,
      contextSelection
    }, null, 2), "utf8");
    return target;
  }

  private async confirmContextPreview(aiDocsPath: string, kind: LocalDocumentKind, characters: number, includedIndexes: string[], maskedSecrets: number, contextPackPath: string): Promise<boolean> {
    const previewEnabled = vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("copilot.contextPreviewEnabled", true);
    if (!previewEnabled) {
      return true;
    }
    const relativePath = path.relative(aiDocsPath, contextPackPath);
    const answer = await vscode.window.showInformationMessage(
      `Copilot context hazır: ${kind}, ${characters} karakter, ${includedIndexes.length} indeks, maskelenen gizli değer: ${maskedSecrets}. Dosya: ${relativePath}`,
      { modal: true },
      "Copilot'a Gönder",
      "Context'i Aç",
      "İptal"
    );
    if (answer === "Context'i Aç") {
      const document = await vscode.workspace.openTextDocument(contextPackPath);
      await vscode.window.showTextDocument(document, { preview: false });
      const secondAnswer = await vscode.window.showInformationMessage("Context incelendi. Copilot'a gönderilsin mi?", { modal: true }, "Copilot'a Gönder", "İptal");
      return secondAnswer === "Copilot'a Gönder";
    }
    return answer === "Copilot'a Gönder";
  }

  private async audit(
    aiDocsPath: string,
    kind: LocalDocumentKind,
    repositoryName: string,
    branch: string,
    contextPackPath: string,
    charactersSent: number,
    includedIndexes: string[],
    maskedSecrets: number,
    status: "success" | "cancelled" | "failed",
    error?: string,
    usage?: CopilotUsageEstimate,
    model?: CopilotModelInfo,
    startedAt?: number,
    copilotRequestStarted = false,
    copilotResponseReceived = false,
    promptProfile?: string,
    instructionCharacters?: number,
    userPromptCharacters?: number,
    promptPackPath?: string,
    contextSelectionPath?: string
  ): Promise<void> {
    const enabled = vscode.workspace.getConfiguration("bankSpringDocs").get<boolean>("copilot.auditLogEnabled", true);
    if (!enabled) {
      return;
    }
    await new CopilotAuditLogger().write(aiDocsPath, {
      timestamp: new Date().toISOString(),
      docType: kind,
      repositoryName,
      branch,
      contextPackPath: path.relative(aiDocsPath, contextPackPath),
      promptPackPath: promptPackPath ? path.relative(aiDocsPath, promptPackPath) : undefined,
      contextSelectionPath: contextSelectionPath ? path.relative(aiDocsPath, contextSelectionPath) : undefined,
      charactersSent,
      includedIndexes,
      maskedSecrets,
      promptProfile,
      instructionCharacters,
      userPromptCharacters,
      estimatedInputTokens: usage?.estimatedInputTokens,
      estimatedOutputTokens: usage?.estimatedOutputTokens,
      estimatedTotalTokens: usage?.estimatedTotalTokens,
      modelCountedInputTokens: usage?.modelCountedInputTokens,
      outputCharacters: usage?.outputCharacters,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
      copilotRequestStarted,
      copilotResponseReceived,
      selectedModelId: model?.id,
      selectedModelName: model?.name,
      selectedModelVendor: model?.vendor,
      selectedModelFamily: model?.family,
      selectedModelVersion: model?.version,
      selectedModelMaxInputTokens: model?.maxInputTokens,
      modelFamily: "copilot",
      status,
      error
    });
  }
}

function estimateUsage(inputCharacters: number, outputCharacters: number): CopilotUsageEstimate {
  const estimatedInputTokens = Math.ceil(inputCharacters / 4);
  const estimatedOutputTokens = Math.ceil(outputCharacters / 4);
  return {
    inputCharacters,
    outputCharacters,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens
  };
}

function formatUsageProgress(kind: LocalDocumentKind, usage: CopilotUsageEstimate): string {
  return `${kind}: ~${usage.estimatedInputTokens} input, ~${usage.estimatedOutputTokens} output, toplam ~${usage.estimatedTotalTokens} token`;
}
