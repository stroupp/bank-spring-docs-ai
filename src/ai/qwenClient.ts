import * as vscode from "vscode";
import {
  BANKING_QWEN_MODEL_ALIAS,
  normalizeBankingQwenEndpoint,
  QwenSettings
} from "./qwenSettingsService";

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

export interface QwenSettingsProvider {
  getSettings(): QwenSettings;
  getApiKey(): Promise<string | undefined>;
}

type QwenResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    text?: string;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type QwenChatRole = "system" | "user" | "assistant";

export interface QwenChatMessage {
  role: QwenChatRole;
  content: string;
}

export interface QwenCompletionOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  enableThinking?: boolean;
  maxTokens?: number;
  timeoutSeconds?: number;
}

export interface QwenCompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface QwenCompletionResult {
  content: string;
  finishReason?: string;
  model: string;
  requestId?: string;
  usage: QwenCompletionUsage;
}

export class QwenRequestCancelledError extends Error {
  constructor() {
    super("Qwen isteği kullanıcı tarafından iptal edildi.");
    this.name = "QwenRequestCancelledError";
  }
}

export class QwenRequestTimeoutError extends Error {
  constructor(timeoutSeconds: number) {
    super(`Qwen isteği ${timeoutSeconds} saniye içinde tamamlanamadı ve zaman aşımına uğradı.`);
    this.name = "QwenRequestTimeoutError";
  }
}

export class QwenClient implements IQwenClient {
  constructor(private readonly settingsService: QwenSettingsProvider) {}

  async ask(prompt: string, token?: vscode.CancellationToken): Promise<string> {
    const result = await this.complete([{ role: "user", content: prompt }], {}, token);
    if (result.finishReason?.toLowerCase() === "length") {
      throw new Error("Qwen yanıtı maksimum token sınırında kesildi. qwen.maxTokens ayarını artırın veya bağlamı küçültün.");
    }
    return result.content;
  }

