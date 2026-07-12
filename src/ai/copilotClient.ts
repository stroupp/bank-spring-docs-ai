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

/** Boundary around the VS Code Language Model API. */
export interface ICopilotClient {
  send(
    prompt: string | CopilotChatRequest,
    token: vscode.CancellationToken,
    onProgress?: CopilotProgressHandler
  ): Promise<CopilotResponseWithUsage>;
}

/** Production adapter. Automated tests inject ICopilotClient and never load vscode.lm. */
export class RealCopilotClient implements ICopilotClient {
  private pinnedModelPromise: Promise<vscode.LanguageModelChat> | undefined;

  async send(
    prompt: string | CopilotChatRequest,
    token: vscode.CancellationToken,
    onProgress?: CopilotProgressHandler
  ): Promise<CopilotResponseWithUsage> {
    return sendWithVsCodeLanguageModel(prompt, token, onProgress, await this.getPinnedModel());
  }

  private getPinnedModel(): Promise<vscode.LanguageModelChat> {
    if (!this.pinnedModelPromise) {
      this.pinnedModelPromise = selectStandardCopilotModel().catch((error) => {
        this.pinnedModelPromise = undefined;
        throw error;
      });
    }
    return this.pinnedModelPromise;
  }
}

export async function askCopilot(prompt: string, token: vscode.CancellationToken): Promise<string> {
  return (await askCopilotWithUsage(prompt, token)).text;
}

export async function askCopilotWithUsage(prompt: string | CopilotChatRequest, token: vscode.CancellationToken, onProgress?: CopilotProgressHandler): Promise<CopilotResponseWithUsage> {
  return new RealCopilotClient().send(prompt, token, onProgress);
}

async function selectStandardCopilotModel(): Promise<vscode.LanguageModelChat> {
  const selectedModelId = vscode.workspace.getConfiguration("bankSpringDocs").get<string>("copilot.modelId", "").trim();
  const selector: vscode.LanguageModelChatSelector = selectedModelId
    ? { vendor: "copilot", id: selectedModelId }
    : { vendor: "copilot" };

  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels(selector);
  } catch (error) {
    throw new Error(`Copilot model selection failed. Make sure GitHub Copilot is enabled and signed in. ${formatError(error)}`);
  }

  // Filter again defensively because multiple providers can expose the same model ID.
  // In particular, the Copilot CLI provider uses vendor `copilotcli` and must not be
  // substituted for the standard VS Code Copilot Language Model provider.
  const standardModels = models.filter((model) =>
    model.vendor === "copilot" && (!selectedModelId || model.id === selectedModelId)
  );

  if (selectedModelId && !standardModels.length) {
    throw new Error(
      `Configured Copilot model '${selectedModelId}' is not available from the standard 'copilot' provider. ` +
      "Open the Bank Spring Docs panel and select an available GitHub Copilot model."
    );
  }

  if (!standardModels.length) {
    throw new Error("No model is available from the standard 'copilot' provider. Make sure GitHub Copilot is enabled and signed in to VS Code.");
  }

  return standardModels[0];
}

async function sendWithVsCodeLanguageModel(
  prompt: string | CopilotChatRequest,
  token: vscode.CancellationToken,
  onProgress: CopilotProgressHandler | undefined,
  model: vscode.LanguageModelChat
): Promise<CopilotResponseWithUsage> {
  try {
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

async function tryCountTokens(model: vscode.LanguageModelChat, prompt: string, token: vscode.CancellationToken): Promise<number | undefined> {
  try {
    return await model.countTokens(prompt, token);
  } catch {
    return undefined;
  }
}
