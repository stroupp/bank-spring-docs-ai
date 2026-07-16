import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { DocumentationModelResponse, IDocumentationModelClient } from "../ai/documentationModelClient";
import { IQwenClient, QwenClient } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { maskSecrets, maskSecretsWithStats } from "../ai/safeContextFilter";
import { writeJsonl } from "../storage/jsonlWriter";
import { sha256 } from "../utils/hash";
import { safeName } from "../utils/pathUtils";
import { parseStrictJson } from "../semantic/semanticCacheService";
import { buildPageArtifactMetadata } from "./pageArtifactMetadata";
import { buildInteractionSemanticPrompt, buildPageSemanticPrompt, pageSemanticPromptVersion } from "./pageSemanticPrompts";

export interface QwenPageSemanticResult {
  pageSemanticsPath: string;
  interactionSemanticsPath: string;
  analyzedInteractions: number;
  cacheHits: number;
  failures: number;
}

export interface Qwen3OnlyPageSemanticOptions {
  client: IDocumentationModelClient;
  /** Secret-free client/configuration snapshot used to isolate verified cache entries. */
  cacheIdentity: string;
  expectedModelMarker?: string;
}

export class Qwen3PageSemanticBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Qwen3PageSemanticBoundaryError";
  }
}

export class QwenPageSemanticAnalyzer {
  constructor(
    private readonly injectedClient?: IQwenClient,
    private readonly modelOverride?: string,
    private readonly maxContextCharactersOverride?: number,
    private readonly qwen3Only?: Qwen3OnlyPageSemanticOptions
  ) {}

  async analyze(pageRoot: string, context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<QwenPageSemanticResult> {
    await fs.mkdir(pageRoot, { recursive: true });
    const settings = new QwenSettingsService(context);
    if (this.qwen3Only && this.qwen3Only.client.provider !== "qwen") {
      throw new Qwen3PageSemanticBoundaryError("Qwen3-only semantic analysis requires provider=qwen.");
    }
    if (this.qwen3Only && !this.qwen3Only.cacheIdentity.trim()) {
      throw new Qwen3PageSemanticBoundaryError("Qwen3-only semantic cache identity cannot be empty.");
    }
    const client = this.qwen3Only ? undefined : this.injectedClient ?? new QwenClient(settings);
    const model = this.qwen3Only?.cacheIdentity.trim()
      ?? this.modelOverride
      ?? settings.getSettings().model;
    const pageContext = await readOptional(path.join(pageRoot, "page-context-pack.md"));
    const evidence = await readOptional(path.join(pageRoot, "page-evidence-pack.md"));
    const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
    const maxContextCharacters = this.maxContextCharactersOverride
      ?? vscode.workspace.getConfiguration("bankSpringDocs").get<number>("semantic.maxCharactersPerFile", 16000);
    const combinedContext = prepareQwenContext(
      [pageContext, evidence ? `# Focused Source Evidence\n\n${evidence}` : ""].filter(Boolean).join("\n\n---\n\n"),
      maxContextCharacters
    );

    const pageIdentity = maskSecrets(String((pageFlow.selectedPage as Record<string, unknown> | undefined)?.pageName ?? path.basename(pageRoot)));
    const pageSemanticsPath = path.join(pageRoot, "qwen-page-semantics.json");
    const interactionSemanticsPath = path.join(pageRoot, "qwen-interaction-semantics.jsonl");
    const cacheRoot = path.join(pageRoot, ".cache", "qwen");

    const pagePrompt = buildPageSemanticPrompt(combinedContext);
    const pageCache = await readCache(cacheRoot, model, `page:${pageIdentity}`, pagePrompt);
    let failures = 0;
    let pageSemantics: unknown;
    if (pageCache.hit) {
      pageSemantics = pageCache.value;
    } else {
      let rawOutput = "";
      try {
        rawOutput = await this.askSemantic(client, pagePrompt, token);
        pageSemantics = parseStrictJson(rawOutput);
        await writeCache(pageCache.path, pageSemantics);
      } catch (error) {
        ensureNotCancelled(token);
        if (error instanceof Qwen3PageSemanticBoundaryError) {
          throw error;
        }
        failures += 1;
        if (rawOutput) {
          await writeDebug(cacheRoot, `page-${pageIdentity}`, rawOutput);
        }
        pageSemantics = failedSemanticRecord(pageIdentity, error);
      }
    }
    const metadata = await buildPageArtifactMetadata(pageRoot, ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"]);
    await fs.writeFile(pageSemanticsPath, `${JSON.stringify(withMetadata(pageSemantics, metadata), null, 2)}\n`, "utf8");

    let cacheHits = pageCache.hit ? 1 : 0;
    const interactionRecords = importantInteractions(pageFlow);
    const interactionSemantics: unknown[] = [];
    for (const interaction of interactionRecords) {
      ensureNotCancelled(token);
      let rawOutput = "";
      try {
        const prompt = buildInteractionSemanticPrompt(prepareQwenContext(JSON.stringify({
          selectedPage: pageFlow.selectedPage,
          interaction,
          pageFlows: pageFlow.pageFlows,
          uiApiCalls: pageFlow.uiApiCalls,
          uiToBffMatches: pageFlow.uiToBffMatches,
          bffToBeMatches: pageFlow.bffToBeMatches,
          evidence
        }, null, 2), maxContextCharacters));
        const identity = `interaction:${pageIdentity}:${safeName(JSON.stringify(interaction).slice(0, 160))}`;
        const cached = await readCache(cacheRoot, model, identity, prompt);
        if (cached.hit) {
          interactionSemantics.push(cached.value);
          cacheHits += 1;
          continue;
        }
        rawOutput = await this.askSemantic(client, prompt, token);
        const parsed = parseStrictJson(rawOutput);
        await writeCache(cached.path, parsed);
        interactionSemantics.push(parsed);
      } catch (error) {
        ensureNotCancelled(token);
        if (error instanceof Qwen3PageSemanticBoundaryError) {
          throw error;
        }
        failures += 1;
        if (rawOutput) {
          await writeDebug(cacheRoot, `interaction-${pageIdentity}`, rawOutput);
        }
      }
    }

    await writeJsonl(interactionSemanticsPath, interactionSemantics);
    return {
      pageSemanticsPath,
      interactionSemanticsPath,
      analyzedInteractions: interactionSemantics.length,
      cacheHits,
      failures
    };
  }

  private async askSemantic(
    legacyClient: IQwenClient | undefined,
    prompt: string,
    token?: vscode.CancellationToken
  ): Promise<string> {
    if (!this.qwen3Only) {
      if (!legacyClient) {
        throw new Error("Qwen semantic client is unavailable.");
      }
      return legacyClient.ask(prompt, token);
    }
    if (!token) {
      throw new Qwen3PageSemanticBoundaryError("Qwen3-only semantic analysis requires a cancellation token.");
    }
    const response = await this.qwen3Only.client.send(prompt, token);
    validateQwen3SemanticResponse(response, this.qwen3Only.expectedModelMarker ?? "qwen3");
    return cleanAndMaskQwen3SemanticOutput(response.text);
  }
}

function validateQwen3SemanticResponse(response: DocumentationModelResponse, expectedMarker: string): void {
  if (response.provider !== "qwen") {
    throw new Qwen3PageSemanticBoundaryError(`Qwen3-only semantic analysis rejected provider '${response.provider}'.`);
  }
  const identity = `${response.model.id} ${response.model.name} ${response.model.family}`;
  if (!containsIdentitySegment(identity, expectedMarker)) {
    throw new Qwen3PageSemanticBoundaryError(
      `Qwen3-only semantic analysis rejected unexpected model '${response.model.id}'.`
    );
  }
  if (!response.text.trim()) {
    throw new Qwen3PageSemanticBoundaryError("Qwen3-only semantic analysis received an empty response.");
  }
}

function cleanAndMaskQwen3SemanticOutput(value: string): string {
  const withoutThinking = value
    .replace(/^\uFEFF?\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, "")
    .trim();
  if (/^<think>/i.test(withoutThinking)) {
    throw new Qwen3PageSemanticBoundaryError("Qwen3 semantic response contained an unterminated reasoning block.");
  }
  const outerFence = withoutThinking.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  const clean = maskSecretsWithStats(outerFence?.[1] ?? withoutThinking).text.trim();
  if (!clean) {
    throw new Qwen3PageSemanticBoundaryError("Qwen3 semantic response became empty after sanitation.");
  }
  return clean;
}

function containsIdentitySegment(identity: string, expectedMarker: string): boolean {
  const marker = expectedMarker.trim().toLowerCase();
  if (!marker) {
    return false;
  }
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(identity);
}

function ensureNotCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new Error("Qwen isteği kullanıcı tarafından iptal edildi.");
  }
}

