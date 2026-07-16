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
import { buildCopilotMultiRepoAgenticPrompt, CopilotMultiRepoAgenticStep } from "../ai/prompts";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { readJsonl } from "../storage/jsonlWriter";
import { buildFocusedSourceContext, FocusedSourceIndex } from "./focusedSourceContext";
import { MarkdownWriter } from "./markdownWriter";
import { MultiRepoAgenticRunStatus, MultiRepoAgenticRunStatusWriter } from "./multiRepoAgenticRunStatus";

export interface MultiRepoCopilotAgenticProgress {
  step: CopilotMultiRepoAgenticStep;
  stepIndex: number;
  totalSteps: number;
  stepLabel: string;
  phase: "started" | "streaming" | "completed";
  message: string;
  usage?: DocumentationModelUsage;
}

export interface MultiRepoCopilotAgenticResult {
  finalDocumentPath: string;
  workspaceRoot: string;
  stepArtifacts: string[];
  /** Total request attempts across the original run and all resumes. */
  requestCount: number;
  /** Requests made by this invocation only. */
  newRequestCount: number;
  reusedStepCount: number;
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

const statusPhaseByStep: Record<CopilotMultiRepoAgenticStep, string> = {
  "cross-layer-plan": "copilot-cross-layer-plan",
  "ui-analysis": "copilot-ui-analysis",
  "bff-analysis": "copilot-bff-analysis",
  "be-analysis": "copilot-be-analysis",
  "traceability-analysis": "copilot-traceability-analysis",
  "cross-layer-diagrams": "copilot-cross-layer-diagrams",
  "final-cross-layer-synthesis": "copilot-final-cross-layer-synthesis"
};

export class MultiRepoCopilotAgenticDocumentationGenerator {
  constructor(
    private readonly markdownWriter = new MarkdownWriter(),
    private readonly modelClient: IDocumentationModelClient = new RealCopilotClient()
  ) {}

