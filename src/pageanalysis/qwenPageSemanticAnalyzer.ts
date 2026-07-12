import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { IQwenClient, QwenClient } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { maskSecrets } from "../ai/safeContextFilter";
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

export class QwenPageSemanticAnalyzer {
  constructor(
    private readonly injectedClient?: IQwenClient,
    private readonly modelOverride?: string,
    private readonly maxContextCharactersOverride?: number
  ) {}

  async analyze(pageRoot: string, context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<QwenPageSemanticResult> {
    await fs.mkdir(pageRoot, { recursive: true });
    const settings = new QwenSettingsService(context);
    const client = this.injectedClient ?? new QwenClient(settings);
    const model = this.modelOverride ?? settings.getSettings().model;
    const pageContext = await readOptional(path.join(pageRoot, "page-context-pack.md"));
    const evidence = await readOptional(path.join(pageRoot, "page-evidence-pack.md"));
    const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
    const maxContextCharacters = this.maxContextCharactersOverride
      ?? vscode.workspace.getConfiguration("bankSpringDocs").get<number>("semantic.maxCharactersPerFile", 16000);
    const combinedContext = prepareQwenContext(
      [pageContext, evidence ? `# Focused Source Evidence\n\n${evidence}` : ""].filter(Boolean).join("\n\n---\n\n"),
      maxContextCharacters
    );

    const pageIdentity = String((pageFlow.selectedPage as Record<string, unknown> | undefined)?.pageName ?? path.basename(pageRoot));
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
        rawOutput = await client.ask(pagePrompt, token);
        pageSemantics = parseStrictJson(rawOutput);
        await writeCache(pageCache.path, pageSemantics);
      } catch (error) {
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
      if (token?.isCancellationRequested) {
        break;
      }
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
        rawOutput = await client.ask(prompt, token);
        const parsed = parseStrictJson(rawOutput);
        await writeCache(cached.path, parsed);
        interactionSemantics.push(parsed);
      } catch {
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
  await fs.writeFile(target, rawOutput, "utf8");
}

function failedSemanticRecord(pageIdentity: string, error: unknown): Record<string, unknown> {
  return {
    page: pageIdentity,
    confidence: "low",
    uncertainties: ["Qwen semantik analizi tamamlanamadı; yerel context ve evidence artefaktları kullanılmaya devam edilebilir."],
    error: error instanceof Error ? error.message : String(error)
  };
}
