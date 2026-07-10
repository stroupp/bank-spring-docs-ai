import * as vscode from "vscode";

export const qwenApiKeySecretKey = "bankSpringDocs.qwen.apiKey";

export interface QwenSettings {
  enabled: boolean;
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  useApiKey: boolean;
}

export interface QwenSettingsUpdate extends QwenSettings {
  apiKey?: string;
  semanticCacheEnabled?: boolean;
  semanticMaxFilesPerRun?: number;
  semanticMaxCharactersPerFile?: number;
}

export class QwenSettingsService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSettings(): QwenSettings {
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    return {
      enabled: config.get<boolean>("qwen.enabled", false),
      endpoint: config.get<string>("qwen.endpoint", "http://localhost:8000/v1/chat/completions"),
      model: config.get<string>("qwen.model", "qwen3"),
      temperature: config.get<number>("qwen.temperature", 0.1),
      maxTokens: config.get<number>("qwen.maxTokens", 4096),
      timeoutSeconds: config.get<number>("qwen.timeoutSeconds", 120),
      useApiKey: config.get<boolean>("qwen.useApiKey", false)
    };
  }

  async saveSettings(update: QwenSettingsUpdate): Promise<void> {
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    await config.update("qwen.enabled", update.enabled, vscode.ConfigurationTarget.Global);
    await config.update("qwen.endpoint", update.endpoint, vscode.ConfigurationTarget.Global);
    await config.update("qwen.model", update.model, vscode.ConfigurationTarget.Global);
    await config.update("qwen.temperature", update.temperature, vscode.ConfigurationTarget.Global);
    await config.update("qwen.maxTokens", update.maxTokens, vscode.ConfigurationTarget.Global);
    await config.update("qwen.timeoutSeconds", update.timeoutSeconds, vscode.ConfigurationTarget.Global);
    await config.update("qwen.useApiKey", update.useApiKey, vscode.ConfigurationTarget.Global);
    if (update.semanticCacheEnabled !== undefined) {
      await config.update("semantic.cacheEnabled", update.semanticCacheEnabled, vscode.ConfigurationTarget.Global);
    }
    if (update.semanticMaxFilesPerRun !== undefined) {
      await config.update("semantic.maxFilesPerRun", update.semanticMaxFilesPerRun, vscode.ConfigurationTarget.Global);
    }
    if (update.semanticMaxCharactersPerFile !== undefined) {
      await config.update("semantic.maxCharactersPerFile", update.semanticMaxCharactersPerFile, vscode.ConfigurationTarget.Global);
    }

    if (update.apiKey !== undefined && update.apiKey.trim()) {
      const trimmed = update.apiKey.trim();
      await this.context.secrets.store(qwenApiKeySecretKey, trimmed);
    }
  }

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(qwenApiKeySecretKey);
  }

  async hasApiKey(): Promise<boolean> {
    return Boolean(await this.getApiKey());
  }
}
