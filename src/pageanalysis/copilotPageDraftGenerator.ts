import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { RealCopilotClient } from "../ai/copilotClient";
import { CopilotAuditLogger } from "../ai/copilotAuditLogger";
import { DocumentationModelProvider, DocumentationModelResponse, IDocumentationModelClient } from "../ai/documentationModelClient";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { sha256 } from "../utils/hash";
import { buildCopilotPageDraftPrompt } from "./pageTechnicalAnalysisPrompts";
import { buildPageArtifactMetadata, pageMetadataComment } from "./pageArtifactMetadata";

export interface CopilotPageDraftResult {
  draftPath: string;
  contextPath: string;
  contextSelectionPath: string;
  promptPath: string;
  estimatedTotalTokens: number;
}

interface CopilotPageContextBuildResult {
  text: string;
  includedFiles: string[];
  skippedFiles: string[];
  selections: CopilotPageContextSelection[];
  maxCharacters: number;
  maskedSecrets: number;
}

interface CopilotPageContextPart {
  title: string;
  fileName: string;
  content: string;
  sourceCharacters: number;
  weight: number;
}

interface CopilotPageContextSelection {
  fileName: string;
  title: string;
  status: "included" | "omitted-budget" | "skipped-stale" | "disabled" | "missing";
  sourceCharacters: number;
  safeCharacters?: number;
  sentCharacters: number;
  truncated: boolean;
  staleDependencies?: string[];
}

export class CopilotPageDraftGenerator {
  constructor(
    private readonly client: IDocumentationModelClient = new RealCopilotClient(),
    private readonly maxContextCharacters?: number,
    private readonly includeQwenSemanticArtifacts = true
  ) {}

