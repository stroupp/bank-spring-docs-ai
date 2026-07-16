import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { ContextPackBuilder } from "../analyzer/contextPackBuilder";
import { buildCopilotDocumentationRequest } from "../ai/prompts";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { RealCopilotClient } from "../ai/copilotClient";
import {
  DocumentationModelInfo,
  DocumentationModelProvider,
  DocumentationModelUsage,
  IDocumentationModelClient
} from "../ai/documentationModelClient";
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
    private readonly markdownWriter = new MarkdownWriter(),
    private readonly client: IDocumentationModelClient = new RealCopilotClient()
  ) {}

  async generate(
    aiDocsPath: string,
    repositoryName: string,
    branch: string,
    kind: LocalDocumentKind,
    token: vscode.CancellationToken,
    onProgress?: (message: string, usage: DocumentationModelUsage) => void
  ): Promise<string> {
    const meta = documentMeta[kind];
    const rawContext = await this.contextPackBuilder.buildForDocumentWithMetadata(aiDocsPath, kind);
    const safe = maskSecretsWithStats(rawContext.content);
    const contextPackPath = await this.writeContextPack(aiDocsPath, kind, safe.text);
    const contextSelectionPath = await this.writeContextSelectionAudit(aiDocsPath, kind, rawContext.contextSelection, safe.text.length);
    const shouldContinue = await this.confirmContextPreview(aiDocsPath, kind, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, contextPackPath);
    if (!shouldContinue) {
      await this.audit(aiDocsPath, kind, repositoryName, branch, contextPackPath, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, "cancelled", undefined, undefined, undefined, undefined, false, false, undefined, undefined, undefined, undefined, contextSelectionPath);
      throw new Error(`${providerDisplayName(this.client.provider)} isteği kullanıcı tarafından iptal edildi.`);
    }

    const prompt = buildCopilotDocumentationRequest(meta.title, safe.text);
    const promptPackPath = await this.writePromptPack(aiDocsPath, kind, prompt.combinedText);
    const startedAt = Date.now();
    let responseReceived = false;
    try {
      onProgress?.(`${providerDisplayName(this.client.provider)} isteği başladı (${prompt.profile})`, estimateUsage(prompt.combinedText.length, 0));
      const response = await this.client.send(prompt, token, (usage) => {
        onProgress?.(formatUsageProgress(kind, usage), usage);
      });
      responseReceived = true;
      if (!response.text.trim()) {
        throw new Error(`${providerDisplayName(response.provider ?? this.client.provider ?? "copilot")} boş doküman yanıtı döndürdü.`);
      }
      const output = await this.markdownWriter.write(
        aiDocsPath,
        meta.fileName,
        meta.title,
        repositoryName,
        branch,
        response.text,
        "copiloted-generated-docs",
        modelAttribution(response.provider ?? this.client.provider ?? "copilot", response.model.name)
      );
      await this.audit(aiDocsPath, kind, repositoryName, branch, contextPackPath, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, "success", undefined, response.usage, response.model, startedAt, true, true, prompt.profile, prompt.instructions.length, prompt.userPrompt.length, promptPackPath, contextSelectionPath, resolveProvider(response.provider, this.client.provider), response.finishReason, response.requestId);
      return output;
    } catch (error) {
      try {
        await this.audit(aiDocsPath, kind, repositoryName, branch, contextPackPath, safe.text.length, rawContext.includedIndexes, safe.maskedSecrets, token.isCancellationRequested ? "cancelled" : "failed", error instanceof Error ? error.message : String(error), undefined, undefined, startedAt, true, responseReceived, prompt.profile, prompt.instructions.length, prompt.userPrompt.length, promptPackPath, contextSelectionPath);
      } catch {
        // Preserve the original generation failure if best-effort auditing fails.
      }
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
    const providerName = providerDisplayName(this.client.provider);
    const sendAction = `${providerName}'a Gönder`;
    const answer = await vscode.window.showInformationMessage(
      `${providerName} context hazır: ${kind}, ${characters} karakter, ${includedIndexes.length} indeks, maskelenen gizli değer: ${maskedSecrets}. Dosya: ${relativePath}`,
      { modal: true },
      sendAction,
      "Context'i Aç",
      "İptal"
    );
    if (answer === "Context'i Aç") {
      const document = await vscode.workspace.openTextDocument(contextPackPath);
      await vscode.window.showTextDocument(document, { preview: false });
      const secondAnswer = await vscode.window.showInformationMessage(`Context incelendi. ${providerName}'a gönderilsin mi?`, { modal: true }, sendAction, "İptal");
      return secondAnswer === sendAction;
    }
    return answer === sendAction;
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
    usage?: DocumentationModelUsage,
    model?: DocumentationModelInfo,
    startedAt?: number,
    copilotRequestStarted = false,
    copilotResponseReceived = false,
    promptProfile?: string,
    instructionCharacters?: number,
    userPromptCharacters?: number,
    promptPackPath?: string,
    contextSelectionPath?: string,
    provider: DocumentationModelProvider = resolveProvider(undefined, this.client.provider),
    finishReason?: string,
    requestId?: string
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
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens: usage?.totalTokens,
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
      provider,
      finishReason,
      requestId,
      modelFamily: provider,
      status,
      error
    });
  }
}

function estimateUsage(inputCharacters: number, outputCharacters: number): DocumentationModelUsage {
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

function formatUsageProgress(kind: LocalDocumentKind, usage: DocumentationModelUsage): string {
  return `${kind}: ~${usage.estimatedInputTokens} input, ~${usage.estimatedOutputTokens} output, toplam ~${usage.estimatedTotalTokens} token`;
}

function providerDisplayName(provider: DocumentationModelProvider): string {
  return provider === "qwen" ? "Qwen" : "Copilot";
}

function resolveProvider(
  responseProvider?: DocumentationModelProvider,
  clientProvider?: DocumentationModelProvider
): DocumentationModelProvider {
  return responseProvider ?? clientProvider ?? "copilot";
}

function modelAttribution(provider: DocumentationModelProvider, modelName: string): string {
  return provider === "qwen"
    ? `Bank Spring Docs AI via configured Qwen endpoint (${modelName})`
    : `Bank Spring Docs AI via GitHub Copilot Language Model API (${modelName})`;
}
