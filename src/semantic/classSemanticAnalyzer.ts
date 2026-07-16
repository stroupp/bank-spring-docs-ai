import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { QwenClient } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { maskSecrets } from "../ai/safeContextFilter";
import { readJsonl, writeJsonl } from "../storage/jsonlWriter";
import { sha256 } from "../utils/hash";
import { ensureWithin } from "../utils/pathUtils";
import { buildClassSemanticPrompt } from "./qwenSemanticPrompts";
import { parseStrictJson, SemanticCacheService } from "./semanticCacheService";

type ComponentIndex = { type: string; className: string; packageName: string; file: string; annotations?: string[] };

export interface SemanticRunStats {
  analyzed: number;
  cacheHits: number;
  failures: number;
}

export class ClassSemanticAnalyzer {
  async analyze(repoRoot: string, aiDocsPath: string, context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<SemanticRunStats> {
    const settings = vscode.workspace.getConfiguration("bankSpringDocs");
    const maxItems = settings.get<number>("semantic.maxFilesPerRun", 50);
    const maxCharacters = settings.get<number>("semantic.maxCharactersPerFile", 20000);
    const cacheEnabled = settings.get<boolean>("semantic.cacheEnabled", true);
    const qwenSettings = new QwenSettingsService(context);
    const qwen = new QwenClient(qwenSettings);
    const cache = new SemanticCacheService(aiDocsPath, qwenSettings.getSettings().model);
    const components = (await readJsonl<ComponentIndex>(path.join(aiDocsPath, "spring-components.jsonl"))).slice(0, maxItems);
    const enriched: unknown[] = [];
    const stats: SemanticRunStats = { analyzed: 0, cacheHits: 0, failures: 0 };

    for (const component of components) {
      try {
        ensureNotCancelled(token);
        const source = maskSecrets(await readLimited(repoRoot, component.file, maxCharacters));
        const sourceHash = sha256(source);
        const identity = `${component.type}:${component.className}:${component.file}`;
        const cacheKey = cache.buildCacheKey(identity, sourceHash);
        const cached = cacheEnabled ? await cache.read("classes", identity, cacheKey) : undefined;
        if (cached) {
          enriched.push(cached);
          stats.cacheHits += 1;
          continue;
        }

        const prompt = buildClassSemanticPrompt(JSON.stringify({ component, sourceSnippet: source }, null, 2));
        const raw = await qwen.ask(prompt, token);
        const parsed = parseStrictJson(raw);
        await cache.write("classes", identity, cacheKey, parsed);
        enriched.push(parsed);
        stats.analyzed += 1;
      } catch (error) {
        ensureNotCancelled(token);
        stats.failures += 1;
        await cache.writeDebug(component.className, error instanceof Error ? error.message : String(error));
      }
    }

    await writeJsonl(path.join(aiDocsPath, "enriched", "enriched-components.jsonl"), enriched);
    return stats;
  }
}

function ensureNotCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new Error("Qwen isteği kullanıcı tarafından iptal edildi.");
  }
}

async function readLimited(repoRoot: string, relativeFile: string, maxCharacters: number): Promise<string> {
  const filePath = path.resolve(repoRoot, relativeFile);
  if (!ensureWithin(repoRoot, filePath)) {
    return "Not visible from provided context.";
  }
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(repoRoot), fs.realpath(filePath)]);
    if (!ensureWithin(realRoot, realFile)) {
      return "Not visible from provided context.";
    }
    const content = await fs.readFile(realFile, "utf8");
    return content.slice(0, maxCharacters);
  } catch {
    return "Not visible from provided context.";
  }
}