  async generate(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    token: vscode.CancellationToken,
    onProgress?: (progress: MultiRepoCopilotAgenticProgress) => void,
    existingRunStatus?: MultiRepoAgenticRunStatusWriter
  ): Promise<MultiRepoCopilotAgenticResult> {
    const runStatus = existingRunStatus ?? await MultiRepoAgenticRunStatusWriter.create(
      multiRepoRoot,
      manifest,
      undefined,
      { provider: resolveProvider(undefined, this.modelClient.provider) }
    );
    const runId = runStatus.runId;
    const workspaceRoot = runStatus.workspaceRoot;

    const previousOutputs: string[] = [];
    const stepArtifacts: string[] = [];
    let finalBody = "";
    const priorUsage = summarizePriorCopilotUsage(runStatus.snapshot());
    let estimatedTotalTokens = priorUsage.estimatedTotalTokens;
    let requestCount = priorUsage.requestCount;
    let newRequestCount = 0;
    let reusedStepCount = 0;
    let finalProvider = resolveProvider(undefined, this.modelClient.provider);
    let finalModel: DocumentationModelInfo | undefined;

    try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const statusPhase = statusPhaseByStep[step];
      const stepIndex = index + 1;
      const stepLabel = stepLabels[step];
      if (token.isCancellationRequested) {
        throw new Error(`Multi-repo ${providerDisplayName(finalProvider)} agentic analysis was cancelled.`);
      }

      if (runStatus.isPhaseReusable(statusPhase)) {
        const reusablePhase = runStatus.phaseSnapshot(statusPhase);
        const reusableProvider = providerFromDetails(reusablePhase.details);
        const reusableModel = modelFromDetails(reusablePhase.details);
        finalProvider = reusableProvider ?? finalProvider;
        finalModel = reusableModel ?? finalModel;
        const validation = await runStatus.validatePhaseArtifacts(statusPhase);
        if (!validation.valid || !validation.copilotOutputArtifact) {
          throw new Error(`Reusable model output is unavailable for multi-repo agentic step: ${step}.`);
        }
        const reusedOutput = await fs.readFile(validation.copilotOutputArtifact, "utf8");
        if (!reusedOutput.trim()) {
          throw new Error(`Reusable model output is empty for multi-repo agentic step: ${step}.`);
        }
        stepArtifacts.push(validation.copilotOutputArtifact);
        previousOutputs.push(`# ${step}\n\n${reusedOutput}`);
        if (step === "final-cross-layer-synthesis") {
          finalBody = reusedOutput;
        }
        reusedStepCount += 1;
        onProgress?.({
          step,
          stepIndex,
          totalSteps: steps.length,
          stepLabel,
          phase: "completed",
          message: `Adim ${stepIndex}/${steps.length} - ${stepLabel}: onceki cikti yeniden kullanildi`
        });
        continue;
      }

      onProgress?.({
        step,
        stepIndex,
        totalSteps: steps.length,
        stepLabel,
        phase: "started",
        message: `Adim ${stepIndex}/${steps.length} - ${stepLabel} baslatildi`
      });
      await runStatus.startPhase(statusPhase);
      const attempt = runStatus.currentAttempt(statusPhase);
      const artifactStem = attempt > 1 ? `${step}-attempt-${attempt}` : step;

      const context = await this.buildContextForStep(multiRepoRoot, manifest, step, previousOutputs);
      const previousContext = this.previousArtifactsContext(previousOutputs);
      const promptRequest = buildCopilotMultiRepoAgenticPrompt(step, context.safeText, previousContext);
      const promptPath = await this.writeArtifact(workspaceRoot, `${artifactStem}-prompt.md`, promptRequest.combinedText);
      const contextPath = await this.writeArtifact(workspaceRoot, `${artifactStem}-context.md`, context.safeText);
      await runStatus.updatePhase(statusPhase, {
        artifacts: [promptPath, contextPath],
        details: {
          requestStarted: true,
          responseReceived: false,
          charactersSent: context.safeText.length,
          maskedSecrets: context.maskedSecrets,
          includedIndexes: context.includedIndexes,
          provider: resolveProvider(undefined, this.modelClient.provider),
          attempt
        }
      });

      const requestStartedAt = Date.now();
      let response: DocumentationModelResponse | undefined;
      try {
        requestCount += 1;
        newRequestCount += 1;
        response = await this.modelClient.send(promptRequest, token, (usage) => {
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
        finalProvider = resolveProvider(response.provider, this.modelClient.provider);
        finalModel = response.model;
        await runStatus.updatePhase(statusPhase, {
          details: {
            responseReceived: true,
            outputCharacters: response.usage.outputCharacters,
            estimatedInputTokens: response.usage.estimatedInputTokens,
            estimatedOutputTokens: response.usage.estimatedOutputTokens,
            estimatedTotalTokens: response.usage.estimatedTotalTokens,
            modelCountedInputTokens: response.usage.modelCountedInputTokens,
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            totalTokens: response.usage.totalTokens,
            provider: finalProvider,
            finishReason: response.finishReason,
            selectedModelId: response.model.id,
            selectedModelName: response.model.name,
            selectedModelVendor: response.model.vendor,
            selectedModelFamily: response.model.family,
            selectedModelVersion: response.model.version,
            selectedModelMaxInputTokens: response.model.maxInputTokens,
            durationMs: Date.now() - requestStartedAt
          }
        });
        if (!response.text.trim()) {
          throw new Error(`${providerDisplayName(finalProvider)} returned an empty response for multi-repo agentic step: ${step}.`);
        }

        estimatedTotalTokens += response.usage.estimatedTotalTokens;
        const outputPath = await this.writeArtifact(workspaceRoot, `${artifactStem}.md`, response.text);
        await runStatus.updatePhase(statusPhase, { artifacts: [outputPath] });
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
          runId,
          attempt,
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
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          outputCharacters: response.usage.outputCharacters,
          durationMs: Date.now() - requestStartedAt,
          copilotRequestStarted: true,
          copilotResponseReceived: true,
          selectedModelId: response.model.id,
          selectedModelName: response.model.name,
          selectedModelVendor: response.model.vendor,
          selectedModelFamily: response.model.family,
          selectedModelVersion: response.model.version,
          selectedModelMaxInputTokens: response.model.maxInputTokens,
          provider: finalProvider,
          finishReason: response.finishReason,
          requestId: response.requestId,
          modelFamily: finalProvider,
          status: "success"
        });
        await runStatus.completePhase(statusPhase, {
          artifacts: [promptPath, contextPath, outputPath],
          details: { status: "success" }
        });
      } catch (error) {
        await this.writeFailureAudit(multiRepoRoot, manifest, runId, attempt, step, context, contextPath, promptPath, response, requestStartedAt, token, error);
        throw error;
      }
    }

