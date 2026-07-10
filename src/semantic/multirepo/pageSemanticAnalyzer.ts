import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { QwenClient } from "../../ai/qwenClient";
import { QwenSettingsService } from "../../ai/qwenSettingsService";
import { parseStrictJson } from "../semanticCacheService";
import { readJsonl, writeJsonl } from "../../storage/jsonlWriter";
import { sha256 } from "../../utils/hash";
import { safeName } from "../../utils/pathUtils";
import { buildPageFlowSemanticPrompt, buildUiInteractionSemanticPrompt } from "./crossLayerSemanticPrompts";
import { MultiRepoSemanticCacheService } from "./multiRepoSemanticCacheService";
import { MultiRepoManifest } from "../../multirepo/multiRepoManifestService";

interface PageFlowRecord {
  page: string;
  route?: string;
  interaction?: string;
  uiHandler?: string;
  uiApiCall: string;
  bffEndpoint?: string;
  bffFlow: string[];
  beEndpoint?: string;
  beFlow: string[];
  confidence: string;
  uncertainties: string[];
}

interface UiToBffRecord {
  uiApiCall: string;
  uiApiFile: string;
  bffEndpoint?: string;
  bffController?: string;
  bffHandler?: string;
  bffFile?: string;
  confidence: string;
  matchReason: string;
}

interface BffToBeRecord {
  bffEndpoint: string;
  bffController: string;
  bffHandler: string;
  bffOutboundCall?: string;
  bffClient?: string;
  beEndpoint?: string;
  beController?: string;
  beHandler?: string;
  confidence: string;
  matchReason: string;
}

interface InteractionRecord {
  page?: string;
  component: string;
  label: string;
  handler: string;
  file: string;
}

export interface MultiRepoSemanticStats {
  interactionsAnalyzed: number;
  interactionCacheHits: number;
  pageFlowsAnalyzed: number;
  pageFlowCacheHits: number;
  failures: number;
}

export class PageSemanticAnalyzer {
  async analyze(multiRepoRoot: string, context: vscode.ExtensionContext, manifest?: MultiRepoManifest, token?: vscode.CancellationToken): Promise<MultiRepoSemanticStats> {
    const settings = new QwenSettingsService(context).getSettings();
    const client = new QwenClient(new QwenSettingsService(context));
    const cache = new MultiRepoSemanticCacheService(multiRepoRoot, settings.model);
    const maxItems = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("semantic.maxFilesPerRun", 50);
    const maxSourceCharacters = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("semantic.maxCharactersPerFile", 20000);
    const interactions = (await readJsonl<InteractionRecord>(path.join(multiRepoRoot, "ui", "interaction-index.jsonl"))).slice(0, maxItems);
    const pageFlows = (await readJsonl<PageFlowRecord>(path.join(multiRepoRoot, "traceability", "page-flows.jsonl"))).slice(0, maxItems);
    const uiToBff = await readJsonl<UiToBffRecord>(path.join(multiRepoRoot, "traceability", "ui-to-bff.jsonl"));
    const bffToBe = await readJsonl<BffToBeRecord>(path.join(multiRepoRoot, "traceability", "bff-to-be.jsonl"));
    const stats: MultiRepoSemanticStats = {
      interactionsAnalyzed: 0,
      interactionCacheHits: 0,
      pageFlowsAnalyzed: 0,
      pageFlowCacheHits: 0,
      failures: 0
    };

    const interactionOutputs: unknown[] = [];
    for (const interaction of interactions) {
      if (token?.isCancellationRequested) {
        break;
      }
      try {
        const identity = `${interaction.page ?? interaction.component}-${interaction.handler}-${interaction.label}`;
        const contextPayload = await this.buildInteractionContext(interaction, manifest, maxSourceCharacters);
        const contextText = JSON.stringify(contextPayload, null, 2);
        const sourceHash = sha256(contextText);
        const cacheKey = cache.buildCacheKey(identity, sourceHash);
        const cached = await cache.read("ui-interactions", identity, cacheKey);
        if (cached) {
          stats.interactionCacheHits += 1;
          interactionOutputs.push(cached);
          continue;
        }

        await this.writeContextPack(multiRepoRoot, "interactions", identity, contextText);
        const raw = await client.ask(buildUiInteractionSemanticPrompt(contextText), token);
        const parsed = parseStrictJson(raw);
        await cache.write("ui-interactions", identity, cacheKey, parsed);
        interactionOutputs.push(parsed);
        stats.interactionsAnalyzed += 1;
      } catch {
        stats.failures += 1;
      }
    }

    const pageFlowOutputs: unknown[] = [];
    for (const flow of pageFlows) {
      if (token?.isCancellationRequested) {
        break;
      }
      try {
        const identity = `${flow.page}-${flow.route ?? "no-route"}-${flow.uiApiCall}`;
        const contextPayload = await this.buildPageFlowContext(flow, uiToBff, bffToBe, manifest, maxSourceCharacters);
        const contextText = JSON.stringify(contextPayload, null, 2);
        const sourceHash = sha256(contextText);
        const cacheKey = cache.buildCacheKey(identity, sourceHash);
        const cached = await cache.read("page-flows", identity, cacheKey);
        if (cached) {
          stats.pageFlowCacheHits += 1;
          pageFlowOutputs.push(cached);
          continue;
        }

        await this.writeContextPack(multiRepoRoot, "page-flows", identity, contextText);
        const raw = await client.ask(buildPageFlowSemanticPrompt(contextText), token);
        const parsed = parseStrictJson(raw);
        await cache.write("page-flows", identity, cacheKey, parsed);
        pageFlowOutputs.push(parsed);
        stats.pageFlowsAnalyzed += 1;
      } catch {
        stats.failures += 1;
      }
    }

    await writeJsonl(path.join(multiRepoRoot, "ui", "semantic", "interaction-semantics.jsonl"), interactionOutputs);
    await writeJsonl(path.join(multiRepoRoot, "traceability", "semantic", "page-flow-semantics.jsonl"), pageFlowOutputs);
    return stats;
  }

