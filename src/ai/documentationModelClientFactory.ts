import * as vscode from "vscode";
import { RealCopilotClient } from "./copilotClient";
import { DocumentationModelProvider, IDocumentationModelClient } from "./documentationModelClient";
import { QwenDocumentationModelClient } from "./qwenDocumentationModelClient";
import {
  assertBankingQwenEndpoint,
  assertQwenEndpointAllowed,
  normalizeChatCompletionsEndpoint
} from "./qwenClient";
import { BANKING_QWEN_MODEL_ALIAS, QwenSettingsService } from "./qwenSettingsService";
import { sha256 } from "../utils/hash";

export interface DocumentationModelIdentity {
  provider: DocumentationModelProvider;
  model?: string;
  family?: string;
  configurationFingerprint?: string;
}

const qwen3ModelSegment = /(?:^|[/:._-])qwen3(?:$|[/:._-])/i;

export function getConfiguredDocumentationModelProvider(): DocumentationModelProvider {
  const configured = vscode.workspace
    .getConfiguration("bankSpringDocs")
    .get<string>("ai.provider", "copilot")
    .trim()
    .toLowerCase();

  if (configured === "copilot" || configured === "qwen") {
    return configured;
  }
  throw new Error(
    `Desteklenmeyen doküman modeli sağlayıcısı: '${configured || "boş"}'. ` +
    "bankSpringDocs.ai.provider değeri 'copilot' veya 'qwen' olmalıdır."
  );
}

/** Creates exactly the configured provider. Provider failures never fall back. */
export function createDocumentationModelClient(context: vscode.ExtensionContext): IDocumentationModelClient {
  assertDocumentationWorkspaceTrusted();
  const provider = getConfiguredDocumentationModelProvider();
  if (provider === "copilot") {
    return new RealCopilotClient();
  }

  return createValidatedQwenDocumentationModelClient(context, false);
}

/**
 * Creates Qwen explicitly without consulting the configured provider.
 * This boundary is intended for Qwen3-only pipelines and keeps the same
 * workspace-trust, enablement, endpoint-normalization, and host-allowlist
 * checks as the configured-provider factory.
 */
export function createQwenDocumentationModelClient(context: vscode.ExtensionContext): QwenDocumentationModelClient {
  assertDocumentationWorkspaceTrusted();
  return createValidatedQwenDocumentationModelClient(context, true);
}

/** Returns the trimmed model id or throws when it is not explicitly in the Qwen3 family. */
export function assertQwen3ModelName(model: string, allowBankingAlias = false): string {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error("Qwen3 model adı boş olamaz.");
  }
  if (
    !qwen3ModelSegment.test(normalized)
    && !(allowBankingAlias && normalized.toUpperCase() === BANKING_QWEN_MODEL_ALIAS)
  ) {
    throw new Error("Bu pipeline yalnızca Qwen3 model ailesini destekler. Qwen3 model adı yapılandırın.");
  }
  return normalized;
}

function createValidatedQwenDocumentationModelClient(
  context: vscode.ExtensionContext,
  requireQwen3: boolean
): QwenDocumentationModelClient {

  const settingsService = new QwenSettingsService(context);
  const settings = settingsService.getSettings();
  if (!settings.enabled) {
    throw new Error(
      "Doküman modeli olarak Qwen seçildi ancak Qwen etkin değil. " +
      "Bank Spring Docs panelinden Qwen'i etkinleştirip bağlantıyı test edin."
    );
  }
  if (!settings.model.trim()) {
    throw new Error("Doküman modeli olarak Qwen seçildi ancak Qwen model adı boş.");
  }
  if (requireQwen3) {
    assertQwen3ModelName(settings.model, settings.bankingEnvironment);
  }
  if (!settings.endpoint.trim()) {
    throw new Error("Doküman modeli olarak Qwen seçildi ancak Qwen endpoint adresi boş.");
  }
  if (settings.bankingEnvironment) {
    assertBankingQwenEndpoint(settings.endpoint);
  }
  assertQwenEndpointAllowed(
    normalizeChatCompletionsEndpoint(settings.endpoint),
    settings.bankingEnvironment
  );
  return new QwenDocumentationModelClient(settingsService);
}

function assertDocumentationWorkspaceTrusted(): void {
  if (vscode.workspace.isTrusted === false) {
    throw new Error("AI doküman üretimi için VS Code çalışma alanına güvenilmelidir.");
  }
}

/** Stable, secret-free identity used to pin resumable Agentic runs. */
export function getConfiguredDocumentationModelIdentity(context: vscode.ExtensionContext): DocumentationModelIdentity {
  const provider = getConfiguredDocumentationModelProvider();
  if (provider === "qwen") {
    return getQwenDocumentationModelIdentity(context);
  }
  const model = vscode.workspace.getConfiguration("bankSpringDocs").get<string>("copilot.modelId", "").trim();
  return { provider, model: model || undefined };
}

/** Secret-free Qwen identity for explicit provider overrides and resumable runs. */
export function getQwenDocumentationModelIdentity(context: vscode.ExtensionContext): DocumentationModelIdentity {
  return buildQwenDocumentationModelIdentity(context, true);
}

/**
 * Secret-free Qwen identity for the resumable selected-page pipeline.
 * Request timeouts are operational retry controls, so changing only the
 * timeout must not discard already completed evidence-analysis steps.
 */
export function getResumableQwenPageModelIdentity(context: vscode.ExtensionContext): DocumentationModelIdentity {
  return buildQwenDocumentationModelIdentity(context, false);
}

function buildQwenDocumentationModelIdentity(
  context: vscode.ExtensionContext,
  includeGenerationTimeout: boolean
): DocumentationModelIdentity {
  const settings = new QwenSettingsService(context).getSettings();
  const model = settings.model.trim();
  const config = vscode.workspace.getConfiguration("bankSpringDocs");
  const endpoint = normalizeChatCompletionsEndpoint(settings.endpoint);
  const generationMaxTokens = config.get<number>("qwen.generationMaxTokens", 16384);
  const contextWindowTokens = config.get<number>("qwen.contextWindowTokens", 131072);
  // Keep the established key order for the general identity so existing
  // configured-Qwen resumable runs retain their exact fingerprint.
  const identity: Record<string, unknown> = includeGenerationTimeout
    ? {
      provider: "qwen",
      endpoint,
      model,
      temperature: settings.temperature,
      generationTimeoutSeconds: config.get<number>("qwen.generationTimeoutSeconds", 600),
      generationMaxTokens,
      contextWindowTokens
    }
    : {
      provider: "qwen",
      endpoint,
      model,
      temperature: settings.temperature,
      generationMaxTokens,
      contextWindowTokens
    };
  if (settings.bankingEnvironment) {
    identity.bankingEnvironment = true;
  }
  const result: DocumentationModelIdentity = {
    provider: "qwen",
    model: model || undefined,
    configurationFingerprint: sha256(JSON.stringify(identity))
  };
  if (settings.bankingEnvironment) {
    result.family = "qwen3";
  }
  return result;
}