  async complete(
    messages: QwenChatMessage[],
    options: QwenCompletionOptions = {},
    token?: vscode.CancellationToken
  ): Promise<QwenCompletionResult> {
    if (vscode.workspace.isTrusted === false) {
      throw new Error("Qwen çağrısı için VS Code çalışma alanına güvenilmelidir.");
    }
    const settings = this.settingsService.getSettings();
    const requestModel = settings.bankingEnvironment ? BANKING_QWEN_MODEL_ALIAS : settings.model.trim();
    if (!requestModel) {
      throw new Error("Qwen model adı boş olamaz.");
    }
    if (!settings.endpoint.trim()) {
      throw new Error("Qwen endpoint adresi boş olamaz.");
    }
    if (!messages.length || messages.some((message) => !message.content.trim())) {
      throw new Error("Qwen isteği en az bir boş olmayan mesaj içermelidir.");
    }

    const timeoutSeconds = positiveNumber(options.timeoutSeconds ?? settings.timeoutSeconds, "Qwen timeout");
    const maxTokens = positiveNumber(options.maxTokens ?? settings.maxTokens, "Qwen max token");
    const temperature = finiteNumber(options.temperature ?? settings.temperature, "Qwen temperature");
    const topP = options.topP === undefined ? undefined : boundedNumber(options.topP, "Qwen top_p", 0, 1);
    const topK = options.topK === undefined ? undefined : boundedPositiveInteger(options.topK, "Qwen top_k", 1000);
    const presencePenalty = options.presencePenalty === undefined
      ? undefined
      : boundedNumber(options.presencePenalty, "Qwen presence_penalty", -2, 2);
    const interRequestDelaySeconds = boundedNonNegativeNumber(
      settings.interRequestDelaySeconds ?? 15,
      "Qwen istekler arasi bekleme",
      300
    );
    if (token?.isCancellationRequested) {
      throw new QwenRequestCancelledError();
    }

    if (settings.bankingEnvironment) {
      assertBankingQwenEndpoint(settings.endpoint);
    }
    const endpoint = normalizeChatCompletionsEndpoint(settings.endpoint);
    assertQwenEndpointAllowed(endpoint, settings.bankingEnvironment);

    return qwenRequestCoordinator.run(interRequestDelaySeconds, token, async (markRequestStarted) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (!settings.bankingEnvironment && settings.useApiKey) {
        const apiKey = await this.settingsService.getApiKey();
        if (!apiKey) {
          throw new Error("API Key kullanımı açık ancak SecretStorage içinde API key bulunamadı.");
        }
        headers.Authorization = `Bearer ${apiKey}`;
      }
      if (token?.isCancellationRequested) {
        throw new QwenRequestCancelledError();
      }

      const controller = new AbortController();
      let timedOut = false;
      let cancelled = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutSeconds * 1000);
      const cancellation = token?.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      try {
        markRequestStarted();
        const requestBody: Record<string, unknown> = {
          model: requestModel,
          messages,
          temperature,
          max_tokens: Math.floor(maxTokens),
          stream: false
        };
        if (topP !== undefined) {
          requestBody.top_p = topP;
        }
        if (topK !== undefined) {
          requestBody.top_k = topK;
        }
        if (presencePenalty !== undefined) {
          requestBody.presence_penalty = presencePenalty;
        }
        if (options.enableThinking !== undefined) {
          if (isDashScopeEndpoint(endpoint)) {
            requestBody.enable_thinking = options.enableThinking;
          } else {
            requestBody.chat_template_kwargs = { enable_thinking: options.enableThinking };
          }
        }
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        if (response.status === 401 || response.status === 403) {
          throw new Error("Qwen isteği yetkisiz döndü. API key ayarını kontrol edin.");
        }
        if (!response.ok) {
          throw new Error(`Qwen HTTP hatası: ${response.status} ${response.statusText}. Sunucu hata gövdesi güvenlik nedeniyle kaydedilmedi.`);
        }

        let data: QwenResponse;
        try {
          data = (await response.json()) as QwenResponse;
        } catch {
          throw new Error("Qwen yanıtı geçerli JSON içermiyor.");
        }
        if (token?.isCancellationRequested || cancelled) {
          throw new QwenRequestCancelledError();
        }

        const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("Qwen yanıtı geçersiz veya boş: choices[0].message.content ya da choices[0].text bulunamadı.");
        }
        const responseModel = data.model?.trim() || requestModel;
        if (settings.bankingEnvironment && !isApprovedBankingResponseModel(responseModel)) {
          throw new Error(`Banking environment rejected unexpected Qwen model response '${responseModel}'.`);
        }

        return {
          content,
          finishReason: data.choices?.[0]?.finish_reason ?? undefined,
          model: responseModel,
          requestId: data.id,
          usage: {
            promptTokens: finiteOptionalNumber(data.usage?.prompt_tokens),
            completionTokens: finiteOptionalNumber(data.usage?.completion_tokens),
            totalTokens: finiteOptionalNumber(data.usage?.total_tokens)
          }
        };
      } catch (error) {
        throw normalizeQwenError(error, {
          cancelled: cancelled || Boolean(token?.isCancellationRequested),
          timedOut,
          timeoutSeconds
        });
      } finally {
        clearTimeout(timeout);
        cancellation?.dispose();
      }
    });
  }

  async testConnection(): Promise<QwenConnectionResult> {
    const settings = this.settingsService.getSettings();
    const endpoint = endpointForDisplay(settings.endpoint);
    const model = settings.bankingEnvironment ? BANKING_QWEN_MODEL_ALIAS : settings.model;
    try {
      const result = await this.complete([
        {
          role: "system",
          content: "You are a Qwen connection test. Return only the exact JSON requested by the user, without explanation."
        },
        { role: "user", content: "Return exactly this JSON: {\"ok\":true}" }
      ], {
        enableThinking: false,
        maxTokens: 64,
        timeoutSeconds: settings.timeoutSeconds
      });
      const output = result.content;
      if (!/\{\s*"ok"\s*:\s*true\s*\}/i.test(output)) {
        throw new Error("Qwen connection test did not return the expected {\"ok\":true} JSON response.");
      }
      return {
        ok: true,
        message: `Qwen bağlantısı başarılı. Yanıt alındı (${Math.min(output.length, 80)} karakter).`,
        model,
        endpoint
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        model,
        endpoint
      };
    }
  }
}

class QwenRequestCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestNotBefore = 0;

  async run<T>(
    delaySeconds: number,
    token: vscode.CancellationToken | undefined,
    operation: (markRequestStarted: () => void) => Promise<T>
  ): Promise<T> {
    const previous = this.tail.catch(() => undefined);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => done);
    let requestStarted = false;

    try {
      await waitForPromise(previous, token);
      const remainingDelay = Math.max(0, this.nextRequestNotBefore - Date.now());
      await cancellableDelay(remainingDelay, token);
      if (token?.isCancellationRequested) {
        throw new QwenRequestCancelledError();
      }
      return await operation(() => {
        requestStarted = true;
      });
    } finally {
      if (requestStarted) {
        this.nextRequestNotBefore = Math.max(
          this.nextRequestNotBefore,
          Date.now() + Math.round(delaySeconds * 1000)
        );
      }
      release();
    }
  }
}

const qwenRequestCoordinator = new QwenRequestCoordinator();

export function normalizeChatCompletionsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Qwen endpoint adresi geçerli bir HTTP(S) URL olmalıdır.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Qwen endpoint adresi yalnızca HTTP veya HTTPS protokolü kullanabilir.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Qwen endpoint adresinde kullanıcı adı veya parola bulunamaz. API key için SecretStorage kullanın.");
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalizedPath)) {
    parsed.pathname = normalizedPath;
  } else if (/\/compatible-mode\/v1$/i.test(normalizedPath) || /\/v1$/i.test(normalizedPath)) {
    parsed.pathname = `${normalizedPath}/chat/completions`;
  } else if (/^(dashscope-intl|dashscope)\.aliyuncs\.com$/i.test(parsed.hostname)) {
    parsed.pathname = `${normalizedPath}/compatible-mode/v1/chat/completions`.replace(/\/+/g, "/");
  } else if (!normalizedPath) {
    parsed.pathname = "/v1/chat/completions";
  }
  parsed.hash = "";
  return parsed.toString();
}