    let finalDocumentPath: string;
    if (runStatus.isPhaseReusable("final-document")) {
      const validation = await runStatus.validatePhaseArtifacts("final-document");
      if (!validation.valid || !validation.existingArtifacts[0]) {
        throw new Error("Reusable final Agentic document is unavailable.");
      }
      finalDocumentPath = validation.existingArtifacts[0];
    } else {
      await runStatus.startPhase("final-document");
      finalDocumentPath = await this.markdownWriter.write(
        multiRepoRoot,
        `agentic-ui-bff-be-technical-analysis-${runId}.md`,
        "Agentic UI-BFF-BE Technical Analysis",
        manifest.projectName,
        manifest.branch,
        finalBody || previousOutputs.join("\n\n---\n\n"),
        path.join("generated-docs", "agentic"),
        modelAttribution(finalProvider, finalModel?.name)
      );
      await runStatus.updatePhase("final-document", { artifacts: [finalDocumentPath] });
      await runStatus.completePhase("final-document", { artifacts: [finalDocumentPath] });
    }

    if (!runStatus.isPhaseReusable("run-summary")) {
      await runStatus.startPhase("run-summary");
      await this.writeRunSummary(
        workspaceRoot,
        manifest,
        runId,
        finalDocumentPath,
        stepArtifacts,
        estimatedTotalTokens,
        requestCount,
        newRequestCount,
        reusedStepCount,
        finalProvider,
        finalModel?.name
      );
      const summaryArtifacts = [path.join(workspaceRoot, "run-summary.json"), path.join(workspaceRoot, "run-summary.md")];
      await runStatus.completePhase("run-summary", { artifacts: summaryArtifacts });
    }
    const result = {
      finalDocumentPath,
      workspaceRoot,
      stepArtifacts,
      requestCount,
      newRequestCount,
      reusedStepCount,
      estimatedTotalTokens
    };
    await runStatus.finishSuccess(result);
    return result;
    } catch (error) {
      if (runStatus.snapshot().status === "running") {
        try {
          await runStatus.finishFailure(error, token.isCancellationRequested || /cancel/i.test(error instanceof Error ? error.message : String(error)));
        } catch {
          // Preserve the original pipeline failure if status persistence also fails.
        }
      }
      throw error;
    }
  }

  private async writeFailureAudit(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    runId: string,
    attempt: number,
    step: CopilotMultiRepoAgenticStep,
    context: { safeText: string; includedIndexes: string[]; maskedSecrets: number },
    contextPath: string,
    promptPath: string,
    response: DocumentationModelResponse | undefined,
    requestStartedAt: number,
    token: vscode.CancellationToken,
    error: unknown
  ): Promise<void> {
    const message = maskSecretsWithStats(error instanceof Error ? error.message : String(error)).text.slice(0, 4000);
    try {
      await new CopilotAuditLogger().write(multiRepoRoot, {
        timestamp: new Date().toISOString(),
        runId,
        attempt,
        docType: `multi-repo-agentic-${step}`,
        repositoryName: manifest.projectName,
        branch: manifest.branch,
        contextPackPath: path.relative(multiRepoRoot, contextPath),
        promptPackPath: path.relative(multiRepoRoot, promptPath),
        charactersSent: context.safeText.length,
        includedIndexes: context.includedIndexes,
        maskedSecrets: context.maskedSecrets,
        promptProfile: "agentic-ui-bff-be-documentation",
        estimatedInputTokens: response?.usage.estimatedInputTokens,
        estimatedOutputTokens: response?.usage.estimatedOutputTokens,
        estimatedTotalTokens: response?.usage.estimatedTotalTokens,
        modelCountedInputTokens: response?.usage.modelCountedInputTokens,
        promptTokens: response?.usage.promptTokens,
        completionTokens: response?.usage.completionTokens,
        totalTokens: response?.usage.totalTokens,
        outputCharacters: response?.usage.outputCharacters ?? 0,
        durationMs: Date.now() - requestStartedAt,
        copilotRequestStarted: true,
        copilotResponseReceived: Boolean(response),
        selectedModelId: response?.model.id,
        selectedModelName: response?.model.name,
        selectedModelVendor: response?.model.vendor,
        selectedModelFamily: response?.model.family,
        selectedModelVersion: response?.model.version,
        selectedModelMaxInputTokens: response?.model.maxInputTokens,
        provider: resolveProvider(response?.provider, this.modelClient.provider),
        finishReason: response?.finishReason,
        requestId: response?.requestId,
        modelFamily: resolveProvider(response?.provider, this.modelClient.provider),
        status: token.isCancellationRequested || /cancel/i.test(message) ? "cancelled" : "failed",
        error: message
      });
    } catch {
      // Failure auditing is best-effort and must not hide the original model error.
    }
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
    estimatedTotalTokens: number,
    requestCount: number,
    newRequestCount: number,
    reusedStepCount: number,
    provider: DocumentationModelProvider,
    modelName?: string
  ): Promise<void> {
    await fs.writeFile(path.join(workspaceRoot, "run-summary.json"), `${JSON.stringify({
      projectName: manifest.projectName,
      branch: manifest.branch,
      runId,
      finalDocumentPath,
      stepArtifacts,
      estimatedTotalTokens,
      requestCount,
      newRequestCount,
      reusedStepCount,
      provider,
      modelName,
      runStatusPath: path.join(workspaceRoot, "run-status.json")
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(workspaceRoot, "run-summary.md"), [
      `# Multi-Repo ${providerDisplayName(provider)} Agentic Run Summary`,
      "",
      `Project: ${manifest.projectName}`,
      `Branch: ${manifest.branch}`,
      `Run: ${runId}`,
      `Provider: ${provider}`,
      `Model: ${modelName ?? "unknown"}`,
      `Estimated tokens: ${estimatedTotalTokens}`,
      `Request attempts: ${requestCount}`,
      `New requests in this invocation: ${newRequestCount}`,
      `Reused generation steps: ${reusedStepCount}`,
      `Final document: ${finalDocumentPath}`,
      `Run status: ${path.join(workspaceRoot, "run-status.json")}`,
      "",
      "## Step Artifacts",
      ...stepArtifacts.map((artifact) => `- ${artifact}`),
      ""
    ].join("\n"), "utf8");
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

