import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { QwenClient } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { writeJsonl } from "../storage/jsonlWriter";
import { sha256 } from "../utils/hash";
import { safeName } from "../utils/pathUtils";
import { parseStrictJson } from "../semantic/semanticCacheService";
import { buildInteractionSemanticPrompt, buildPageSemanticPrompt, pageSemanticPromptVersion } from "./pageSemanticPrompts";

export interface QwenPageSemanticResult {
  pageSemanticsPath: string;
  interactionSemanticsPath: string;
  analyzedInteractions: number;
  cacheHits: number;
  failures: number;
}

export class QwenPageSemanticAnalyzer {
  async analyze(pageRoot: string, context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<QwenPageSemanticResult> {
    const settings = new QwenSettingsService(context);
    const client = new QwenClient(settings);
    const model = settings.getSettings().model;
    const pageContext = await readOptional(path.join(pageRoot, "page-context-pack.md"));
    const evidence = await readOptional(path.join(pageRoot, "page-evidence-pack.md"));
    const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
    const combinedContext = [pageContext, evidence ? `# Focused Source Evidence\n\n${evidence}` : ""].filter(Boolean).join("\n\n---\n\n");

    const pageIdentity = String((pageFlow.selectedPage as Record<string, unknown> | undefined)?.pageName ?? path.basename(pageRoot));
    const pageSemanticsPath = path.join(pageRoot, "qwen-page-semantics.json");
    const interactionSemanticsPath = path.join(pageRoot, "qwen-interaction-semantics.jsonl");
    const cacheRoot = path.join(pageRoot, ".cache", "qwen");

    const pagePrompt = buildPageSemanticPrompt(combinedContext);
    const pageCache = await readCache(cacheRoot, model, `page:${pageIdentity}`, pagePrompt);
    const pageSemantics = pageCache.hit ? pageCache.value : parseStrictJson(await client.ask(pagePrompt, token));
    if (!pageCache.hit) {
      await writeCache(pageCache.path, pageSemantics);
    }
    await fs.writeFile(pageSemanticsPath, `${JSON.stringify(pageSemantics, null, 2)}\n`, "utf8");

    let cacheHits = pageCache.hit ? 1 : 0;
    let failures = 0;
    const interactionRecords = importantInteractions(pageFlow);
    const interactionSemantics: unknown[] = [];
    for (const interaction of interactionRecords) {
      if (token?.isCancellationRequested) {
        break;
      }
      try {
        const prompt = buildInteractionSemanticPrompt(JSON.stringify({
          selectedPage: pageFlow.selectedPage,
          interaction,
          pageFlows: pageFlow.pageFlows,
          uiApiCalls: pageFlow.uiApiCalls,
          uiToBffMatches: pageFlow.uiToBffMatches,
          bffToBeMatches: pageFlow.bffToBeMatches,
          evidence
        }, null, 2));
        const identity = `interaction:${pageIdentity}:${safeName(JSON.stringify(interaction).slice(0, 160))}`;
        const cached = await readCache(cacheRoot, model, identity, prompt);
        if (cached.hit) {
          interactionSemantics.push(cached.value);
          cacheHits += 1;
          continue;
        }
        const parsed = parseStrictJson(await client.ask(prompt, token));
        await writeCache(cached.path, parsed);
        interactionSemantics.push(parsed);
      } catch {
        failures += 1;
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
