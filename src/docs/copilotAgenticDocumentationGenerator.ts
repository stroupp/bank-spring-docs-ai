import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { RealCopilotClient } from "../ai/copilotClient";
import { CopilotAuditLogger } from "../ai/copilotAuditLogger";
import {
  DocumentationModelInfo,
  DocumentationModelProvider,
  DocumentationModelResponse,
  DocumentationModelUsage,
  IDocumentationModelClient
} from "../ai/documentationModelClient";
import { buildCopilotAgenticPrompt, CopilotAgenticStep } from "../ai/prompts";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { readJsonl } from "../storage/jsonlWriter";
import { buildFocusedSourceContext, FocusedSourceIndex } from "./focusedSourceContext";
import { MarkdownWriter } from "./markdownWriter";

export interface CopilotAgenticProgress {
  step: CopilotAgenticStep;
  stepIndex: number;
  totalSteps: number;
  stepLabel: string;
  phase: "started" | "streaming" | "completed";
  message: string;
  usage?: DocumentationModelUsage;
}

export interface CopilotAgenticResult {
  finalDocumentPath: string;
  workspaceRoot: string;
  stepArtifacts: string[];
  requestCount: number;
  estimatedTotalTokens: number;
}

const steps: CopilotAgenticStep[] = [
  "plan",
  "api-analysis",
  "service-flow-analysis",
  "data-config-error-analysis",
  "diagram-drafts",
  "final-synthesis"
];

const stepLabels: Record<CopilotAgenticStep, string> = {
  plan: "Plan olusturma",
  "api-analysis": "API endpoint analizi",
  "service-flow-analysis": "Servis ve is akisi analizi",
  "data-config-error-analysis": "Veri, konfig ve hata analizi",
  "diagram-drafts": "PlantUML diyagram taslaklari",
  "final-synthesis": "Final dokuman sentezi"
};

export class CopilotAgenticDocumentationGenerator {
  constructor(
    private readonly markdownWriter = new MarkdownWriter(),
    private readonly client: IDocumentationModelClient = new RealCopilotClient()
  ) {}