function providerFromDetails(details: Record<string, unknown> | undefined): DocumentationModelProvider | undefined {
  const provider = details?.provider;
  if (provider === "copilot" || provider === "qwen") {
    return provider;
  }
  return details?.selectedModelVendor === "qwen" ? "qwen" : details?.selectedModelVendor === "copilot" ? "copilot" : undefined;
}

function modelFromDetails(details: Record<string, unknown> | undefined): DocumentationModelInfo | undefined {
  if (!details || typeof details.selectedModelId !== "string" || typeof details.selectedModelName !== "string") {
    return undefined;
  }
  return {
    id: details.selectedModelId,
    name: details.selectedModelName,
    vendor: typeof details.selectedModelVendor === "string" ? details.selectedModelVendor : "unknown",
    family: typeof details.selectedModelFamily === "string" ? details.selectedModelFamily : "unknown",
    version: typeof details.selectedModelVersion === "string" ? details.selectedModelVersion : "unknown",
    maxInputTokens: typeof details.selectedModelMaxInputTokens === "number" ? details.selectedModelMaxInputTokens : 0
  };
}

function modelAttribution(provider: DocumentationModelProvider, modelName?: string): string {
  const model = modelName ? ` (${modelName})` : "";
  return provider === "qwen"
    ? `Bank Spring Docs AI via multi-step configured Qwen endpoint${model}`
    : `Bank Spring Docs AI via multi-step GitHub Copilot Language Model API${model}`;
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

function summarizePriorCopilotUsage(status: MultiRepoAgenticRunStatus): { requestCount: number; estimatedTotalTokens: number } {
  let requestCount = 0;
  let estimatedTotalTokens = 0;
  const addDetails = (details: Record<string, unknown> | undefined): void => {
    if (!details || details.requestStarted !== true) {
      return;
    }
    requestCount += 1;
    const tokens = details.estimatedTotalTokens;
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
      estimatedTotalTokens += tokens;
    }
  };
  for (const phase of status.phases.filter((item) => item.category === "copilot")) {
    for (const attempt of phase.history ?? []) {
      addDetails(attempt.details);
    }
    addDetails(phase.details);
  }
  return { requestCount, estimatedTotalTokens };
}
