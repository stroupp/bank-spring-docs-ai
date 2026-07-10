import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { askCopilotWithUsage, CopilotUsageEstimate } from "../ai/copilotClient";
import { CopilotAuditLogger } from "../ai/copilotAuditLogger";
import { buildCopilotMultiRepoAgenticPrompt, CopilotMultiRepoAgenticStep } from "../ai/prompts";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { readJsonl } from "../storage/jsonlWriter";
import { buildFocusedSourceContext, FocusedSourceIndex } from "./focusedSourceContext";
import { MarkdownWriter } from "./markdownWriter";

export interface MultiRepoCopilotAgenticProgress {
  step: CopilotMultiRepoAgenticStep;
  stepIndex: number;
  totalSteps: number;
  stepLabel: string;
  phase: "started" | "streaming" | "completed";
  message: string;
  usage?: CopilotUsageEstimate;
}

export interface MultiRepoCopilotAgenticResult {
  finalDocumentPath: string;
  workspaceRoot: string;
  stepArtifacts: string[];
  requestCount: number;
  estimatedTotalTokens: number;
}

const steps: CopilotMultiRepoAgenticStep[] = [
  "cross-layer-plan",
  "ui-analysis",
  "bff-analysis",
  "be-analysis",
  "traceability-analysis",
  "cross-layer-diagrams",
  "final-cross-layer-synthesis"
];

const stepLabels: Record<CopilotMultiRepoAgenticStep, string> = {
  "cross-layer-plan": "UI-BFF-BE plan olusturma",
  "ui-analysis": "React UI analizi",
  "bff-analysis": "Spring BFF analizi",
  "be-analysis": "Spring BE analizi",
  "traceability-analysis": "Uctan uca traceability analizi",
  "cross-layer-diagrams": "Cross-layer PlantUML diyagramlari",
  "final-cross-layer-synthesis": "Final UI-BFF-BE sentezi"
};

export class MultiRepoCopilotAgenticDocumentationGenerator {
  constructor(private readonly markdownWriter = new MarkdownWriter()) {}