  async generate(
    aiDocsPath: string,
    repositoryName: string,
    branch: string,
    token: vscode.CancellationToken,
    onProgress?: (progress: CopilotAgenticProgress) => void
  ): Promise<CopilotAgenticResult> {
    const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const workspaceRoot = path.join(aiDocsPath, "copilot-workspace", "agentic", runId);
    await fs.mkdir(workspaceRoot, { recursive: true });

    const stepArtifacts: string[] = [];
    const previousOutputs: string[] = [];
    let estimatedTotalTokens = 0;
    let finalBody = "";
    let finalModel: DocumentationModelInfo | undefined;
    let finalProvider = resolveProvider(undefined, this.client.provider);

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const stepIndex = index + 1;
      const stepLabel = stepLabels[step];
      if (token.isCancellationRequested) {
        throw new Error(`${providerDisplayName(finalProvider)} agentic analysis was cancelled.`);
      }

      onProgress?.({
        step,
        stepIndex,
        totalSteps: steps.length,
        stepLabel,
        phase: "started",
        message: `Adim ${stepIndex}/${steps.length} - ${stepLabel} baslatildi`
      });
      const rawContext = await this.buildContextForStep(aiDocsPath, step, previousOutputs);
      const previousContext = this.previousArtifactsContext(previousOutputs, step);
      const promptRequest = buildCopilotAgenticPrompt(step, rawContext.safeText, previousContext);
      const promptPath = await this.writeArtifact(workspaceRoot, `${step}-prompt.md`, promptRequest.combinedText);
      const contextPath = await this.writeArtifact(workspaceRoot, `${step}-context.md`, rawContext.safeText);

      const requestStartedAt = Date.now();
      let response: DocumentationModelResponse;
      let responseReceived = false;
      try {
        response = await this.client.send(promptRequest, token, (usage) => {
          onProgress?.({
            step,
            stepIndex,
            totalSteps: steps.length,
            stepLabel,
            phase: "streaming",
            message: `Adim ${stepIndex}/${steps.length} - ${stepLabel}: yaklasik ${usage.estimatedTotalTokens} token`,
            usage
          });
        });
        responseReceived = true;
        if (!response.text.trim()) {
          throw new Error(`${providerDisplayName(resolveProvider(response.provider, this.client.provider))} returned an empty response for agentic step: ${step}.`);
        }
      } catch (error) {
        await this.auditFailedStep(aiDocsPath, {
          step,
          repositoryName,
          branch,
          contextPath,
          promptPath,
          charactersSent: rawContext.safeText.length,
          includedIndexes: rawContext.includedIndexes,
          maskedSecrets: rawContext.maskedSecrets,
          provider: resolveProvider(undefined, this.client.provider),
          durationMs: Date.now() - requestStartedAt,
          responseReceived,
          cancelled: token.isCancellationRequested,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      finalProvider = resolveProvider(response.provider, this.client.provider);
      finalModel = response.model;
      estimatedTotalTokens += response.usage.estimatedTotalTokens;
      const outputPath = await this.writeArtifact(workspaceRoot, `${step}.md`, response.text);
      stepArtifacts.push(outputPath);
      previousOutputs.push(`# ${step}\n\n${response.text}`);
      if (step === "final-synthesis") {
        finalBody = response.text;
      }

      onProgress?.({
        step,
        stepIndex,
        totalSteps: steps.length,
        stepLabel,
        phase: "completed",
        message: `Adim ${stepIndex}/${steps.length} - ${stepLabel} tamamlandi`,
        usage: response.usage
      });

      await this.auditStep(aiDocsPath, {
        step,
        repositoryName,
        branch,
        contextPath,
        promptPath,
        charactersSent: rawContext.safeText.length,
        includedIndexes: rawContext.includedIndexes,
        maskedSecrets: rawContext.maskedSecrets,
        usage: response.usage,
        model: response.model,
        provider: finalProvider,
        finishReason: response.finishReason,
        requestId: response.requestId
      });
    }

    const finalDocumentPath = await this.markdownWriter.write(
      aiDocsPath,
      `agentic-backend-technical-analysis-${runId}.md`,
      "Agentic Backend Technical Analysis",
      repositoryName,
      branch,
      finalBody || previousOutputs.join("\n\n---\n\n"),
      path.join("copiloted-generated-docs", "agentic"),
      modelAttribution(finalProvider, finalModel?.name)
    );

    await this.writeRunSummary(workspaceRoot, {
      repositoryName,
      branch,
      runId,
      finalDocumentPath,
      stepArtifacts,
      estimatedTotalTokens,
      provider: finalProvider,
      modelName: finalModel?.name
    });

    return {
      finalDocumentPath,
      workspaceRoot,
      stepArtifacts,
      requestCount: steps.length,
      estimatedTotalTokens
    };
  }

  private async buildContextForStep(aiDocsPath: string, step: CopilotAgenticStep, previousOutputs: string[]): Promise<{
    safeText: string;
    includedIndexes: string[];
    maskedSecrets: number;
  }> {
    const repoRoot = path.dirname(aiDocsPath);
    const sections: string[] = [];
    const includedIndexes = new Set<string>();
    const addIndex = async (relativePath: string, maxCharacters: number): Promise<void> => {
      const content = await readJsonlContent(path.join(aiDocsPath, relativePath), maxCharacters);
      sections.push(section(relativePath, content));
      includedIndexes.add(relativePath);
    };
    const addText = async (relativePath: string, maxCharacters: number): Promise<void> => {
      const content = await readTextContent(path.join(aiDocsPath, relativePath), maxCharacters);
      sections.push(section(relativePath, content));
      includedIndexes.add(relativePath);
    };
    const addSources = async (title: string, patterns: RegExp[], maxFileCharacters: number): Promise<void> => {
      const source = await sourceFilesSection(repoRoot, patterns, maxFileCharacters);
      sections.push(section(title, source.content));
      source.files.forEach((file) => includedIndexes.add(file));
    };

    await addText("manifest.json", 8000);
    await addText("repo-map.md", 30000);
    await addLocalDocs(step);
    await addFocusedSources("Focused Source Evidence", this.focusedIndexesForStep(aiDocsPath, step), previousOutputs, 9000, 90000);

    if (step === "plan" || step === "final-synthesis" || step === "diagram-drafts") {
      await addIndex("api-endpoints.jsonl", 80000);
      await addIndex("spring-components.jsonl", 80000);
      await addIndex("entity-index.jsonl", 50000);
      await addIndex("configuration-index.jsonl", 30000);
      await addIndex("test-index.jsonl", 30000);
      await addSources("Critical Source Files", [
        /src[\\/]+main[\\/]+java[\\/].*[\\/]controller[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+java[\\/].*[\\/]security[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+java[\\/].*[\\/]config[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+resources[\\/]+application\.(properties|ya?ml)$/i
      ], 18000);
    }

    if (step === "api-analysis") {
      await addIndex("api-endpoints.jsonl", 120000);
      await addIndex("spring-components.jsonl", 60000);
      await addSources("Controller Sources", [/src[\\/]+main[\\/]+java[\\/].*[\\/]controller[\\/].*\.java$/i], 24000);
      await addSources("DTO Sources", [/src[\\/]+main[\\/]+java[\\/].*[\\/]DTO[\\/].*\.java$/i, /src[\\/]+main[\\/]+java[\\/].*[\\/]dto[\\/].*\.java$/i], 16000);
    }

    if (step === "service-flow-analysis") {
      await addIndex("spring-components.jsonl", 80000);
      await addIndex("dependency-graph.jsonl", 120000);
      await addIndex("api-endpoints.jsonl", 80000);
      await addSources("Service Sources", [/src[\\/]+main[\\/]+java[\\/].*[\\/]service[\\/].*\.java$/i], 26000);
      await addSources("Repository Sources", [/src[\\/]+main[\\/]+java[\\/].*[\\/]repository[\\/].*\.java$/i], 18000);
      await addSources("Event Sources", [/src[\\/]+main[\\/]+java[\\/].*[\\/]event[\\/].*\.java$/i], 18000);
      await addSources("Mapper Sources", [/src[\\/]+main[\\/]+java[\\/].*[\\/]mapper[\\/].*\.java$/i], 18000);
    }

    if (step === "data-config-error-analysis") {
      await addIndex("entity-index.jsonl", 80000);
      await addIndex("configuration-index.jsonl", 50000);
      await addIndex("test-index.jsonl", 50000);
      await addSources("Entity And Enum Sources", [
        /src[\\/]+main[\\/]+java[\\/].*[\\/]model[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+java[\\/].*[\\/]entity[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+java[\\/].*[\\/]enums?[\\/].*\.java$/i
      ], 22000);
      await addSources("Security Config And Exception Sources", [
        /src[\\/]+main[\\/]+java[\\/].*[\\/]security[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+java[\\/].*[\\/]config[\\/].*\.java$/i,
        /src[\\/]+main[\\/]+java[\\/].*[\\/]exception[\\/].*\.java$/i
      ], 22000);
      await addSources("Resource And Test Sources", [
        /src[\\/]+main[\\/]+resources[\\/].*\.(properties|ya?ml)$/i,
        /src[\\/]+test[\\/]+java[\\/].*\.java$/i
      ], 22000);
    }

    const maxContextCharacters = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.agenticMaxContextCharacters", 240000);
    const safe = maskSecretsWithStats(applyBudget(sections.join("\n\n"), maxContextCharacters));
    return {
      safeText: safe.text,
      includedIndexes: [...includedIndexes],
      maskedSecrets: safe.maskedSecrets
    };

    async function addFocusedSources(
      title: string,
      indexes: FocusedSourceIndex[],
      previousArtifacts: string[],
      maxFileCharacters: number,
      maxTotalCharacters: number
    ): Promise<void> {
      const source = await buildFocusedSourceContext({
        repoRoot,
        indexes,
        previousArtifacts,
        maxFileCharacters,
        maxTotalCharacters
      });
      if (!source.content) {
        return;
      }
      sections.push(section(title, source.content));
      source.files.forEach((file) => includedIndexes.add(`source:${file}`));
    }

    async function addLocalDocs(currentStep: CopilotAgenticStep): Promise<void> {
      const docsByStep: Record<CopilotAgenticStep, string[]> = {
        plan: ["repository-overview.md", "technical-analysis.md"],
        "api-analysis": ["api-endpoints.md"],
        "service-flow-analysis": ["service-layer.md", "repository-layer.md"],
        "data-config-error-analysis": ["database-entities.md", "configuration.md", "test-analysis.md"],
        "diagram-drafts": ["spring-architecture.md", "api-endpoints.md", "technical-analysis.md"],
        "final-synthesis": [
          "repository-overview.md",
          "spring-architecture.md",
          "api-endpoints.md",
          "service-layer.md",
          "repository-layer.md",
          "database-entities.md",
          "configuration.md",
          "technical-analysis.md"
        ]
      };
      for (const doc of docsByStep[currentStep]) {
        await addText(path.join("generated-docs", doc), currentStep === "final-synthesis" ? 14000 : 10000);
      }
      if (currentStep === "plan" || currentStep === "final-synthesis") {
        await addText("analysis-report.md", 10000);
      }
    }
  }

  private focusedIndexesForStep(aiDocsPath: string, step: CopilotAgenticStep): FocusedSourceIndex[] {
    const index = (relativePath: string, maxRecords?: number, filter?: (record: Record<string, unknown>) => boolean): FocusedSourceIndex => ({
      indexPath: path.join(aiDocsPath, relativePath),
      maxRecords,
      filter
    });
    switch (step) {
      case "api-analysis":
        return [
          index("api-endpoints.jsonl", 120),
          index("spring-components.jsonl", 120, (record) => record.type === "controller" || record.type === "dto" || record.type === "config")
        ];
      case "service-flow-analysis":
        return [
          index("api-endpoints.jsonl", 120),
          index("spring-components.jsonl", 160, (record) => ["controller", "service", "repository", "client", "mapper"].includes(String(record.type))),
          index("dependency-graph.jsonl", 180)
        ];
      case "data-config-error-analysis":
        return [
          index("entity-index.jsonl", 120),
          index("spring-components.jsonl", 160, (record) => ["entity", "repository", "config", "exception", "test"].includes(String(record.type))),
          index("configuration-index.jsonl", 80),
          index("test-index.jsonl", 80)
        ];
      case "diagram-drafts":
      case "final-synthesis":
      case "plan":
        return [
          index("api-endpoints.jsonl", 80),
          index("spring-components.jsonl", 120, (record) => ["controller", "service", "repository", "entity", "config", "exception"].includes(String(record.type))),
          index("entity-index.jsonl", 80),
          index("configuration-index.jsonl", 50)
        ];
    }
  }

  private previousArtifactsContext(previousOutputs: string[], step: CopilotAgenticStep): string {
    if (step === "plan") {
      return "";
    }
    const maxCharacters = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.agenticPreviousArtifactsCharacters", 18000);
    const joined = previousOutputs.join("\n\n---\n\n");
    if (joined.length <= maxCharacters) {
      return joined;
    }
    return `${joined.slice(Math.max(0, joined.length - maxCharacters))}\n[PREVIOUS_ARTIFACTS_TRUNCATED_FOR_TOKEN_BUDGET]`;
  }

  private async writeArtifact(workspaceRoot: string, fileName: string, content: string): Promise<string> {
    const target = path.join(workspaceRoot, fileName);
    await fs.writeFile(target, content, "utf8");
    return target;
  }

  private async writeRunSummary(
    workspaceRoot: string,
    summary: {
      repositoryName: string;
      branch: string;
      runId: string;
      finalDocumentPath: string;
      stepArtifacts: string[];
      estimatedTotalTokens: number;
      provider: DocumentationModelProvider;
      modelName?: string;
    }
  ): Promise<void> {
    await fs.writeFile(path.join(workspaceRoot, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(workspaceRoot, "run-summary.md"), [
      `# ${providerDisplayName(summary.provider)} Agentic Run Summary`,
      "",
      `Repository: ${summary.repositoryName}`,
      `Branch: ${summary.branch}`,
      `Run: ${summary.runId}`,
      `Provider: ${summary.provider}`,
      `Model: ${summary.modelName ?? "unknown"}`,
      `Estimated tokens: ${summary.estimatedTotalTokens}`,
      `Final document: ${summary.finalDocumentPath}`,
      "",
      "## Step Artifacts",
      ...summary.stepArtifacts.map((artifact) => `- ${artifact}`),
      ""
    ].join("\n"), "utf8");
  }

  private async auditStep(aiDocsPath: string, input: {
    step: CopilotAgenticStep;
    repositoryName: string;
    branch: string;
    contextPath: string;
    promptPath: string;
    charactersSent: number;
    includedIndexes: string[];
    maskedSecrets: number;
    usage: DocumentationModelUsage;
    model: DocumentationModelInfo;
    provider: DocumentationModelProvider;
    finishReason?: string;
    requestId?: string;
  }): Promise<void> {
    await new CopilotAuditLogger().write(aiDocsPath, {
      timestamp: new Date().toISOString(),
      docType: `agentic-${input.step}`,
      repositoryName: input.repositoryName,
      branch: input.branch,
      contextPackPath: path.relative(aiDocsPath, input.contextPath),
      promptPackPath: path.relative(aiDocsPath, input.promptPath),
      charactersSent: input.charactersSent,
      includedIndexes: input.includedIndexes,
      maskedSecrets: input.maskedSecrets,
      promptProfile: "agentic-backend-documentation",
      estimatedInputTokens: input.usage.estimatedInputTokens,
      estimatedOutputTokens: input.usage.estimatedOutputTokens,
      estimatedTotalTokens: input.usage.estimatedTotalTokens,
      modelCountedInputTokens: input.usage.modelCountedInputTokens,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      outputCharacters: input.usage.outputCharacters,
      copilotRequestStarted: true,
      copilotResponseReceived: true,
      selectedModelId: input.model.id,
      selectedModelName: input.model.name,
      selectedModelVendor: input.model.vendor,
      selectedModelFamily: input.model.family,
      selectedModelVersion: input.model.version,
      selectedModelMaxInputTokens: input.model.maxInputTokens,
      provider: input.provider,
      finishReason: input.finishReason,
      requestId: input.requestId,
      modelFamily: input.provider,
      status: "success"
    });
  }

  private async auditFailedStep(aiDocsPath: string, input: {
    step: CopilotAgenticStep;
    repositoryName: string;
    branch: string;
    contextPath: string;
    promptPath: string;
    charactersSent: number;
    includedIndexes: string[];
    maskedSecrets: number;
    provider: DocumentationModelProvider;
    durationMs: number;
    responseReceived: boolean;
    cancelled: boolean;
    error: string;
  }): Promise<void> {
    try {
      await new CopilotAuditLogger().write(aiDocsPath, {
        timestamp: new Date().toISOString(),
        docType: `agentic-${input.step}`,
        repositoryName: input.repositoryName,
        branch: input.branch,
        contextPackPath: path.relative(aiDocsPath, input.contextPath),
        promptPackPath: path.relative(aiDocsPath, input.promptPath),
        charactersSent: input.charactersSent,
        includedIndexes: input.includedIndexes,
        maskedSecrets: input.maskedSecrets,
        promptProfile: "agentic-backend-documentation",
        durationMs: input.durationMs,
        copilotRequestStarted: true,
        copilotResponseReceived: input.responseReceived,
        provider: input.provider,
        modelFamily: input.provider,
        status: input.cancelled ? "cancelled" : "failed",
        error: input.error
      });
    } catch {
      // The original provider failure remains primary if best-effort auditing fails.
    }
  }
}

function providerDisplayName(provider: DocumentationModelProvider): string {
  return provider === "qwen" ? "Qwen" : "Copilot";
}

function resolveProvider(
  responseProvider?: DocumentationModelProvider,
  clientProvider?: DocumentationModelProvider
): DocumentationModelProvider {
  return responseProvider ?? clientProvider ?? "copilot";
}

function modelAttribution(provider: DocumentationModelProvider, modelName?: string): string {
  const model = modelName ? ` (${modelName})` : "";
  return provider === "qwen"
    ? `Bank Spring Docs AI via multi-step configured Qwen endpoint${model}`
    : `Bank Spring Docs AI via multi-step GitHub Copilot Language Model API${model}`;
}

async function readJsonlContent(filePath: string, maxCharacters: number): Promise<string> {
  const records = await readJsonl<unknown>(filePath);
  return truncate(records.map((record) => JSON.stringify(record)).join("\n"), maxCharacters);
}

async function readTextContent(filePath: string, maxCharacters: number): Promise<string> {
  try {
    return truncate(await fs.readFile(filePath, "utf8"), maxCharacters);
  } catch {
    return "";
  }
}

async function sourceFilesSection(repoRoot: string, patterns: RegExp[], maxFileCharacters: number): Promise<{ content: string; files: string[] }> {
  const files = (await listFiles(repoRoot))
    .filter((file) => patterns.some((pattern) => pattern.test(file)))
    .sort();
  const chunks: string[] = [];
  for (const file of files) {
    const content = await readTextContent(path.join(repoRoot, file), maxFileCharacters);
    chunks.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
  }
  return { content: chunks.join("\n\n"), files };
}

async function listFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<import("fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "target" || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  return results;
}

function section(title: string, content: string): string {
  return `## ${title}\n${content || "Not visible from provided context."}`;
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, maxCharacters)}\n[TRUNCATED_FOR_TOKEN_BUDGET]`;
}

function applyBudget(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, maxCharacters)}\n[CONTEXT_PACK_TRUNCATED_FOR_COPILOT_TOKEN_LIMIT]`;
}