export function prepareQwenContext(value: string, maxCharacters: number): string {
  const safe = maskSecrets(value);
  if (maxCharacters <= 0) {
    return "";
  }
  if (safe.length <= maxCharacters) {
    return safe;
  }
  const marker = "\n[PAGE_CONTEXT_TRUNCATED_FOR_QWEN_TOKEN_LIMIT]";
  if (maxCharacters <= marker.length) {
    return marker.slice(0, maxCharacters);
  }
  return `${safe.slice(0, maxCharacters - marker.length)}${marker}`;
}

function withMetadata(value: unknown, metadata: Awaited<ReturnType<typeof buildPageArtifactMetadata>>): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), _metadata: metadata };
  }
  return { _metadata: metadata, value };
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function importantInteractions(pageFlow: Record<string, unknown>): Array<Record<string, unknown>> {
  const interactions = asRecords(pageFlow.interactions);
  const uiApiCalls = asRecords(pageFlow.uiApiCalls);
  if (interactions.length) {
    return interactions.slice(0, 20);
  }
  return uiApiCalls.slice(0, 20);
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

async function readCache(root: string, model: string, identity: string, prompt: string): Promise<{ hit: boolean; path: string; value?: unknown }> {
  const cachePath = path.join(root, `${safeName(identity)}.${sha256(`${pageSemanticPromptVersion}:${model}:${prompt}`)}.json`);
  try {
    return { hit: true, path: cachePath, value: JSON.parse(await fs.readFile(cachePath, "utf8")) };
  } catch {
    return { hit: false, path: cachePath };
  }
}

async function writeCache(cachePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(value, null, 2), "utf8");
}

async function writeDebug(root: string, identity: string, rawOutput: string): Promise<void> {
  const target = path.join(root, "debug", `${safeName(identity)}-${Date.now()}.txt`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, safeSemanticDebugOutput(rawOutput), "utf8");
}

function safeSemanticDebugOutput(value: string): string {
  const withoutThinking = value
    .replace(/^\uFEFF?\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, "")
    .trim();
  if (/^<think>/i.test(withoutThinking)) {
    return "[QWEN_REASONING_BLOCK_OMITTED]";
  }
  return maskSecretsWithStats(withoutThinking).text;
}

function failedSemanticRecord(pageIdentity: string, error: unknown): Record<string, unknown> {
  return {
    page: pageIdentity,
    confidence: "low",
    uncertainties: ["Qwen semantik analizi tamamlanamadı; yerel context ve evidence artefaktları kullanılmaya devam edilebilir."],
    error: maskSecretsWithStats(error instanceof Error ? error.message : String(error)).text
  };
}
