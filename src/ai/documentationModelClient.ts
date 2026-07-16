import * as vscode from "vscode";

export type DocumentationModelProvider = "copilot" | "qwen";

export interface DocumentationModelUsage {
  inputCharacters: number;
  outputCharacters: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  /** Provider-reported input token count when one is available. */
  modelCountedInputTokens?: number;
  /** OpenAI-compatible usage fields returned by providers such as Qwen. */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface DocumentationModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
}

export interface DocumentationModelRequest {
  instructions?: string;
  userPrompt: string;
  /** Exact text used by context artifacts and usage estimates. */
  combinedText?: string;
  /** Optional pipeline phase identifier used for provider-specific sampling profiles. */
  profile?: string;
  /** Optional per-request output budget. Qwen caps it at the configured generation maximum. */
  maxOutputTokens?: number;
}

export interface DocumentationModelResponse {
  text: string;
  usage: DocumentationModelUsage;
  model: DocumentationModelInfo;
  provider: DocumentationModelProvider;
  finishReason?: string;
  requestId?: string;
}

export type DocumentationModelProgressHandler = (usage: DocumentationModelUsage) => void;

/** Provider-neutral boundary used by documentation generation pipelines. */
export interface IDocumentationModelClient {
  readonly provider: DocumentationModelProvider;

  send(
    prompt: string | DocumentationModelRequest,
    token: vscode.CancellationToken,
    onProgress?: DocumentationModelProgressHandler
  ): Promise<DocumentationModelResponse>;
}