  async generate(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    token: vscode.CancellationToken,
    onProgress?: (progress: MultiRepoCopilotAgenticProgress) => void
  ): Promise<MultiRepoCopilotAgenticResult> {
    const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const workspaceRoot = path.join(multiRepoRoot, "copilot-workspace", "agentic-ui-bff-be", runId);
    await fs.mkdir(workspaceRoot, { recursive: true });

    const previousOutputs: string[] = [];
    const stepArtifacts: string[] = [];
    let finalBody = "";
    let estimatedTotalTokens = 0;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const stepIndex = index + 1;
      const stepLabel = stepLabels[step];
      if (token.isCancellationRequested) {
        throw new Error("Multi-repo Copilot agentic analysis was cancelled.");
      }

      onProgress?.({
        step,
        stepIndex,
        totalSteps: steps.length,
        stepLabel,
        phase: "started",
        message: `Adim ${stepIndex}/${steps.length} - ${stepLabel} baslatildi`
      });

      const context = await this.buildContextForStep(multiRepoRoot, manifest, step, previousOutputs);
      const previousContext = this.previousArtifactsContext(previousOutputs);
      const promptRequest = buildCopilotMultiRepoAgenticPrompt(step, context.safeText, previousContext);
      const promptPath = await this.writeArtifact(workspaceRoot, `${step}-prompt.md`, promptRequest.combinedText);
      const contextPath = await this.writeArtifact(workspaceRoot, `${step}-context.md`, context.safeText);

      const response = await askCopilotWithUsage(promptRequest, token, (usage) => {
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
      if (!response.text.trim()) {
        throw new Error(`Copilot returned an empty response for multi-repo agentic step: ${step}.`);
      }

      estimatedTotalTokens += response.usage.estimatedTotalTokens;
      const outputPath = await this.writeArtifact(workspaceRoot, `${step}.md`, response.text);
      stepArtifacts.push(outputPath);
      previousOutputs.push(`# ${step}\n\n${response.text}`);
      if (step === "final-cross-layer-synthesis") {
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

      await new CopilotAuditLogger().write(multiRepoRoot, {
        timestamp: new Date().toISOString(),
        docType: `multi-repo-agentic-${step}`,
        repositoryName: manifest.projectName,
        branch: manifest.branch,
        contextPackPath: path.relative(multiRepoRoot, contextPath),
        promptPackPath: path.relative(multiRepoRoot, promptPath),
        charactersSent: context.safeText.length,
        includedIndexes: context.includedIndexes,
        maskedSecrets: context.maskedSecrets,
        promptProfile: "agentic-ui-bff-be-documentation",
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
    }

    const finalDocumentPath = await this.markdownWriter.write(
      multiRepoRoot,
      `agentic-ui-bff-be-technical-analysis-${runId}.md`,
      "Agentic UI-BFF-BE Technical Analysis",
      manifest.projectName,
      manifest.branch,
      finalBody || previousOutputs.join("\n\n---\n\n"),
      path.join("generated-docs", "agentic"),
      "Bank Spring Docs AI via multi-step GitHub Copilot Language Model API"
    );

    await this.writeRunSummary(workspaceRoot, manifest, runId, finalDocumentPath, stepArtifacts, estimatedTotalTokens);
    return {
      finalDocumentPath,
      workspaceRoot,
      stepArtifacts,
      requestCount: steps.length,
      estimatedTotalTokens
    };
  }

  private async buildContextForStep(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    step: CopilotMultiRepoAgenticStep,
    previousOutputs: string[]
  ): Promise<{ safeText: string; includedIndexes: string[]; maskedSecrets: number }> {
    const sections: string[] = [];
    const includedIndexes = new Set<string>();
    const add = async (relativePath: string, maxCharacters: number, parseJsonl = true): Promise<void> => {
      const content = parseJsonl
        ? await this.readJsonlContent(path.join(multiRepoRoot, relativePath), maxCharacters)
        : await this.readTextContent(path.join(multiRepoRoot, relativePath), maxCharacters);
      sections.push(`## ${relativePath}\n${content || "Not visible from provided context."}`);
      includedIndexes.add(relativePath);
    };

    sections.push(`## manifest.json\n${JSON.stringify(manifest, null, 2)}`);
    includedIndexes.add("manifest.json");
    await this.addFocusedSourceEvidence(multiRepoRoot, manifest, step, previousOutputs, sections, includedIndexes);

    if (step === "cross-layer-plan" || step === "final-cross-layer-synthesis") {
      await add("ui/page-index.jsonl", 8000);
      await add("ui/interaction-index.jsonl", 8000);
      await add("ui/api-call-index.jsonl", 8000);
      await add("bff/api-endpoints.jsonl", 9000);
      await add("bff/outbound-calls.jsonl", 9000);
      await add("be/api-endpoints.jsonl", 10000);
      await add("traceability/page-flows.jsonl", 12000);
      await add("quality/multi-repo-quality-report.md", 8000, false);
    }

    if (step === "ui-analysis") {
      await add("ui/file-index.jsonl", 8000);
      await add("ui/route-index.jsonl", 8000);
      await add("ui/page-index.jsonl", 10000);
      await add("ui/component-index.jsonl", 12000);
      await add("ui/interaction-index.jsonl", 12000);
      await add("ui/api-call-index.jsonl", 12000);
      await add("ui/form-field-index.jsonl", 8000);
      await add("ui/state-index.jsonl", 8000);
      await add("ui/semantic/interaction-semantics.jsonl", 12000);
    }

    if (step === "bff-analysis") {
      await add("bff/api-endpoints.jsonl", 12000);
      await add("bff/outbound-calls.jsonl", 12000);
      await add("bff/dto-index.jsonl", 10000);
      await add("bff/bff-flow-index.jsonl", 12000);
      await add("bff/spring-components.jsonl", 12000);
      await add("bff/configuration-index.jsonl", 8000);
    }

    if (step === "be-analysis") {
      await add("be/api-endpoints.jsonl", 12000);
      await add("be/java-method-call-index.jsonl", 12000);
      await add("be/dto-index.jsonl", 10000);
      await add("be/service-flow-index.jsonl", 14000);
      await add("be/repository-method-index.jsonl", 12000);
      await add("be/entity-index.jsonl", 12000);
      await add("be/validation-index.jsonl", 12000);
      await add("be/exception-flow-index.jsonl", 12000);
      await add("be/configuration-index.jsonl", 8000);
      await add("be/test-index.jsonl", 8000);
    }

    if (step === "traceability-analysis" || step === "cross-layer-diagrams") {
      await add("traceability/ui-to-bff.jsonl", 12000);
      await add("traceability/bff-to-be.jsonl", 12000);
      await add("traceability/page-flows.jsonl", 14000);
      await add("traceability/unresolved-matches.jsonl", 8000);
      await add("traceability/traceability-report.md", 12000, false);
      await add("traceability/semantic/page-flow-semantics.jsonl", 14000);
      await add("graph/graph-summary.md", 10000, false);
      await add("quality/multi-repo-quality-report.md", 10000, false);
    }

    const maxContextCharacters = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.agenticMaxContextCharacters", 240000);
    const safe = maskSecretsWithStats(applyBudget(sections.join("\n\n"), maxContextCharacters));
    return {
      safeText: safe.text,
      includedIndexes: [...includedIndexes],
      maskedSecrets: safe.maskedSecrets
    };
  }

  private async addFocusedSourceEvidence(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    step: CopilotMultiRepoAgenticStep,
    previousOutputs: string[],
    sections: string[],
    includedIndexes: Set<string>
  ): Promise<void> {
    const rolePlans = this.focusedSourcePlans(multiRepoRoot, manifest, step);
    for (const plan of rolePlans) {
      const repoRoot = manifest.repos[plan.role].localPath;
      const source = await buildFocusedSourceContext({
        repoRoot,
        indexes: plan.indexes,
        previousArtifacts: previousOutputs,
        maxFileCharacters: plan.maxFileCharacters,
        maxTotalCharacters: plan.maxTotalCharacters
      });
      if (!source.content) {
        continue;
      }
      sections.push(`## Focused Source Evidence - ${plan.role.toUpperCase()}\n${source.content}`);
      source.files.forEach((file) => includedIndexes.add(`source:${plan.role}:${file}`));
    }
  }

  private focusedSourcePlans(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    step: CopilotMultiRepoAgenticStep
  ): Array<{ role: "ui" | "bff" | "be"; indexes: FocusedSourceIndex[]; maxFileCharacters: number; maxTotalCharacters: number }> {
    const index = (relativePath: string, maxRecords?: number, filter?: (record: Record<string, unknown>) => boolean): FocusedSourceIndex => ({
      indexPath: path.join(multiRepoRoot, relativePath),
      maxRecords,
      filter
    });
    const ui = {
      role: "ui" as const,
      indexes: [
        index("ui/page-index.jsonl", 80),
        index("ui/component-index.jsonl", 100),
        index("ui/interaction-index.jsonl", 100),
        index("ui/api-call-index.jsonl", 120),
        index("ui/route-index.jsonl", 80)
      ],
      maxFileCharacters: 8000,
      maxTotalCharacters: 60000
    };
    const bff = {
      role: "bff" as const,
      indexes: [
        index("bff/api-endpoints.jsonl", 120),
        index("bff/outbound-calls.jsonl", 120),
        index("bff/dto-index.jsonl", 100),
        index("bff/bff-flow-index.jsonl", 120),
        index("bff/spring-components.jsonl", 140)
      ],
      maxFileCharacters: 9000,
      maxTotalCharacters: 70000
    };
    const be = {
      role: "be" as const,
      indexes: [
        index("be/api-endpoints.jsonl", 120),
        index("be/java-method-call-index.jsonl", 120),
        index("be/dto-index.jsonl", 100),
        index("be/service-flow-index.jsonl", 120),
        index("be/repository-method-index.jsonl", 120),
        index("be/entity-index.jsonl", 120),
        index("be/validation-index.jsonl", 120),
        index("be/exception-flow-index.jsonl", 120),
        index("be/spring-components.jsonl", 140)
      ],
      maxFileCharacters: 9000,
      maxTotalCharacters: 80000
    };

    switch (step) {
      case "ui-analysis":
        return [ui];
      case "bff-analysis":
        return [bff];
      case "be-analysis":
        return [be];
      case "traceability-analysis":
      case "cross-layer-diagrams":
      case "final-cross-layer-synthesis":
        return [ui, bff, be].map((plan) => ({ ...plan, maxTotalCharacters: Math.floor(plan.maxTotalCharacters / 2) }));
      case "cross-layer-plan":
        return [
          { ...ui, maxTotalCharacters: 25000 },
          { ...bff, maxTotalCharacters: 30000 },
          { ...be, maxTotalCharacters: 30000 }
        ];
    }
  }

  private async readJsonlContent(filePath: string, maxCharacters: number): Promise<string> {
    const records = await readJsonl<unknown>(filePath);
    return truncate(records.map((record) => JSON.stringify(record)).join("\n"), maxCharacters);
  }

  private async readTextContent(filePath: string, maxCharacters: number): Promise<string> {
    try {
      return truncate(await fs.readFile(filePath, "utf8"), maxCharacters);
    } catch {
      return "";
    }
  }

  private previousArtifactsContext(previousOutputs: string[]): string {
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
    manifest: MultiRepoManifest,
    runId: string,
    finalDocumentPath: string,
    stepArtifacts: string[],
    estimatedTotalTokens: number
  ): Promise<void> {
    await fs.writeFile(path.join(workspaceRoot, "run-summary.json"), `${JSON.stringify({
      projectName: manifest.projectName,
      branch: manifest.branch,
      runId,
      finalDocumentPath,
      stepArtifacts,
      estimatedTotalTokens
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(workspaceRoot, "run-summary.md"), [
      "# Multi-Repo Copilot Agentic Run Summary",
      "",
      `Project: ${manifest.projectName}`,
      `Branch: ${manifest.branch}`,
      `Run: ${runId}`,
      `Estimated tokens: ${estimatedTotalTokens}`,
      `Final document: ${finalDocumentPath}`,
      "",
      "## Step Artifacts",
      ...stepArtifacts.map((artifact) => `- ${artifact}`),
      ""
    ].join("\n"), "utf8");
  }
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