  private async writeContextPack(multiRepoRoot: string, kind: string, identity: string, contextText: string): Promise<void> {
    const target = path.join(multiRepoRoot, "context-packs", "pages", `${kind}-${safeName(identity)}-${Date.now()}.json`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contextText, "utf8");
  }

  private async buildInteractionContext(interaction: InteractionRecord, manifest: MultiRepoManifest | undefined, maxCharacters: number): Promise<unknown> {
    return {
      extraction: interaction,
      selectedSourceSnippets: [
        await this.readSnippet(manifest?.repos.ui.localPath, interaction.file, interaction.handler, maxCharacters)
      ].filter(Boolean),
      contextPolicy: "Selected source snippets only. Full repository was not sent."
    };
  }

  private async buildPageFlowContext(
    flow: PageFlowRecord,
    uiToBff: UiToBffRecord[],
    bffToBe: BffToBeRecord[],
    manifest: MultiRepoManifest | undefined,
    maxCharacters: number
  ): Promise<unknown> {
    const uiMatch = uiToBff.find((match) => match.uiApiCall === flow.uiApiCall);
    const beMatch = bffToBe.find((match) => match.bffEndpoint === flow.bffEndpoint || match.beEndpoint === flow.beEndpoint);
    return {
      pageFlow: flow,
      uiToBffMatch: uiMatch,
      bffToBeMatch: beMatch,
      selectedSourceSnippets: [
        await this.readSnippet(manifest?.repos.ui.localPath, uiMatch?.uiApiFile, flow.uiHandler || flow.uiApiCall, maxCharacters),
        await this.readSnippet(manifest?.repos.bff.localPath, uiMatch?.bffFile, uiMatch?.bffHandler || uiMatch?.bffController, maxCharacters)
      ].filter(Boolean),
      contextPolicy: "Selected source snippets only. Full UI, BFF, and BE repositories were not sent."
    };
  }

  private async readSnippet(repoRoot: string | undefined, relativeFile: string | undefined, focus: string | undefined, maxCharacters: number): Promise<unknown | undefined> {
    if (!repoRoot || !relativeFile) {
      return undefined;
    }
    try {
      const content = await fs.readFile(path.join(repoRoot, relativeFile), "utf8");
      const snippet = this.focusedSnippet(content, focus, maxCharacters);
      return {
        file: relativeFile,
        focus: focus || "",
        characters: snippet.length,
        content: snippet
      };
    } catch {
      return undefined;
    }
  }

  private focusedSnippet(content: string, focus: string | undefined, maxCharacters: number): string {
    if (content.length <= maxCharacters) {
      return content;
    }
    const normalizedFocus = focus?.replace(/\(.*$/, "").replace(/[^A-Za-z0-9_]/g, "").trim();
    const focusIndex = normalizedFocus ? content.indexOf(normalizedFocus) : -1;
    if (focusIndex >= 0) {
      const half = Math.floor(maxCharacters / 2);
      const start = Math.max(0, focusIndex - half);
      const end = Math.min(content.length, start + maxCharacters);
      return content.slice(start, end);
    }
    return content.slice(0, maxCharacters);
  }
}
