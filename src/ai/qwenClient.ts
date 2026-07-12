import * as vscode from "vscode";
import { QwenSettingsService } from "./qwenSettingsService";

export type QwenConnectionResult = {
  ok: boolean;
  message: string;
  model?: string;
  endpoint?: string;
};

/** Boundary used by semantic analyzers. Tests can inject a deterministic client. */
export interface IQwenClient {
  ask(prompt: string, token?: vscode.CancellationToken): Promise<string>;
  testConnection?(): Promise<QwenConnectionResult>;
}

type QwenResponse = {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
};

export class QwenClient implements IQwenClient {
  constructor(private readonly settingsService: QwenSettingsService) {}

  async ask(prompt: string, token?: vscode.CancellationToken): Promise<string> {
    const settings = this.settingsService.getSettings();
    if (!settings.model.trim()) {
      throw new Error("Qwen model adı boş olamaz.");
    }
    if (!settings.endpoint.trim()) {
      throw new Error("Qwen endpoint adresi boş olamaz.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Qwen isteği zaman aşımına uğradı.")), settings.timeoutSeconds * 1000);
    const cancellation = token?.onCancellationRequested(() => controller.abort(new Error("Qwen isteği iptal edildi.")));

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (settings.useApiKey) {
        const apiKey = await this.settingsService.getApiKey();
        if (!apiKey) {
          throw new Error("API Key kullanımı açık ancak SecretStorage içinde API key bulunamadı.");
        }
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const endpoint = normalizeChatCompletionsEndpoint(settings.endpoint);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: "user", content: prompt }],
          temperature: settings.temperature,
          max_tokens: settings.maxTokens
        }),
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error("Qwen isteği yetkisiz döndü. API key ayarını kontrol et.");
      }
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(`Qwen HTTP hatası: ${response.status} ${response.statusText}. Endpoint: ${endpoint}${detail ? `. Detay: ${detail}` : ""}`);
      }

      const data = (await response.json()) as QwenResponse;
      const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text;
      if (!content) {
        throw new Error("Qwen yanıtı geçersiz: choices[0].message.content veya choices[0].text bulunamadı.");
      }
      return content;
    } catch (error) {
      throw normalizeQwenError(error);
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  async testConnection(): Promise<QwenConnectionResult> {
    const settings = this.settingsService.getSettings();
    try {
      const output = await this.ask("Return exactly this JSON: {\"ok\":true}");
      return {
        ok: true,
        message: `Qwen bağlantısı başarılı. Yanıt alındı (${Math.min(output.length, 80)} karakter).`,
        model: settings.model,
        endpoint: normalizeChatCompletionsEndpoint(settings.endpoint)
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        model: settings.model,
        endpoint: normalizeChatCompletionsEndpoint(settings.endpoint)
      };
    }
  }
}

function normalizeChatCompletionsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/compatible-mode\/v1$/i.test(trimmed) || /\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  if (/dashscope-intl\.aliyuncs\.com$/i.test(trimmed) || /dashscope\.aliyuncs\.com$/i.test(trimmed)) {
    return `${trimmed}/compatible-mode/v1/chat/completions`;
  }
  return trimmed;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function normalizeQwenError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /abort|timeout|zaman aşımı/i.test(error.message)) {
      return new Error("Qwen bağlantısı zaman aşımına uğradı veya iptal edildi.");
    }
    if (/ECONNREFUSED|fetch failed|Failed to fetch|connection refused/i.test(error.message)) {
      return new Error("Qwen bağlantısı kurulamadı. Endpoint çalışıyor mu kontrol et.");
    }
    return error;
  }
  return new Error(String(error));
}
