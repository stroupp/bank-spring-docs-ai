import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { CopilotResponseWithUsage, ICopilotClient, RealCopilotClient } from "../ai/copilotClient";
import { CopilotAuditLogger } from "../ai/copilotAuditLogger";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { buildCopilotPageDraftPrompt } from "./pageTechnicalAnalysisPrompts";
import { buildPageArtifactMetadata, pageMetadataComment } from "./pageArtifactMetadata";

export interface CopilotPageDraftResult {
  draftPath: string;
  contextPath: string;
  promptPath: string;
  estimatedTotalTokens: number;
}

interface CopilotPageContextBuildResult {
  text: string;
  includedFiles: string[];
  skippedFiles: string[];
}

export class CopilotPageDraftGenerator {
  constructor(
    private readonly client: ICopilotClient = new RealCopilotClient(),
    private readonly maxContextCharacters?: number
  ) {}

  async generate(multiRepoRoot: string, pageRoot: string, token: vscode.CancellationToken): Promise<CopilotPageDraftResult> {
    await fs.mkdir(pageRoot, { recursive: true });
    const context = await this.buildContext(pageRoot);
    const safe = maskSecretsWithStats(context.text);
    const prompt = buildCopilotPageDraftPrompt(safe.text);
    const metadata = await buildPageArtifactMetadata(pageRoot, [
      "page-context-pack.md",
      "page-evidence-pack.md",
      "qwen-page-semantics.json",
      "qwen-interaction-semantics.jsonl"
    ]);
    const contextPath = path.join(pageRoot, "copilot-draft-context-pack.md");
    const promptPath = path.join(pageRoot, "copilot-draft-prompt.md");
    const draftPath = path.join(pageRoot, "copilot-draft.md");
    await fs.writeFile(contextPath, safe.text, "utf8");
    await fs.writeFile(promptPath, prompt.combinedText, "utf8");

    let response: CopilotResponseWithUsage;
    try {
      response = await this.client.send(prompt, token);
      await fs.writeFile(draftPath, `${pageMetadataComment(metadata)}\n\n${response.text.trim()}\n`, "utf8");
      await new CopilotAuditLogger().write(multiRepoRoot, {
        timestamp: new Date().toISOString(),
        docType: "page-analysis-draft",
        repositoryName: metadata.projectName,
        branch: metadata.branch,
        contextPackPath: path.relative(multiRepoRoot, contextPath),
        promptPackPath: path.relative(multiRepoRoot, promptPath),
        charactersSent: safe.text.length,
        includedIndexes: context.includedFiles,
        skippedIndexes: context.skippedFiles,
        maskedSecrets: safe.maskedSecrets,
        promptProfile: "page-technical-analysis-draft",
        estimatedInputTokens: response.usage.estimatedInputTokens,
        estimatedOutputTokens: response.usage.estimatedOutputTokens,
        estimatedTotalTokens: response.usage.estimatedTotalTokens,
        modelCountedInputTokens: response.usage.modelCountedInputTokens,
        outputCharacters: response.usage.outputCharacters,
        copilotRequestStarted: true,
        copilotResponseReceived: true,
        selectedModelId: response.model.id,
        selectedModelName: response.model.name,
        selectedModelVendor: response.model.vendor,
        selectedModelFamily: response.model.family,
        selectedModelVersion: response.model.version,
        selectedModelMaxInputTokens: response.model.maxInputTokens,
        modelFamily: "copilot",
        status: "success"
      });
    } catch (error) {
      await new CopilotAuditLogger().write(multiRepoRoot, {
        timestamp: new Date().toISOString(),
        docType: "page-analysis-draft",
        repositoryName: metadata.projectName,
        branch: metadata.branch,
        contextPackPath: path.relative(multiRepoRoot, contextPath),
        promptPackPath: path.relative(multiRepoRoot, promptPath),
        charactersSent: safe.text.length,
        includedIndexes: context.includedFiles,
        skippedIndexes: context.skippedFiles,
        maskedSecrets: safe.maskedSecrets,
        promptProfile: "page-technical-analysis-draft",
        copilotRequestStarted: true,
        copilotResponseReceived: false,
        modelFamily: "copilot",
        status: token.isCancellationRequested ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    return {
      draftPath,
      contextPath,
      promptPath,
      estimatedTotalTokens: response.usage.estimatedTotalTokens
    };
  }

  private async buildContext(pageRoot: string): Promise<CopilotPageContextBuildResult> {
    const parts = [
      { title: "Page Context Pack", fileName: "page-context-pack.md", dependencies: [] },
      { title: "Page Evidence Pack", fileName: "page-evidence-pack.md", dependencies: [] },
      { title: "Qwen Page Semantics", fileName: "qwen-page-semantics.json", dependencies: ["page-context-pack.md", "page-evidence-pack.md"] },
      { title: "Qwen Interaction Semantics", fileName: "qwen-interaction-semantics.jsonl", dependencies: ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"] }
    ] as const;
    const sections: string[] = [];
    const skippedSections: string[] = [];
    const includedFiles: string[] = [];
    const skippedFiles: string[] = [];
    for (const { title, fileName, dependencies } of parts) {
      const content = await readOptional(path.join(pageRoot, fileName));
      if (content) {
        const staleDependencies = await staleDependenciesFor(pageRoot, fileName, dependencies);
        if (staleDependencies.length) {
          skippedFiles.push(fileName);
          skippedSections.push(`## ${title} Skipped\n${fileName} is older than: ${staleDependencies.join(", ")}. Regenerate this artifact before using it as Copilot context.`);
          continue;
        }
        includedFiles.push(fileName);
        sections.push(`## ${title}\n${content}`);
      }
    }
    const allSections = [...skippedSections, ...sections];
    return {
      text: applyBudget(
        allSections.join("\n\n---\n\n"),
        this.maxContextCharacters ?? vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.maxContextCharacters", 24000)
      ),
      includedFiles,
      skippedFiles
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

function applyBudget(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) {
    return "";
  }
  if (value.length <= maxCharacters) {
    return value;
  }
  const marker = "\n[PAGE_CONTEXT_TRUNCATED_FOR_COPILOT_TOKEN_LIMIT]";
  if (maxCharacters <= marker.length) {
    return marker.slice(0, maxCharacters);
  }
  return `${value.slice(0, maxCharacters - marker.length)}${marker}`;
}
