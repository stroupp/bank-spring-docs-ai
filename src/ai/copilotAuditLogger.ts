import * as fs from "fs/promises";
import * as path from "path";

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
  outputCharacters?: number;
  durationMs?: number;
  copilotRequestStarted?: boolean;
  copilotResponseReceived?: boolean;
  selectedModelId?: string;
  selectedModelName?: string;
  selectedModelVendor?: string;
  selectedModelFamily?: string;
  selectedModelVersion?: string;
  selectedModelMaxInputTokens?: number;
  modelFamily: "copilot";
  status: "success" | "cancelled" | "failed";
  error?: string;
}

export class CopilotAuditLogger {
  async write(aiDocsPath: string, entry: CopilotAuditEntry): Promise<string> {
    const target = path.join(aiDocsPath, "audit", "copilot-requests.jsonl");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
    return target;
  }
}
