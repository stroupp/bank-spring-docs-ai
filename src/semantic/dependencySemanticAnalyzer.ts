import * as path from "path";
import * as vscode from "vscode";
import { QwenClient } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { readJsonl, writeJsonl } from "../storage/jsonlWriter";
import { sha256 } from "../utils/hash";
import { buildDependencySemanticPrompt } from "./qwenSemanticPrompts";
import { SemanticRunStats } from "./classSemanticAnalyzer";
import { parseStrictJson, SemanticCacheService } from "./semanticCacheService";

type DependencyEdge = { from: string; to: string; relation: string; file: string };

export class DependencySemanticAnalyzer {
  async analyze(aiDocsPath: string, context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<SemanticRunStats> {
    const settings = vscode.workspace.getConfiguration("bankSpringDocs");
    const maxItems = settings.get<number>("semantic.maxFilesPerRun", 50);
    const cacheEnabled = settings.get<boolean>("semantic.cacheEnabled", true);
    const qwenSettings = new QwenSettingsService(context);
    const qwen = new QwenClient(qwenSettings);
    const cache = new SemanticCacheService(aiDocsPath, qwenSettings.getSettings().model);
    const dependencies = (await readJsonl<DependencyEdge>(path.join(aiDocsPath, "dependency-graph.jsonl"))).slice(0, maxItems);
    const enriched: unknown[] = [];
    const stats: SemanticRunStats = { analyzed: 0, cacheHits: 0, failures: 0 };

    for (const dependency of dependencies) {
      const identity = `${dependency.from}:${dependency.to}:${dependency.relation}:${dependency.file}`;
      try {
        const contextPayload = JSON.stringify({ dependency }, null, 2);
        const cacheKey = cache.buildCacheKey(identity, sha256(contextPayload));
        const cached = cacheEnabled ? await cache.read("dependencies", identity, cacheKey) : undefined;
        if (cached) {
          enriched.push(cached);
          stats.cacheHits += 1;
          continue;
        }
        const raw = await qwen.ask(buildDependencySemanticPrompt(contextPayload), token);
        const parsed = parseStrictJson(raw);
        await cache.write("dependencies", identity, cacheKey, parsed);
        enriched.push(parsed);
        stats.analyzed += 1;
      } catch (error) {
        stats.failures += 1;
        await cache.writeDebug(identity, error instanceof Error ? error.message : String(error));
      }
    }

    await writeJsonl(path.join(aiDocsPath, "enriched", "enriched-dependencies.jsonl"), enriched);
    return stats;
  }
}
