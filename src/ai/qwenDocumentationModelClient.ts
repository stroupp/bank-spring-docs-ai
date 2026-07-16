import * as vscode from "vscode";
import {
  DocumentationModelProgressHandler,
  DocumentationModelRequest,
  DocumentationModelResponse,
  DocumentationModelUsage,
  IDocumentationModelClient
} from "./documentationModelClient";
import { assertBankingQwenEndpoint, QwenChatMessage, QwenClient } from "./qwenClient";
import { BANKING_QWEN_MODEL_ALIAS, QwenSettings, QwenSettingsService } from "./qwenSettingsService";

const defaultGenerationTimeoutSeconds = 600;
const defaultGenerationMaxTokens = 16384;
const defaultContextWindowTokens = 131072;

/** OpenAI-compatible Qwen adapter used by full document generation pipelines. */
export class QwenDocumentationModelClient implements IDocumentationModelClient {
  readonly provider = "qwen" as const;
  private readonly settings: QwenSettings;
  private readonly client: QwenClient;
  private readonly timeoutSeconds: number;
  private readonly maxOutputTokens: number;
  private readonly contextWindowTokens: number;
  private readonly modelFamily: "qwen" | "qwen3";

  constructor(
    settingsService: QwenSettingsService,
    client?: QwenClient
  ) {
    this.settings = { ...settingsService.getSettings() };
    this.client = client ?? new QwenClient({
      getSettings: () => ({ ...this.settings }),
      getApiKey: () => settingsService.getApiKey()
    });
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    this.timeoutSeconds = positiveInteger(
      config.get<number>("qwen.generationTimeoutSeconds", defaultGenerationTimeoutSeconds),
      "bankSpringDocs.qwen.generationTimeoutSeconds"
    );
    this.maxOutputTokens = positiveInteger(
      config.get<number>("qwen.generationMaxTokens", defaultGenerationMaxTokens),
      "bankSpringDocs.qwen.generationMaxTokens"
    );
    this.contextWindowTokens = positiveInteger(
      config.get<number>("qwen.contextWindowTokens", defaultContextWindowTokens),
      "bankSpringDocs.qwen.contextWindowTokens"
    );
    this.modelFamily = isApprovedBankingQwen3Settings(this.settings) ? "qwen3" : "qwen";
  }

  async send(
    prompt: string | DocumentationModelRequest,
    token: vscode.CancellationToken,
    onProgress?: DocumentationModelProgressHandler
  ): Promise<DocumentationModelResponse> {
    const messages = buildMessages(prompt);
    const usageText = requestText(prompt);
    const estimatedInputTokens = estimateConservativeInputTokens(usageText.length);
    const requestMaxOutputTokens = resolveRequestMaxOutputTokens(prompt, this.maxOutputTokens);

    if (estimatedInputTokens + requestMaxOutputTokens > this.contextWindowTokens) {
      throw new Error(
        `Qwen bağlam bütçesi aşıldı: korumalı yaklaşık ${estimatedInputTokens} giriş + ${requestMaxOutputTokens} çıkış token, ` +
        `yapılandırılan pencere ${this.contextWindowTokens} token. Bağlamı veya generationMaxTokens ayarını küçültün.`
      );
    }

    const result = await this.client.complete(messages, {
      temperature: this.settings.temperature,
      maxTokens: requestMaxOutputTokens,
      timeoutSeconds: this.timeoutSeconds
    }, token);
    if (result.finishReason?.toLowerCase() === "length") {
      throw new Error(
        `Qwen doküman yanıtı ${requestMaxOutputTokens} token çıktı sınırında kesildi. ` +
        "İlgili Qwen aşamasının çıktı bütçesini artırın veya bağlamı küçültün."
      );
    }
    if (!result.content.trim()) {
      throw new Error("Qwen doküman üretimi boş yanıt döndürdü.");
    }

    const usage = buildUsage(usageText.length, result.content.length, result.usage);
    onProgress?.(usage);
    return {
      text: result.content,
      usage,
      model: {
        id: result.model || this.settings.model,
        name: result.model || this.settings.model,
        vendor: "qwen",
        family: this.modelFamily,
        version: result.model || this.settings.model,
        maxInputTokens: this.contextWindowTokens
      },
      provider: "qwen",
      finishReason: result.finishReason,
      requestId: result.requestId
    };
  }
}

function isApprovedBankingQwen3Settings(settings: QwenSettings): boolean {
  if (!settings.bankingEnvironment || settings.model.trim().toUpperCase() !== BANKING_QWEN_MODEL_ALIAS) {
    return false;
  }
  try {
    assertBankingQwenEndpoint(settings.endpoint);
    return true;
  } catch {
    return false;
  }
}

function buildMessages(prompt: string | DocumentationModelRequest): QwenChatMessage[] {
  if (typeof prompt === "string") {
    if (!prompt.trim()) {
      throw new Error("Qwen doküman promptu boş olamaz.");
    }
    return [{ role: "user", content: prompt }];
  }

  const messages: QwenChatMessage[] = [];
  if (prompt.instructions?.trim()) {
    messages.push({ role: "system", content: prompt.instructions.trim() });
  }
  if (!prompt.userPrompt.trim()) {
    throw new Error("Qwen doküman kullanıcı promptu boş olamaz.");
  }
  messages.push({ role: "user", content: prompt.userPrompt });
  return messages;
}

function requestText(prompt: string | DocumentationModelRequest): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt.combinedText ?? [prompt.instructions, prompt.userPrompt].filter(Boolean).join("\n\n");
}

function resolveRequestMaxOutputTokens(
  prompt: string | DocumentationModelRequest,
  configuredMaxOutputTokens: number
): number {
  if (typeof prompt === "string" || prompt.maxOutputTokens === undefined) {
    return configuredMaxOutputTokens;
  }
  return Math.min(
    positiveInteger(prompt.maxOutputTokens, "Qwen istek maxOutputTokens"),
    configuredMaxOutputTokens
  );
}

function buildUsage(
  inputCharacters: number,
  outputCharacters: number,
  providerUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
): DocumentationModelUsage {
  const estimatedInputTokens = providerUsage.promptTokens ?? estimateTokens(inputCharacters);
  const estimatedOutputTokens = providerUsage.completionTokens ?? estimateTokens(outputCharacters);
  const estimatedTotalTokens = providerUsage.totalTokens ?? estimatedInputTokens + estimatedOutputTokens;
  return {
    inputCharacters,
    outputCharacters,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    modelCountedInputTokens: providerUsage.promptTokens,
    promptTokens: providerUsage.promptTokens,
    completionTokens: providerUsage.completionTokens,
    totalTokens: providerUsage.totalTokens
  };
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function estimateConservativeInputTokens(characters: number): number {
  // Turkish prose and source code can tokenize more densely than the common
  // four-characters-per-token heuristic. Reserve chat-template overhead too.
  return Math.ceil(characters / 3) + 512;
}

function positiveInteger(value: number, settingName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${settingName} ayarı sıfırdan büyük geçerli bir sayı olmalıdır.`);
  }
  return Math.floor(value);
}