  async generate(multiRepoRoot: string, pageRoot: string, token: vscode.CancellationToken): Promise<CopilotPageDraftResult> {
    await fs.mkdir(pageRoot, { recursive: true });
    const context = await this.buildContext(pageRoot);
    const safe = { text: context.text, maskedSecrets: context.maskedSecrets };
    const prompt = buildCopilotPageDraftPrompt(safe.text);
    const sourceArtifacts = [
      "page-context-pack.md",
      "page-evidence-pack.md"
    ];
    if (this.includeQwenSemanticArtifacts) {
      sourceArtifacts.push("qwen-page-semantics.json", "qwen-interaction-semantics.jsonl");
    }
    const metadata = await buildPageArtifactMetadata(pageRoot, sourceArtifacts);
    const contextPath = path.join(pageRoot, "copilot-draft-context-pack.md");
    const contextSelectionPath = path.join(pageRoot, "copilot-draft-context-selection.json");
    const promptPath = path.join(pageRoot, "copilot-draft-prompt.md");
    const draftPath = path.join(pageRoot, "copilot-draft.md");
    const contextSelection = {
      generatedAt: new Date().toISOString(),
      maxCharacters: context.maxCharacters,
      sourceCharacters: context.selections.reduce((total, item) => total + item.sourceCharacters, 0),
      charactersSent: safe.text.length,
      maskedSecrets: safe.maskedSecrets,
      qwenSemanticArtifactsEnabled: this.includeQwenSemanticArtifacts,
      parts: context.selections
    };
    await fs.writeFile(contextPath, safe.text, "utf8");
    await fs.writeFile(promptPath, prompt.combinedText, "utf8");

    let response: DocumentationModelResponse;
    let responseReceived = false;
    let contextSelectionWritten = false;
    try {
      response = await this.client.send(prompt, token);
      responseReceived = true;
      if (!response.text.trim()) {
        throw new Error(`${resolveProvider(response.provider, this.client.provider)} sayfa taslağı için boş yanıt döndürdü.`);
      }
      const provider = resolveProvider(response.provider, this.client.provider);
      const draftContent = `${pageMetadataComment(metadata)}\n\n${response.text.trim()}\n`;
      await fs.writeFile(draftPath, draftContent, "utf8");
      await fs.writeFile(contextSelectionPath, `${JSON.stringify({
        ...contextSelection,
        draftHash: sha256(draftContent)
      }, null, 2)}\n`, "utf8");
      contextSelectionWritten = true;
      await new CopilotAuditLogger().write(multiRepoRoot, {
        timestamp: new Date().toISOString(),
        docType: "page-analysis-draft",
        repositoryName: metadata.projectName,
        branch: metadata.branch,
        contextPackPath: path.relative(multiRepoRoot, contextPath),
        promptPackPath: path.relative(multiRepoRoot, promptPath),
        contextSelectionPath: path.relative(multiRepoRoot, contextSelectionPath),
        charactersSent: safe.text.length,
        includedIndexes: context.includedFiles,
        skippedIndexes: context.skippedFiles,
        maskedSecrets: safe.maskedSecrets,
        promptProfile: "page-technical-analysis-draft",
        estimatedInputTokens: response.usage.estimatedInputTokens,
        estimatedOutputTokens: response.usage.estimatedOutputTokens,
        estimatedTotalTokens: response.usage.estimatedTotalTokens,
        modelCountedInputTokens: response.usage.modelCountedInputTokens,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        outputCharacters: response.usage.outputCharacters,
        copilotRequestStarted: true,
        copilotResponseReceived: true,
        selectedModelId: response.model.id,
        selectedModelName: response.model.name,
        selectedModelVendor: response.model.vendor,
        selectedModelFamily: response.model.family,
        selectedModelVersion: response.model.version,
        selectedModelMaxInputTokens: response.model.maxInputTokens,
        provider,
        finishReason: response.finishReason,
        requestId: response.requestId,
        modelFamily: provider,
        status: "success"
      });
    } catch (error) {
      try {
        await new CopilotAuditLogger().write(multiRepoRoot, {
          timestamp: new Date().toISOString(),
          docType: "page-analysis-draft",
          repositoryName: metadata.projectName,
          branch: metadata.branch,
          contextPackPath: path.relative(multiRepoRoot, contextPath),
          promptPackPath: path.relative(multiRepoRoot, promptPath),
          contextSelectionPath: contextSelectionWritten
            ? path.relative(multiRepoRoot, contextSelectionPath)
            : undefined,
          charactersSent: safe.text.length,
          includedIndexes: context.includedFiles,
          skippedIndexes: context.skippedFiles,
          maskedSecrets: safe.maskedSecrets,
          promptProfile: "page-technical-analysis-draft",
          copilotRequestStarted: true,
          copilotResponseReceived: responseReceived,
          provider: resolveProvider(undefined, this.client.provider),
          modelFamily: resolveProvider(undefined, this.client.provider),
          status: token.isCancellationRequested ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // Preserve the original provider failure if best-effort auditing fails.
      }
      throw error;
    }

    return {
      draftPath,
      contextPath,
      contextSelectionPath,
      promptPath,
      estimatedTotalTokens: response.usage.estimatedTotalTokens
    };
  }

  private async buildContext(pageRoot: string): Promise<CopilotPageContextBuildResult> {
    const parts = [
      { title: "Page Context Pack", fileName: "page-context-pack.md", dependencies: [], weight: 7, semantic: false },
      { title: "Page Evidence Pack", fileName: "page-evidence-pack.md", dependencies: [], weight: 7, semantic: false },
      { title: "Qwen Page Semantics", fileName: "qwen-page-semantics.json", dependencies: ["page-context-pack.md", "page-evidence-pack.md"], weight: 1, semantic: true },
      { title: "Qwen Interaction Semantics", fileName: "qwen-interaction-semantics.jsonl", dependencies: ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"], weight: 1, semantic: true }
    ] as const;
    const available: CopilotPageContextPart[] = [];
    const skippedFiles: string[] = [];
    const selections: CopilotPageContextSelection[] = [];
    for (const { title, fileName, dependencies, weight, semantic } of parts) {
      if (semantic && !this.includeQwenSemanticArtifacts) {
        selections.push({
          fileName,
          title,
          status: "disabled",
          sourceCharacters: 0,
          sentCharacters: 0,
          truncated: false
        });
        skippedFiles.push(fileName);
        continue;
      }
      const content = await readOptional(path.join(pageRoot, fileName));
      if (content) {
        const staleDependencies = await staleDependenciesFor(pageRoot, fileName, dependencies);
        if (staleDependencies.length) {
          skippedFiles.push(fileName);
          selections.push({
            fileName,
            title,
            status: "skipped-stale",
            sourceCharacters: content.length,
            sentCharacters: 0,
            truncated: false,
            staleDependencies
          });
          continue;
        }
        const safeContent = maskSecretsWithStats(content);
        available.push({
          title,
          fileName,
          content: safeContent.text,
          sourceCharacters: content.length,
          weight
        });
      } else {
        skippedFiles.push(fileName);
        selections.push({
          fileName,
          title,
          status: "missing",
          sourceCharacters: 0,
          sentCharacters: 0,
          truncated: false
        });
      }
    }
    const maxCharacters = this.maxContextCharacters
      ?? vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.maxContextCharacters", 24000);
    const packed = assembleBalancedContext(available, maxCharacters);
    selections.push(...packed.selections);
    return {
      text: packed.text,
      includedFiles: packed.selections
        .filter((item) => item.status === "included" && item.sentCharacters > 0)
        .map((item) => item.fileName),
      skippedFiles,
      selections,
      maxCharacters,
      maskedSecrets: (packed.text.match(/\[MASKED_SECRET\]/g) ?? []).length
    };
  }
}

function resolveProvider(
  responseProvider?: DocumentationModelProvider,
  clientProvider?: DocumentationModelProvider
): DocumentationModelProvider {
  return responseProvider ?? clientProvider ?? "copilot";
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function staleDependenciesFor(pageRoot: string, fileName: string, dependencies: readonly string[]): Promise<string[]> {
  const target = await statOptional(path.join(pageRoot, fileName));
  if (!target) {
    return [];
  }
  const stale: string[] = [];
  for (const dependency of dependencies) {
    const dependencyStat = await statOptional(path.join(pageRoot, dependency));
    if (dependencyStat && target.mtimeMs < dependencyStat.mtimeMs) {
      stale.push(dependency);
    }
  }
  return stale;
}

async function statOptional(filePath: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function assembleBalancedContext(
  parts: CopilotPageContextPart[],
  maxCharacters: number
): { text: string; selections: CopilotPageContextSelection[] } {
  if (maxCharacters <= 0) {
    return { text: "", selections: parts.map((part) => ({
      fileName: part.fileName,
      title: part.title,
      status: "omitted-budget",
      sourceCharacters: part.sourceCharacters,
      safeCharacters: part.content.length,
      sentCharacters: 0,
      truncated: part.content.length > 0
    })) };
  }
  const separator = "\n\n---\n\n";
  const headers = parts.map((part) => `## ${part.title}\n`);
  const overhead = headers.reduce((total, header) => total + header.length, 0)
    + Math.max(0, parts.length - 1) * separator.length;
  if (!parts.length) {
    return { text: "", selections: [] };
  }
  if (overhead >= maxCharacters) {
    const headingsOnly = parts.map((part) => `## ${part.title}`).join(separator).slice(0, maxCharacters);
    return {
      text: headingsOnly,
      selections: parts.map((part) => ({
        fileName: part.fileName,
        title: part.title,
        status: "omitted-budget",
        sourceCharacters: part.sourceCharacters,
        safeCharacters: part.content.length,
        sentCharacters: 0,
        truncated: part.content.length > 0
      }))
    };
  }

  const allocations = allocateWeightedCharacters(
    parts.map((part) => part.content.length),
    parts.map((part) => part.weight),
    maxCharacters - overhead
  );
  const rendered: string[] = [];
  const selections: CopilotPageContextSelection[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const selected = part.fileName.endsWith(".md")
      ? selectBalancedMarkdown(part.content, allocations[index])
      : boundedExcerpt(part.content, allocations[index], "SEMANTIC_CONTEXT_CLIPPED");
    rendered.push(`${headers[index]}${selected}`);
    selections.push({
      fileName: part.fileName,
      title: part.title,
      status: selected.length ? "included" : "omitted-budget",
      sourceCharacters: part.sourceCharacters,
      safeCharacters: part.content.length,
      sentCharacters: selected.length,
      truncated: selected.length < part.content.length
    });
  }
  const text = rendered.join(separator);
  if (text.length > maxCharacters) {
    throw new Error(`Balanced Copilot page context exceeded its ${maxCharacters} character ceiling.`);
  }
  return { text, selections };
}

function allocateWeightedCharacters(capacities: number[], weights: number[], budget: number): number[] {
  const allocations = capacities.map(() => 0);
  if (budget <= 0 || !capacities.length) {
    return allocations;
  }
  let remaining = budget;
  const minimum = Math.min(192, Math.floor(budget / capacities.length));
  for (let index = 0; index < capacities.length && remaining > 0; index += 1) {
    const granted = Math.min(capacities[index], minimum, remaining);
    allocations[index] += granted;
    remaining -= granted;
  }

  let active = capacities.map((capacity, index) => ({ index, capacity: capacity - allocations[index] }))
    .filter((item) => item.capacity > 0);
  while (remaining > 0 && active.length) {
    const totalWeight = active.reduce((total, item) => total + Math.max(1, weights[item.index]), 0);
    const saturating = active.find((item) =>
      item.capacity <= Math.floor(remaining * Math.max(1, weights[item.index]) / totalWeight)
    );
    if (saturating) {
      allocations[saturating.index] += saturating.capacity;
      remaining -= saturating.capacity;
      active = active.filter((item) => item !== saturating);
      continue;
    }
    let unassigned = remaining;
    for (let position = 0; position < active.length; position += 1) {
      const item = active[position];
      const granted = position === active.length - 1
        ? unassigned
        : Math.floor(remaining * Math.max(1, weights[item.index]) / totalWeight);
      const bounded = Math.min(item.capacity, granted);
      allocations[item.index] += bounded;
      unassigned -= bounded;
    }
    remaining = unassigned;
    active = active
      .map((item) => ({ ...item, capacity: capacities[item.index] - allocations[item.index] }))
      .filter((item) => item.capacity > 0);
    if (unassigned === remaining && unassigned > 0 && active.length) {
      allocations[active[0].index] += 1;
      remaining -= 1;
    }
  }
  return allocations;
}

function selectBalancedMarkdown(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }
  if (maxCharacters <= 0) {
    return "";
  }
  const sections = splitMarkdownSections(content)
    .filter((section) => !/^\s{0,3}#{1,3}\s+(?:Artifact Metadata|Metadata)\s*$/i.test(section.split(/\r?\n/, 1)[0]));
  if (sections.length <= 1) {
    return boundedExcerpt(content, maxCharacters, "SECTION_CLIPPED");
  }
  const separator = "\n\n";
  const sectionBudget = Math.max(0, maxCharacters - (sections.length - 1) * separator.length);
  const allocations = allocateWeightedCharacters(
    sections.map((section) => section.length),
    sections.map(markdownSectionWeight),
    sectionBudget
  );
  const rendered = sections
    .map((section, index) => boundedMarkdownSection(section, allocations[index]))
    .filter(Boolean)
    .join(separator);
  return rendered.length <= maxCharacters ? rendered : rendered.slice(0, maxCharacters);
}

function splitMarkdownSections(content: string): string[] {
  const matches = markdownHeadingsOutsideFences(content);
  if (!matches.length) {
    return [content];
  }
  const sections: string[] = [];
  const preamble = content.slice(0, matches[0]).trim();
  if (preamble) {
    sections.push(preamble);
  }
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index];
    const end = matches[index + 1] ?? content.length;
    const section = content.slice(start, end).trim();
    if (section) {
      sections.push(section);
    }
  }
  return sections;
}

function markdownHeadingsOutsideFences(content: string): number[] {
  const headings: number[] = [];
  let offset = 0;
  let fence: { character: "`" | "~"; length: number } | undefined;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const end = newline < 0 ? content.length : newline + 1;
    const line = content.slice(offset, newline < 0 ? content.length : newline).replace(/\r$/, "");
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const character = marker[0] as "`" | "~";
      if (!fence) {
        fence = { character, length: marker.length };
      } else if (fence.character === character && marker.length >= fence.length) {
        fence = undefined;
      }
    } else if (!fence && /^\s{0,3}#{1,3}\s+.+$/.test(line)) {
      headings.push(offset);
    }
    offset = end;
  }
  return headings;
}

function markdownSectionWeight(section: string): number {
  const heading = section.split(/\r?\n/, 1)[0].toLowerCase();
  if (/(bff|feign|outbound|client)/.test(heading)) {
    return 6;
  }
  if (/(backend|\bbe\b|repository|entity|dto|validation)/.test(heading)) {
    return 6;
  }
  if (/(flow|esles|match|trace|api)/.test(heading)) {
    return 5;
  }
  if (/(react|\bui\b|route|component|interaction|form|state)/.test(heading)) {
    return 4;
  }
  return 2;
}

function boundedMarkdownSection(section: string, maxCharacters: number): string {
  if (section.length <= maxCharacters) {
    return section;
  }
  if (maxCharacters <= 0) {
    return "";
  }
  const newline = section.indexOf("\n");
  if (newline < 0 || newline + 1 >= maxCharacters) {
    return section.slice(0, maxCharacters);
  }
  const heading = section.slice(0, newline + 1);
  return `${heading}${boundedExcerpt(section.slice(newline + 1), maxCharacters - heading.length, "SECTION_CLIPPED")}`;
}

function boundedExcerpt(content: string, maxCharacters: number, marker: string): string {
  if (content.length <= maxCharacters) {
    return content;
  }
  if (maxCharacters <= 0) {
    return "";
  }
  const notice = `\n[${marker}]\n`;
  if (maxCharacters <= notice.length + 2) {
    return content.slice(0, maxCharacters);
  }
  const usable = maxCharacters - notice.length;
  const head = Math.ceil(usable * 0.6);
  return `${content.slice(0, head)}${notice}${content.slice(content.length - (usable - head))}`;
}