export function assertQwenEndpointAllowed(endpoint: string, bankingEnvironment = false): void {
  if (bankingEnvironment) {
    assertBankingQwenEndpoint(endpoint);
  }
  const parsed = new URL(endpoint);
  const configured = vscode.workspace
    .getConfiguration("bankSpringDocs")
    .get<string[]>("qwen.allowedHosts", ["localhost", "127.0.0.1", "::1"]);
  const allowedHosts = configured.map(normalizeHost).filter(Boolean);
  const hostname = normalizeHost(parsed.hostname);
  if (!allowedHosts.includes(hostname)) {
    throw new Error(
      `Qwen endpoint hostu '${hostname}' izin listesinde değil. ` +
      "Makine ayarındaki bankSpringDocs.qwen.allowedHosts listesine onaylı hostu ekleyin."
    );
  }
}

/**
 * Banking mode narrows the accepted URL shape. Host approval remains an
 * independent, machine-scoped allowlist check performed by
 * assertQwenEndpointAllowed.
 */
export function assertBankingQwenEndpoint(endpoint: string): void {
  normalizeBankingQwenEndpoint(endpoint);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isApprovedBankingResponseModel(model: string): boolean {
  const normalized = model.trim();
  return normalized.toUpperCase() === BANKING_QWEN_MODEL_ALIAS
    || /(?:^|[\/:._-])qwen3(?:$|[\/:._-])/i.test(normalized);
}

function endpointForDisplay(endpoint: string): string {
  try {
    const parsed = new URL(normalizeChatCompletionsEndpoint(endpoint));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[geçersiz endpoint]";
  }
}

function normalizeQwenError(
  error: unknown,
  state: { cancelled: boolean; timedOut: boolean; timeoutSeconds: number }
): Error {
  if (state.cancelled || error instanceof QwenRequestCancelledError) {
    return new QwenRequestCancelledError();
  }
  if (state.timedOut || error instanceof QwenRequestTimeoutError) {
    return new QwenRequestTimeoutError(state.timeoutSeconds);
  }
  if (error instanceof Error) {
    if (/ECONNREFUSED|fetch failed|Failed to fetch|connection refused/i.test(error.message)) {
      return new Error("Qwen bağlantısı kurulamadı. Endpoint çalışıyor mu kontrol edin.");
    }
    return error;
  }
  return new Error(String(error));
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ayarı geçerli bir sayı olmalıdır.`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  const finite = finiteNumber(value, label);
  if (finite <= 0) {
    throw new Error(`${label} ayarı sıfırdan büyük olmalıdır.`);
  }
  return finite;
}

function boundedNumber(value: number, label: string, minimum: number, maximum: number): number {
  const finite = finiteNumber(value, label);
  if (finite < minimum || finite > maximum) {
    throw new Error(`${label} ayarı ${minimum}-${maximum} aralığında olmalıdır.`);
  }
  return finite;
}

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
  const finite = positiveNumber(value, label);
  if (!Number.isSafeInteger(finite) || finite > maximum) {
    throw new Error(`${label} ayarı en fazla ${maximum} olan pozitif bir tam sayı olmalıdır.`);
  }
  return finite;
}

function boundedNonNegativeNumber(value: number, label: string, maximum: number): number {
  const finite = finiteNumber(value, label);
  if (finite < 0 || finite > maximum) {
    throw new Error(`${label} ayarı 0-${maximum} aralığında olmalıdır.`);
  }
  return finite;
}

async function waitForPromise(
  promise: Promise<void>,
  token?: vscode.CancellationToken
): Promise<void> {
  if (!token) {
    await promise;
    return;
  }
  if (token.isCancellationRequested) {
    throw new QwenRequestCancelledError();
  }

  let cancellation: vscode.Disposable | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };
      cancellation = token.onCancellationRequested(() => {
        finish(() => reject(new QwenRequestCancelledError()));
      });
      promise.then(
        () => finish(resolve),
        (error) => finish(() => reject(error))
      );
    });
  } finally {
    cancellation?.dispose();
  }
}

async function cancellableDelay(milliseconds: number, token?: vscode.CancellationToken): Promise<void> {
  if (token?.isCancellationRequested) {
    throw new QwenRequestCancelledError();
  }
  if (milliseconds <= 0) {
    return;
  }

  let cancellation: vscode.Disposable | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        callback();
      };
      timer = setTimeout(() => finish(resolve), milliseconds);
      cancellation = token?.onCancellationRequested(() => {
        finish(() => reject(new QwenRequestCancelledError()));
      });
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    cancellation?.dispose();
  }
}

function finiteOptionalNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function isDashScopeEndpoint(endpoint: string): boolean {
  try {
    return /(?:^|\.)dashscope(?:-intl)?\.aliyuncs\.com$/i.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}
