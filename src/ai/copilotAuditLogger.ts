import * as fs from "fs/promises";
import * as path from "path";
import { DocumentationModelProvider } from "./documentationModelClient";
import { maskSecretsWithStats } from "./safeContextFilter";

export interface CopilotAuditEntry {
  timestamp: string;
  runId?: string;
  attempt?: number;
  docType: string;
  repositoryName: string;
  branch: string;
  contextPackPath: string;
  promptPackPath?: string;
  contextSelectionPath?: string;
  charactersSent: number;
  includedIndexes: string[];
  skippedIndexes?: string[];
  maskedSecrets: number;
  promptProfile?: string;
  instructionCharacters?: number;
  userPromptCharacters?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedTotalTokens?: number;
  modelCountedInputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  outputCharacters?: number;
  durationMs?: number;
  requestStarted?: boolean;
  responseReceived?: boolean;
  /** Legacy names retained for existing audit consumers. */
  copilotRequestStarted?: boolean;
  copilotResponseReceived?: boolean;
  selectedModelId?: string;
  selectedModelName?: string;
  selectedModelVendor?: string;
  selectedModelFamily?: string;
  selectedModelVersion?: string;
  selectedModelMaxInputTokens?: number;
  /** Selected documentation provider. The legacy audit filename is retained for compatibility. */
  provider?: DocumentationModelProvider;
  finishReason?: string;
  requestId?: string;
  modelFamily: DocumentationModelProvider;
  status: "success" | "cancelled" | "failed";
  error?: string;
}

export class CopilotAuditLogger {
  async write(aiDocsPath: string, entry: CopilotAuditEntry): Promise<string> {
    const target = path.join(aiDocsPath, "audit", "copilot-requests.jsonl");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const normalized: CopilotAuditEntry = {
      ...entry,
      error: entry.error ? maskSecretsWithStats(entry.error).text.slice(0, 4000) : undefined,
      requestStarted: entry.requestStarted ?? entry.copilotRequestStarted,
      responseReceived: entry.responseReceived ?? entry.copilotResponseReceived
    };
    await fs.appendFile(target, `${JSON.stringify(normalized)}\n`, "utf8");
    return target;
  }
}
