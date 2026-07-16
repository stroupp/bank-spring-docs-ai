import * as vscode from "vscode";

export const qwenApiKeySecretKey = "bankSpringDocs.qwen.apiKey";
export const BANKING_QWEN_MODEL_ALIAS = "ONIKS";

export interface BankingQwenEndpointApproval {
  endpoint: string;
  hostname: string;
}

/**
 * Validates the endpoint shape without embedding any institution hostname in
 * the extension. The host itself is approved only after the user explicitly
 * saves/tests the machine-scoped banking configuration.
 */
export function normalizeBankingQwenEndpoint(endpoint: string): BankingQwenEndpointApproval {
  let parsed: URL;
  try {
    parsed = new URL(endpoint.trim().replace(/\/+$/, ""));
  } catch {
    throw bankingEndpointError();
  }
  const valid = parsed.protocol === "https:"
    && Boolean(parsed.hostname)
    && parsed.port === ""
    && parsed.pathname === "/v1/chat/completions"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.search === ""
    && parsed.hash === "";
  if (!valid) {
    throw bankingEndpointError();
  }
  return {
    endpoint: parsed.toString(),
    hostname: normalizeHost(parsed.hostname)
  };
}

export interface QwenSettings {
  enabled: boolean;
  bankingEnvironment: boolean;
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  interRequestDelaySeconds: number;
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
    const bankingEnvironment = config.get<boolean>("qwen.bankingEnvironment", false);
    return {
      enabled: bankingEnvironment || config.get<boolean>("qwen.enabled", true),
      bankingEnvironment,
      endpoint: config.get<string>("qwen.endpoint", "http://localhost:8000/v1/chat/completions"),
      model: bankingEnvironment ? BANKING_QWEN_MODEL_ALIAS : config.get<string>("qwen.model", "Qwen/Qwen3.6-27B"),
      temperature: config.get<number>("qwen.temperature", 0.6),
      maxTokens: config.get<number>("qwen.maxTokens", 16384),
      timeoutSeconds: config.get<number>("qwen.timeoutSeconds", 120),
      interRequestDelaySeconds: config.get<number>("qwen.interRequestDelaySeconds", 15),
      useApiKey: bankingEnvironment ? false : config.get<boolean>("qwen.useApiKey", false)
    };
  }

  async saveSettings(update: QwenSettingsUpdate): Promise<void> {
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    const interRequestDelaySeconds = validateInterRequestDelaySeconds(update.interRequestDelaySeconds);
    const bankingApproval = update.bankingEnvironment
      ? normalizeBankingQwenEndpoint(update.endpoint)
      : undefined;
    if (bankingApproval && vscode.workspace.isTrusted === false) {
      throw new Error("Banking Qwen host approval requires a trusted VS Code workspace.");
    }
    const endpoint = bankingApproval?.endpoint ?? update.endpoint;
    if (bankingApproval) {
      const configuredHosts = config.get<string[]>("qwen.allowedHosts", ["localhost", "127.0.0.1", "::1"]);
      if (!configuredHosts.some((host) => normalizeHost(host) === bankingApproval.hostname)) {
        await config.update(
          "qwen.allowedHosts",
          [...configuredHosts, bankingApproval.hostname],
          vscode.ConfigurationTarget.Global
        );
      }
    }
    await config.update("qwen.enabled", update.bankingEnvironment ? true : update.enabled, vscode.ConfigurationTarget.Global);
    await config.update("qwen.bankingEnvironment", update.bankingEnvironment, vscode.ConfigurationTarget.Global);
    await config.update("qwen.endpoint", endpoint, vscode.ConfigurationTarget.Global);
    await config.update(
      "qwen.model",
      update.bankingEnvironment ? BANKING_QWEN_MODEL_ALIAS : update.model,
      vscode.ConfigurationTarget.Global
    );
    await config.update("qwen.temperature", update.temperature, vscode.ConfigurationTarget.Global);
    await config.update("qwen.maxTokens", update.maxTokens, vscode.ConfigurationTarget.Global);
    await config.update("qwen.timeoutSeconds", update.timeoutSeconds, vscode.ConfigurationTarget.Global);
    await config.update("qwen.interRequestDelaySeconds", interRequestDelaySeconds, vscode.ConfigurationTarget.Global);
    await config.update("qwen.useApiKey", update.bankingEnvironment ? false : update.useApiKey, vscode.ConfigurationTarget.Global);
    if (update.semanticCacheEnabled !== undefined) {
      await config.update("semantic.cacheEnabled", update.semanticCacheEnabled, vscode.ConfigurationTarget.Global);
    }
    if (update.semanticMaxFilesPerRun !== undefined) {
      await config.update("semantic.maxFilesPerRun", update.semanticMaxFilesPerRun, vscode.ConfigurationTarget.Global);
    }
    if (update.semanticMaxCharactersPerFile !== undefined) {
      await config.update("semantic.maxCharactersPerFile", update.semanticMaxCharactersPerFile, vscode.ConfigurationTarget.Global);
    }

    if (!update.bankingEnvironment && update.apiKey !== undefined && update.apiKey.trim()) {
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

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function bankingEndpointError(): Error {
  return new Error(
    "Banking environment Qwen endpoint must be an HTTPS URL with the exact /v1/chat/completions path, without credentials, custom port, query, or fragment."
  );
}

function validateInterRequestDelaySeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 300) {
    throw new Error("Qwen inter-request delay must be between 0 and 300 seconds.");
  }
  return value;
}
