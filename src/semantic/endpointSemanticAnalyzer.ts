import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { QwenClient } from "../ai/qwenClient";
import { QwenSettingsService } from "../ai/qwenSettingsService";
import { readJsonl, writeJsonl } from "../storage/jsonlWriter";
import { sha256 } from "../utils/hash";
import { buildEndpointSemanticPrompt } from "./qwenSemanticPrompts";
import { SemanticRunStats } from "./classSemanticAnalyzer";
import { parseStrictJson, SemanticCacheService } from "./semanticCacheService";

type EndpointIndex = { httpMethod: string; path: string; className: string; handlerMethod: string; file: string };
type DependencyEdge = { from: string; to: string; relation: string; file: string };

export class EndpointSemanticAnalyzer {
  async analyze(repoRoot: string, aiDocsPath: string, context: vscode.ExtensionContext, token?: vscode.CancellationToken): Promise<SemanticRunStats> {
    const settings = vscode.workspace.getConfiguration("bankSpringDocs");
    const maxItems = settings.get<number>("semantic.maxFilesPerRun", 50);
    const maxCharacters = settings.get<number>("semantic.maxCharactersPerFile", 20000);
    const cacheEnabled = settings.get<boolean>("semantic.cacheEnabled", true);
    const qwenSettings = new QwenSettingsService(context);
    const qwen = new QwenClient(qwenSettings);
    const cache = new SemanticCacheService(aiDocsPath, qwenSettings.getSettings().model);
    const endpoints = (await readJsonl<EndpointIndex>(path.join(aiDocsPath, "api-endpoints.jsonl"))).slice(0, maxItems);
    const dependencies = await readJsonl<DependencyEdge>(path.join(aiDocsPath, "dependency-graph.jsonl"));
    const enriched: unknown[] = [];
    const stats: SemanticRunStats = { analyzed: 0, cacheHits: 0, failures: 0 };

    for (const endpoint of endpoints) {
      const identity = `${endpoint.httpMethod}:${endpoint.path}:${endpoint.className}.${endpoint.handlerMethod}`;
      try {
        const relevantDependencies = dependencies.filter((edge) => edge.from === endpoint.className).slice(0, 20);
        const sourceSnippet = await readEndpointSnippet(path.join(repoRoot, endpoint.file), endpoint.handlerMethod, maxCharacters);
        const contextPayload = JSON.stringify({ endpoint, dependencies: relevantDependencies, sourceSnippet }, null, 2);
        const cacheKey = cache.buildCacheKey(identity, sha256(contextPayload));
        const cached = cacheEnabled ? await cache.read("endpoints", identity, cacheKey) : undefined;
        if (cached) {
          enriched.push(cached);
          stats.cacheHits += 1;
          continue;
        }
        const raw = await qwen.ask(buildEndpointSemanticPrompt(contextPayload), token);
        const parsed = parseStrictJson(raw);
        await cache.write("endpoints", identity, cacheKey, parsed);
        enriched.push(parsed);
        stats.analyzed += 1;
      } catch (error) {
        stats.failures += 1;
        await cache.writeDebug(identity, error instanceof Error ? error.message : String(error));
      }
    }

    await writeJsonl(path.join(aiDocsPath, "enriched", "enriched-endpoints.jsonl"), enriched);
    return stats;
  }
}

async function readEndpointSnippet(filePath: string, methodName: string, maxCharacters: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const nameIndex = content.search(new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`));
    if (nameIndex < 0) {
      return content.slice(0, maxCharacters);
    }

    const annotationStart = findAnnotationStart(content, nameIndex);
    const openBrace = content.indexOf("{", nameIndex);
    if (openBrace < 0) {
      return content.slice(annotationStart, Math.min(content.length, nameIndex + maxCharacters));
    }

    const closeBrace = findMatchingBrace(content, openBrace);
    const end = closeBrace > openBrace ? closeBrace + 1 : Math.min(content.length, openBrace + maxCharacters);
    return content.slice(annotationStart, end).slice(0, maxCharacters);
  } catch {
    return "Not visible from provided context.";
  }
}

function findAnnotationStart(content: string, methodNameIndex: number): number {
  const windowStart = Math.max(0, methodNameIndex - 2000);
  const before = content.slice(windowStart, methodNameIndex);
  const annotationMatch = [...before.matchAll(/^\s*@[A-Za-z0-9_.]+/gm)].pop();
  return annotationMatch ? windowStart + annotationMatch.index! : Math.max(0, methodNameIndex - 500);
}

function findMatchingBrace(content: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < content.length; index++) {
    const char = content[index];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
