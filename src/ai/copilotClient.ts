import * as vscode from "vscode";

export interface CopilotUsageEstimate {
  inputCharacters: number;
  outputCharacters: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  modelCountedInputTokens?: number;
}

export interface CopilotResponseWithUsage {
  text: string;
  usage: CopilotUsageEstimate;
  model: CopilotModelInfo;
}

export interface CopilotModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
}

export type CopilotProgressHandler = (usage: CopilotUsageEstimate) => void;

export interface CopilotChatRequest {
  instructions?: string;
  userPrompt: string;
  combinedText?: string;
}

export async function askCopilot(prompt: string, token: vscode.CancellationToken): Promise<string> {
  return (await askCopilotWithUsage(prompt, token)).text;
}

export async function askCopilotWithUsage(prompt: string | CopilotChatRequest, token: vscode.CancellationToken, onProgress?: CopilotProgressHandler): Promise<CopilotResponseWithUsage> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels();
  } catch (error) {
    throw new Error(`Copilot model selection failed. Make sure GitHub Copilot is enabled and signed in. ${formatError(error)}`);
  }

  if (!models.length) {
    throw new Error("No language model is available. Make sure GitHub Copilot is enabled and signed in to VS Code.");
  }

  try {
    const model = selectPreferredModel(models);
    const modelInfo = modelInfoFrom(model);
    const messages = buildMessages(prompt);
    const usageText = typeof prompt === "string" ? prompt : prompt.combinedText ?? `${prompt.instructions ?? ""}\n\n${prompt.userPrompt}`;
    const modelCountedInputTokens = await tryCountTokens(model, usageText, token);
    const response = await model.sendRequest(messages, {}, token);
    let output = "";
    let lastProgressAt = 0;
    for await (const chunk of response.text) {
      output += chunk;
      const now = Date.now();
      if (onProgress && now - lastProgressAt > 350) {
        onProgress(buildUsage(usageText.length, output.length, modelCountedInputTokens));
        lastProgressAt = now;
      }
    }
    const usage = buildUsage(usageText.length, output.length, modelCountedInputTokens);
    onProgress?.(usage);
    return { text: output, usage, model: modelInfo };
  } catch (error) {
    if (token.isCancellationRequested) {
      throw new Error("Copilot request was cancelled.");
    }
    const detail = formatError(error);
    if (/token limit|exceeds token|context length|too many tokens/i.test(detail)) {
      throw new Error(`Copilot request failed because the context is larger than the selected model token limit. Reduce bankSpringDocs.copilot.maxContextCharacters. ${detail}`);
    }
    throw new Error(`Copilot request failed. Check Copilot quota, authentication, and network access. ${detail}`);
  }
}

function buildMessages(prompt: string | CopilotChatRequest): vscode.LanguageModelChatMessage[] {
  if (typeof prompt === "string") {
    return [vscode.LanguageModelChatMessage.User(prompt)];
  }

  const messages: vscode.LanguageModelChatMessage[] = [];
  if (prompt.instructions?.trim()) {
    messages.push(vscode.LanguageModelChatMessage.User(`INSTRUCTIONS\n${prompt.instructions.trim()}`, "bank-spring-docs-instructions"));
  }
  messages.push(vscode.LanguageModelChatMessage.User(prompt.userPrompt, "bank-spring-docs-context"));
  return messages;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildUsage(inputCharacters: number, outputCharacters: number, modelCountedInputTokens?: number): CopilotUsageEstimate {
  const estimatedInputTokens = estimateTokens(inputCharacters);
  const estimatedOutputTokens = estimateTokens(outputCharacters);
  return {
    inputCharacters,
    outputCharacters,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    modelCountedInputTokens
  };
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function modelInfoFrom(model: vscode.LanguageModelChat): CopilotModelInfo {
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens
  };
}

function selectPreferredModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat {
  const selectedModelId = vscode.workspace.getConfiguration("bankSpringDocs").get<string>("copilot.modelId", "").trim();
  if (selectedModelId) {
    const selected = models.find((model) => model.id === selectedModelId);
    if (selected) {
      return selected;
    }
  }
  return models[0];
}

async function tryCountTokens(model: vscode.LanguageModelChat, prompt: string, token: vscode.CancellationToken): Promise<number | undefined> {
  try {
    return await model.countTokens(prompt, token);
  } catch {
    return undefined;
  }
}
