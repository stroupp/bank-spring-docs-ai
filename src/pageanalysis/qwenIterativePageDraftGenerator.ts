import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import type * as vscode from "vscode";
import type {
  DocumentationModelRequest,
  DocumentationModelResponse,
  DocumentationModelUsage,
  IDocumentationModelClient
} from "../ai/documentationModelClient";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import type { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { parseStrictJson } from "../semantic/semanticCacheService";
import { atomicWriteFile, atomicWriteJson } from "../storage/atomicFile";
import { sha256 } from "../utils/hash";
import { ensureWithin, safeName } from "../utils/pathUtils";
import { buildPageArtifactMetadata, pageMetadataComment } from "./pageArtifactMetadata";
import {
  QwenPageDraftContextChunk,
  QwenPageDraftContextChunker
} from "./qwenPageDraftContextChunker";
import {
  buildQwenPageChunkAnalysisPrompt,
  buildQwenPageFinalSynthesisPrompt,
  buildQwenPageLedgerReducePrompt,
  qwenIterativePageDraftPromptVersion,
  qwenPageDocumentSections,
  QwenPageFactLedger,
  QwenPageFactSection
} from "./qwenPageDraftPrompts";

export interface QwenIterativePageDraftOptions {
  /** Full system + user prompt ceiling, not only the evidence payload. */
  maxInputCharacters?: number;
  /** Maximum bounded evidence payload before prompt overhead. */
  maxChunkCharacters?: number;
  /** Maximum characters sampled from one selected raw source file. */
  maxSourceFileCharacters?: number;
  /** Fairly shared total raw UI/BFF/BE source budget. */
  maxTotalSourceCharacters?: number;
  /** Hard ceiling for new model calls in one invocation. */
  maxModelCalls?: number;
  /** Maximum hierarchical ledger-reduction depth. */
  maxReduceLevels?: number;
  /** Qwen deployment identity included in resume compatibility. */
  modelIdentity?: string;
  /** Every response model id/name must contain this marker. */
  expectedModelMarker?: string;
  /** Deterministic injection seam for tests. */
  now?: () => Date;
  /** Deterministic injection seam for tests. */
  runIdFactory?: () => string;
}

export interface QwenIterativePageDraftInput {
  multiRepoRoot: string;
  pageRoot: string;
  token: vscode.CancellationToken;
  /** Enables raw selected UI/BFF/BE source chunks beyond the 30k evidence pack. */
  manifest?: MultiRepoManifest;
  onProgress?: (progress: QwenIterativePageDraftProgress) => void;
}

export interface QwenIterativePageDraftProgress {
  phase: "context" | "analysis" | "reduce" | "synthesis" | "publish";
  message: string;
  completed: number;
  total: number;
  modelCalls: number;
  reusedSteps: number;
  usage?: DocumentationModelUsage;
}

export interface QwenIterativePageDraftResult {
  qwenDraftPath: string;
  /** Compatibility output consumed by the existing gap/final-document pipeline. */
  draftPath: string;
  runRoot: string;
  runManifestPath: string;
  inputHash: string;
  chunkCount: number;
  modelCallCount: number;
  newModelCallCount: number;
  reusedStepCount: number;
  reduceLevels: number;
  estimatedTotalTokens: number;
  includedSourceFiles: string[];
  warnings: string[];
  modelIds: string[];
}

type RunState = "running" | "completed" | "failed" | "cancelled";
type StepState = "pending" | "running" | "completed" | "failed" | "cancelled";
type StepKind = "analysis" | "reduce" | "synthesis" | "publish";

interface QwenPageDraftRunStep {
  id: string;
  kind: StepKind;
  status: StepState;
  inputHash: string;
  attempt: number;
  contextPath?: string;
  promptPath?: string;
  outputPath?: string;
  /** Masked raw response preserved only when response parsing fails. */
  rawOutputPath?: string;
  outputHash?: string;
  modelId?: string;
  usage?: DocumentationModelUsage;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface QwenPageDraftRunManifest {
  schemaVersion: 1;
  pipeline: "qwen3-iterative-page-draft";
  promptVersion: string;
  runId: string;
  status: RunState;
  inputHash: string;
  optionsFingerprint: string;
  modelIdentity: string;
  expectedModelMarker: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  currentStep?: string;
  requestCount: number;
  estimatedTotalTokens: number;
  modelIds: string[];
  chunks: Array<{
    id: string;
    kind: string;
    sourceLabel: string;
    contentHash: string;
    characters: number;
    maskedSecrets: number;
    role?: string;
    sourceFile?: string;
  }>;
  includedSourceFiles: string[];
  warnings: string[];
  steps: Record<string, QwenPageDraftRunStep>;
  qwenDraftPath?: string;
  compatibilityDraftPath?: string;
  error?: string;
}

interface NormalizedOptions {
  maxInputCharacters: number;
  maxChunkCharacters: number;
  maxSourceFileCharacters: number;
  maxTotalSourceCharacters: number;
  maxModelCalls: number;
  maxReduceLevels: number;
  modelIdentity: string;
  expectedModelMarker: string;
  now: () => Date;
  runIdFactory: () => string;
}

interface InvocationCounters {
  newModelCalls: number;
  reusedSteps: number;
}

interface StepResult<T> {
  value: T;
  response?: DocumentationModelResponse;
  reused: boolean;
}

const defaults = {
  maxInputCharacters: 60000,
  maxChunkCharacters: 42000,
  maxSourceFileCharacters: 180000,
  maxTotalSourceCharacters: 720000,
  maxModelCalls: 48,
  maxReduceLevels: 5,
  modelIdentity: "qwen3",
  expectedModelMarker: "qwen3"
};

const promptOverheadReserve = 7000;

/**
 * Qwen3-only, bounded, resumable page-draft pipeline.
 *
 * This class deliberately has no dependency on the configured global provider
 * and never constructs a Copilot client. Callers must inject an explicit Qwen
 * documentation client, which also makes every model boundary mockable.
 */
export class QwenIterativePageDraftGenerator {
  private readonly options: NormalizedOptions;

  constructor(
    private readonly client: IDocumentationModelClient,
    options: QwenIterativePageDraftOptions = {}
  ) {
    this.options = normalizeOptions(options);
  }

  async generate(input: QwenIterativePageDraftInput): Promise<QwenIterativePageDraftResult> {
    if (this.client.provider !== "qwen") {
      throw new Error("Qwen3-only sayfa pipeline'i yalnizca provider=qwen bir model client kabul eder.");
    }
    if (!ensureWithin(input.multiRepoRoot, input.pageRoot)) {
      throw new Error("Qwen3 sayfa root'u multi-repo workspace sinirinin disinda olamaz.");
    }
    const [realMultiRepoRoot, realPageRoot] = await Promise.all([
      fs.realpath(input.multiRepoRoot),
      fs.realpath(input.pageRoot)
    ]);
    if (!ensureWithin(realMultiRepoRoot, realPageRoot)) {
      throw new Error("Qwen3 sayfa root'u symlink cozumlemesinden sonra multi-repo workspace sinirinin disinda olamaz.");
    }
    ensureNotCancelled(input.token);
    await fs.mkdir(input.pageRoot, { recursive: true });

    const chunker = new QwenPageDraftContextChunker({
      maxChunkCharacters: this.options.maxChunkCharacters,
      maxSourceFileCharacters: this.options.maxSourceFileCharacters,
      maxTotalSourceCharacters: this.options.maxTotalSourceCharacters
    });
    input.onProgress?.({
      phase: "context",
      message: "Sayfa artefaktlari ve secili ham UI/BFF/BE kaynaklari chunk'laniyor.",
      completed: 0,
      total: 1,
      modelCalls: 0,
      reusedSteps: 0
    });
    const context = await chunker.build(input.pageRoot, input.manifest);
    if (!context.chunks.length) {
      throw new Error("Qwen3 sayfa taslagi icin kullanilabilir context chunk'i bulunamadi.");
    }

    const optionsFingerprint = sha256(JSON.stringify(serializableOptions(this.options)));
    // Semantic artifacts are derived, model-produced inputs. Keep their own
    // chunk/step hashes, but do not let a regenerated semantic file relocate an
    // otherwise resumable run. Core page artifacts and selected source files
    // remain part of the run identity.
    const resumeIdentityChunks = context.chunks.filter((chunk) => chunk.kind !== "semantic-artifact");
    const inputHash = sha256(JSON.stringify({
      promptVersion: qwenIterativePageDraftPromptVersion,
      optionsFingerprint,
      modelIdentity: this.options.modelIdentity,
      chunks: resumeIdentityChunks.map((chunk) => ({ id: chunk.id, hash: chunk.contentHash }))
    }));
    const statusRoot = path.join(input.pageRoot, ".qwen3-page-draft");
    const runRoot = path.join(statusRoot, "runs", inputHash.slice(0, 24));
    if (!ensureWithin(input.pageRoot, runRoot)) {
      throw new Error("Qwen3 run workspace page root sinirinin disinda olamaz.");
    }
    await fs.mkdir(runRoot, { recursive: true });
    const runManifestPath = path.join(runRoot, "run-manifest.json");
    const manifest = await this.loadOrCreateManifest({
      runManifestPath,
      inputHash,
      optionsFingerprint,
      chunks: context.chunks,
      includedSourceFiles: context.includedSourceFiles,
      warnings: context.warnings
    });
    manifest.status = "running";
    manifest.error = undefined;
    manifest.completedAt = undefined;
    await this.persistManifest(statusRoot, runRoot, manifest);

    const counters: InvocationCounters = { newModelCalls: 0, reusedSteps: 0 };
    let reduceLevels = 0;
    try {
      const ledgers: QwenPageFactLedger[] = [];
      for (let index = 0; index < context.chunks.length; index += 1) {
        ensureNotCancelled(input.token);
        const chunk = context.chunks[index];
        const prompt = buildQwenPageChunkAnalysisPrompt({
          chunkId: chunk.id,
          sourceLabel: chunk.sourceLabel,
          content: chunk.content
        });
        assertPromptBudget(prompt, this.options.maxInputCharacters, chunk.sourceLabel);
        input.onProgress?.({
          phase: "analysis",
          message: `Qwen3 evidence chunk ${index + 1}/${context.chunks.length} analiz ediliyor: ${chunk.sourceLabel}`,
          completed: index,
          total: context.chunks.length,
          modelCalls: counters.newModelCalls,
          reusedSteps: counters.reusedSteps
        });
        const result = await this.runJsonLedgerStep({
          runRoot,
          statusRoot,
          manifest,
          counters,
          stepId: `analysis-${chunk.id}`,
          kind: "analysis",
          contextText: chunk.content,
          prompt,
          token: input.token,
          onUsage: (usage) => input.onProgress?.({
            phase: "analysis",
            message: `Qwen3 evidence chunk ${index + 1}/${context.chunks.length} tamamlandi.`,
            completed: index + 1,
            total: context.chunks.length,
            modelCalls: counters.newModelCalls,
            reusedSteps: counters.reusedSteps,
            usage
          })
        });
        ledgers.push(result.value);
      }

      const reduced = await this.reduceLedgers({
        ledgers,
        runRoot,
        statusRoot,
        manifest,
        counters,
        token: input.token,
        onProgress: input.onProgress
      });
      reduceLevels = reduced.levels;

      const page = asRecord(context.pageFlow.selectedPage);
      const pageName = maskSecretsWithStats(String(page.pageName ?? path.basename(input.pageRoot))).text;
      const route = page.route ? maskSecretsWithStats(String(page.route)).text : undefined;
      const ledgerText = serializeLedgerList(reduced.ledgers);
      const finalPrompt = buildQwenPageFinalSynthesisPrompt({ pageName, route, ledger: ledgerText });
      assertPromptBudget(finalPrompt, this.options.maxInputCharacters, "final synthesis");
      input.onProgress?.({
        phase: "synthesis",
        message: "Qwen3 nihai Turkce sayfa dokumanini sentezliyor.",
        completed: 0,
        total: 1,
        modelCalls: counters.newModelCalls,
        reusedSteps: counters.reusedSteps
      });
      const finalStep = await this.runMarkdownStep({
        runRoot,
        statusRoot,
        manifest,
        counters,
        stepId: `final-synthesis-${sha256(ledgerText).slice(0, 16)}`,
        kind: "synthesis",
        contextText: ledgerText,
        prompt: finalPrompt,
        token: input.token,
        onUsage: (usage) => input.onProgress?.({
          phase: "synthesis",
          message: "Qwen3 nihai sayfa dokumani sentezlendi.",
          completed: 1,
          total: 1,
          modelCalls: counters.newModelCalls,
          reusedSteps: counters.reusedSteps,
          usage
        })
      });

      const canonicalMarkdown = appendCoverageWarnings(
        ensureCanonicalSections(finalStep.value),
        context.warnings
      );
      const metadata = await buildPageArtifactMetadata(input.pageRoot, [
        "page-flow.json",
        "page-context-pack.md",
        "page-evidence-pack.md",
        "qwen-page-semantics.json",
        "qwen-interaction-semantics.jsonl"
      ]);
      const generationMetadata = {
        provider: "qwen",
        model: manifest.modelIds.at(-1) ?? this.options.modelIdentity,
        pipeline: manifest.pipeline,
        promptVersion: manifest.promptVersion,
        runId: manifest.runId,
        inputHash,
        chunks: context.chunks.length,
        reduceLevels
      };
      const published = [
        pageMetadataComment(metadata),
        `<!-- bank-spring-docs-generation ${JSON.stringify(generationMetadata)} -->`,
        "",
        canonicalMarkdown.trim(),
        ""
      ].join("\n");
      const qwenDraftPath = path.join(input.pageRoot, "qwen-draft.md");
      const compatibilityDraftPath = path.join(input.pageRoot, "copilot-draft.md");
      input.onProgress?.({
        phase: "publish",
        message: "Qwen ve mevcut page pipeline uyumluluk taslaklari atomik yaziliyor.",
        completed: 0,
        total: 1,
        modelCalls: counters.newModelCalls,
        reusedSteps: counters.reusedSteps
      });
      await this.publishDrafts({
        pageRoot: input.pageRoot,
        runRoot,
        statusRoot,
        manifest,
        inputHash: sha256(published),
        content: published,
        qwenDraftPath,
        compatibilityDraftPath
      });
      manifest.status = "completed";
      manifest.completedAt = this.timestamp();
      manifest.currentStep = undefined;
      manifest.qwenDraftPath = qwenDraftPath;
      manifest.compatibilityDraftPath = compatibilityDraftPath;
      await this.persistManifest(statusRoot, runRoot, manifest);
      input.onProgress?.({
        phase: "publish",
        message: "Qwen3 sayfa taslagi tamamlandi.",
        completed: 1,
        total: 1,
        modelCalls: counters.newModelCalls,
        reusedSteps: counters.reusedSteps
      });

      return {
        qwenDraftPath,
        draftPath: compatibilityDraftPath,
        runRoot,
        runManifestPath,
        inputHash,
        chunkCount: context.chunks.length,
        modelCallCount: manifest.requestCount,
        newModelCallCount: counters.newModelCalls,
        reusedStepCount: counters.reusedSteps,
        reduceLevels,
        estimatedTotalTokens: manifest.estimatedTotalTokens,
        includedSourceFiles: context.includedSourceFiles,
        warnings: context.warnings,
        modelIds: [...manifest.modelIds]
      };
    } catch (error) {
      const cancelled = input.token.isCancellationRequested || /cancel/i.test(error instanceof Error ? error.message : String(error));
      manifest.status = cancelled ? "cancelled" : "failed";
      manifest.completedAt = this.timestamp();
      manifest.error = safeError(error);
      const current = manifest.currentStep ? manifest.steps[manifest.currentStep] : undefined;
      if (current && current.status === "running") {
        current.status = cancelled ? "cancelled" : "failed";
        current.completedAt = this.timestamp();
        current.error = manifest.error;
      }
      await this.persistManifest(statusRoot, runRoot, manifest).catch(() => undefined);
      throw error;
    }
  }

  private async reduceLedgers(input: {
    ledgers: QwenPageFactLedger[];
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    counters: InvocationCounters;
    token: vscode.CancellationToken;
    onProgress?: QwenIterativePageDraftInput["onProgress"];
  }): Promise<{ ledgers: QwenPageFactLedger[]; levels: number }> {
    const payloadBudget = this.options.maxInputCharacters - promptOverheadReserve;
    let fragments = input.ledgers.flatMap((ledger) => splitLedgerForBudget(ledger, payloadBudget));
    let level = 0;

    while (serializeLedgerList(fragments).length > payloadBudget) {
      if (level >= this.options.maxReduceLevels) {
        throw new Error(
          `Qwen3 evidence ledger ${this.options.maxReduceLevels} reduce seviyesinden sonra da context butcesine sigmadi.`
        );
      }
      level += 1;
      const batches = packLedgers(fragments, payloadBudget);
      const next: QwenPageFactLedger[] = [];
      for (let index = 0; index < batches.length; index += 1) {
        ensureNotCancelled(input.token);
        const ledgerText = serializeLedgerList(batches[index]);
        const batchHash = sha256(ledgerText).slice(0, 16);
        const prompt = buildQwenPageLedgerReducePrompt({
          level,
          batchId: `${index + 1}/${batches.length}`,
          ledgers: ledgerText
        });
        assertPromptBudget(prompt, this.options.maxInputCharacters, `reduce level ${level} batch ${index + 1}`);
        input.onProgress?.({
          phase: "reduce",
          message: `Qwen3 ledger reduce seviye ${level}, batch ${index + 1}/${batches.length}.`,
          completed: index,
          total: batches.length,
          modelCalls: input.counters.newModelCalls,
          reusedSteps: input.counters.reusedSteps
        });
        const result = await this.runJsonLedgerStep({
          runRoot: input.runRoot,
          statusRoot: input.statusRoot,
          manifest: input.manifest,
          counters: input.counters,
          stepId: `reduce-${level}-${index + 1}-${batchHash}`,
          kind: "reduce",
          contextText: ledgerText,
          prompt,
          token: input.token
        });
        next.push(result.value);
      }
      fragments = next.flatMap((ledger) => splitLedgerForBudget(ledger, payloadBudget));
    }
    return { ledgers: fragments, levels: level };
  }

  private async runJsonLedgerStep(input: {
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    counters: InvocationCounters;
    stepId: string;
    kind: "analysis" | "reduce";
    contextText: string;
    prompt: DocumentationModelRequest;
    token: vscode.CancellationToken;
    onUsage?: (usage: DocumentationModelUsage) => void;
  }): Promise<StepResult<QwenPageFactLedger>> {
    return this.runModelStep({
      ...input,
      extension: "json",
      parse: (raw) => normalizeLedger(parseStrictJson(cleanModelText(raw))),
      serialize: (ledger) => `${JSON.stringify(ledger, null, 2)}\n`
    });
  }

  private async runMarkdownStep(input: {
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    counters: InvocationCounters;
    stepId: string;
    kind: "synthesis";
    contextText: string;
    prompt: DocumentationModelRequest;
    token: vscode.CancellationToken;
    onUsage?: (usage: DocumentationModelUsage) => void;
  }): Promise<StepResult<string>> {
    return this.runModelStep({
      ...input,
      extension: "md",
      parse: (raw) => {
        const clean = cleanModelText(raw).trim();
        if (!clean) {
          throw new Error("Qwen3 final synthesis bos yanit dondurdu.");
        }
        return clean;
      },
      serialize: (markdown) => `${markdown.trim()}\n`
    });
  }

  private async runModelStep<T>(input: {
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    counters: InvocationCounters;
    stepId: string;
    kind: "analysis" | "reduce" | "synthesis";
    contextText: string;
    prompt: DocumentationModelRequest;
    token: vscode.CancellationToken;
    extension: "json" | "md";
    parse: (raw: string) => T;
    serialize: (value: T) => string;
    onUsage?: (usage: DocumentationModelUsage) => void;
  }): Promise<StepResult<T>> {
    const stepId = safeName(input.stepId) || `step-${sha256(input.stepId).slice(0, 12)}`;
    const stepInputHash = sha256(input.prompt.combinedText ?? `${input.prompt.instructions}\n${input.prompt.userPrompt}`);
    const existing = input.manifest.steps[stepId];
    if (existing?.status === "completed" && existing.inputHash === stepInputHash && existing.outputPath && existing.outputHash) {
      const outputPath = resolveRunArtifact(input.runRoot, existing.outputPath);
      const reusable = await readReusableOutput(outputPath, existing.outputHash);
      if (reusable !== undefined) {
        const value = input.parse(reusable);
        input.counters.reusedSteps += 1;
        return { value, reused: true };
      }
    }

    if (input.counters.newModelCalls >= this.options.maxModelCalls) {
      throw new Error(
        `Qwen3 sayfa pipeline'i bu calistirmada ${this.options.maxModelCalls} yeni model cagrisi sinirina ulasti. Ara ciktilar resume icin korundu.`
      );
    }
    ensureNotCancelled(input.token);
    const stepRoot = path.join(input.runRoot, "steps");
    const contextPath = path.join(stepRoot, `${stepId}-context.md`);
    const promptPath = path.join(stepRoot, `${stepId}-prompt.md`);
    const outputPath = path.join(stepRoot, `${stepId}-output.${input.extension}`);
    await atomicWriteFile(contextPath, input.contextText);
    await atomicWriteFile(promptPath, input.prompt.combinedText ?? `${input.prompt.instructions ?? ""}\n\n${input.prompt.userPrompt}`);

    const step: QwenPageDraftRunStep = {
      id: stepId,
      kind: input.kind,
      status: "running",
      inputHash: stepInputHash,
      attempt: (existing?.attempt ?? 0) + 1,
      contextPath: path.relative(input.runRoot, contextPath),
      promptPath: path.relative(input.runRoot, promptPath),
      outputPath: path.relative(input.runRoot, outputPath),
      startedAt: this.timestamp()
    };
    input.manifest.steps[stepId] = step;
    input.manifest.currentStep = stepId;
    input.manifest.status = "running";
    input.manifest.requestCount += 1;
    input.counters.newModelCalls += 1;
    await this.persistManifest(input.statusRoot, input.runRoot, input.manifest);

    try {
      const response = await this.client.send(input.prompt, input.token, input.onUsage);
      validateQwen3Response(response, this.options.expectedModelMarker);
      const safeResponse = maskSecretsWithStats(response.text).text;
      let value: T;
      try {
        value = input.parse(safeResponse);
      } catch (parseError) {
        const rawOutputPath = path.join(stepRoot, `${stepId}-raw.txt`);
        await atomicWriteFile(rawOutputPath, safeResponse);
        step.rawOutputPath = path.relative(input.runRoot, rawOutputPath);
        await this.persistManifest(input.statusRoot, input.runRoot, input.manifest);
        throw parseError;
      }
      const serialized = input.serialize(value);
      await atomicWriteFile(outputPath, serialized);
      step.status = "completed";
      step.completedAt = this.timestamp();
      step.outputHash = sha256(serialized);
      step.modelId = response.model.id;
      step.usage = response.usage;
      step.error = undefined;
      input.manifest.currentStep = undefined;
      input.manifest.estimatedTotalTokens += response.usage.estimatedTotalTokens;
      input.manifest.modelIds = [...new Set([...input.manifest.modelIds, response.model.id])];
      await this.persistManifest(input.statusRoot, input.runRoot, input.manifest);
      return { value, response, reused: false };
    } catch (error) {
      step.status = input.token.isCancellationRequested ? "cancelled" : "failed";
      step.completedAt = this.timestamp();
      step.error = safeError(error);
      await this.persistManifest(input.statusRoot, input.runRoot, input.manifest).catch(() => undefined);
      throw error;
    }
  }

  private async publishDrafts(input: {
    pageRoot: string;
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    inputHash: string;
    content: string;
    qwenDraftPath: string;
    compatibilityDraftPath: string;
  }): Promise<void> {
    const stepId = "publish-qwen-and-compatibility-drafts";
    const existing = input.manifest.steps[stepId];
    if (existing?.status === "completed" && existing.inputHash === input.inputHash) {
      const [qwen, compatibility] = await Promise.all([
        readOptional(input.qwenDraftPath),
        readOptional(input.compatibilityDraftPath)
      ]);
      if (sha256(qwen) === input.inputHash && sha256(compatibility) === input.inputHash) {
        return;
      }
    }
    const step: QwenPageDraftRunStep = {
      id: stepId,
      kind: "publish",
      status: "running",
      inputHash: input.inputHash,
      attempt: (existing?.attempt ?? 0) + 1,
      startedAt: this.timestamp(),
      outputPath: path.relative(input.runRoot, input.qwenDraftPath)
    };
    input.manifest.steps[stepId] = step;
    input.manifest.currentStep = stepId;
    await this.persistManifest(input.statusRoot, input.runRoot, input.manifest);
    await backupDifferentCanonical(input.compatibilityDraftPath, input.content, this.timestamp());
    await atomicWriteFile(input.qwenDraftPath, input.content);
    await atomicWriteFile(input.compatibilityDraftPath, input.content);
    step.status = "completed";
    step.completedAt = this.timestamp();
    step.outputHash = input.inputHash;
    input.manifest.currentStep = undefined;
    await this.persistManifest(input.statusRoot, input.runRoot, input.manifest);
  }

  private async loadOrCreateManifest(input: {
    runManifestPath: string;
    inputHash: string;
    optionsFingerprint: string;
    chunks: QwenPageDraftContextChunk[];
    includedSourceFiles: string[];
    warnings: string[];
  }): Promise<QwenPageDraftRunManifest> {
    const loaded = await readJson<QwenPageDraftRunManifest>(input.runManifestPath);
    if (
      loaded?.schemaVersion === 1 &&
      loaded.pipeline === "qwen3-iterative-page-draft" &&
      loaded.inputHash === input.inputHash &&
      loaded.optionsFingerprint === input.optionsFingerprint &&
      loaded.modelIdentity === this.options.modelIdentity &&
      loaded.expectedModelMarker === this.options.expectedModelMarker
    ) {
      return {
        ...loaded,
        chunks: chunkSummaries(input.chunks),
        includedSourceFiles: input.includedSourceFiles,
        warnings: input.warnings,
        steps: loaded.steps ?? {},
        modelIds: loaded.modelIds ?? []
      };
    }
    const now = this.timestamp();
    return {
      schemaVersion: 1,
      pipeline: "qwen3-iterative-page-draft",
      promptVersion: qwenIterativePageDraftPromptVersion,
      runId: safeName(this.options.runIdFactory()) || randomUUID(),
      status: "running",
      inputHash: input.inputHash,
      optionsFingerprint: input.optionsFingerprint,
      modelIdentity: this.options.modelIdentity,
      expectedModelMarker: this.options.expectedModelMarker,
      startedAt: now,
      updatedAt: now,
      requestCount: 0,
      estimatedTotalTokens: 0,
      modelIds: [],
      chunks: chunkSummaries(input.chunks),
      includedSourceFiles: input.includedSourceFiles,
      warnings: input.warnings,
      steps: {}
    };
  }

  private async persistManifest(statusRoot: string, runRoot: string, manifest: QwenPageDraftRunManifest): Promise<void> {
    manifest.updatedAt = this.timestamp();
    await atomicWriteJson(path.join(runRoot, "run-manifest.json"), manifest);
    await atomicWriteJson(path.join(statusRoot, "latest-run.json"), {
      pipeline: manifest.pipeline,
      runId: manifest.runId,
      status: manifest.status,
      inputHash: manifest.inputHash,
      updatedAt: manifest.updatedAt,
      runManifestPath: path.relative(statusRoot, path.join(runRoot, "run-manifest.json")),
      qwenDraftPath: manifest.qwenDraftPath,
      compatibilityDraftPath: manifest.compatibilityDraftPath
    });
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

function normalizeOptions(options: QwenIterativePageDraftOptions): NormalizedOptions {
  const maxInputCharacters = positiveInteger(options.maxInputCharacters ?? defaults.maxInputCharacters, "maxInputCharacters", 1000000);
  if (maxInputCharacters <= promptOverheadReserve + 1000) {
    throw new Error(`maxInputCharacters en az ${promptOverheadReserve + 1001} olmalidir.`);
  }
  const requestedChunk = positiveInteger(options.maxChunkCharacters ?? defaults.maxChunkCharacters, "maxChunkCharacters");
  const modelIdentity = (options.modelIdentity ?? defaults.modelIdentity).trim();
  const expectedModelMarker = (options.expectedModelMarker ?? defaults.expectedModelMarker).trim().toLowerCase();
  if (!modelIdentity || !expectedModelMarker) {
    throw new Error("Qwen3 modelIdentity ve expectedModelMarker bos olamaz.");
  }
  if (!containsIdentitySegment(modelIdentity, expectedModelMarker)) {
    throw new Error(`Qwen3-only pipeline modelIdentity '${modelIdentity}' expected marker '${expectedModelMarker}' icermelidir.`);
  }
  return {
    maxInputCharacters,
    maxChunkCharacters: Math.min(requestedChunk, maxInputCharacters - promptOverheadReserve),
    maxSourceFileCharacters: positiveInteger(options.maxSourceFileCharacters ?? defaults.maxSourceFileCharacters, "maxSourceFileCharacters", 1000000),
    maxTotalSourceCharacters: positiveInteger(options.maxTotalSourceCharacters ?? defaults.maxTotalSourceCharacters, "maxTotalSourceCharacters", 5000000),
    maxModelCalls: positiveInteger(options.maxModelCalls ?? defaults.maxModelCalls, "maxModelCalls", 200),
    maxReduceLevels: positiveInteger(options.maxReduceLevels ?? defaults.maxReduceLevels, "maxReduceLevels", 10),
    modelIdentity,
    expectedModelMarker,
    now: options.now ?? (() => new Date()),
    runIdFactory: options.runIdFactory ?? (() => `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`)
  };
}

function serializableOptions(options: NormalizedOptions): Record<string, unknown> {
  return {
    maxInputCharacters: options.maxInputCharacters,
    maxChunkCharacters: options.maxChunkCharacters,
    maxSourceFileCharacters: options.maxSourceFileCharacters,
    maxTotalSourceCharacters: options.maxTotalSourceCharacters,
    modelIdentity: options.modelIdentity,
    expectedModelMarker: options.expectedModelMarker
  };
}

function chunkSummaries(chunks: QwenPageDraftContextChunk[]): QwenPageDraftRunManifest["chunks"] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    kind: chunk.kind,
    sourceLabel: chunk.sourceLabel,
    contentHash: chunk.contentHash,
    characters: chunk.characters,
    maskedSecrets: chunk.maskedSecrets,
    role: chunk.role,
    sourceFile: chunk.sourceFile
  }));
}

function normalizeLedger(value: unknown): QwenPageFactLedger {
  const record = asRecord(value);
  const rawSections = Array.isArray(record.sections) ? record.sections : [];
  const byHeading = new Map<string, QwenPageFactSection>();
  for (const item of rawSections) {
    const section = asRecord(item);
    const heading = canonicalHeading(String(section.heading ?? ""));
    if (!heading) {
      continue;
    }
    const current = byHeading.get(heading) ?? {
      heading,
      findings: [],
      sourceReferences: [],
      uncertainties: []
    };
    current.findings.push(...stringArray(section.findings));
    current.sourceReferences.push(...stringArray(section.sourceReferences));
    current.uncertainties.push(...stringArray(section.uncertainties));
    byHeading.set(heading, current);
  }
  return {
    sections: qwenPageDocumentSections
      .map((heading) => byHeading.get(heading))
      .filter((section): section is QwenPageFactSection => Boolean(section))
      .map((section) => ({
        heading: section.heading,
        findings: uniqueStrings(section.findings),
        sourceReferences: uniqueStrings(section.sourceReferences),
        uncertainties: uniqueStrings(section.uncertainties)
      }))
  };
}

function splitLedgerForBudget(ledger: QwenPageFactLedger, maxCharacters: number): QwenPageFactLedger[] {
  const normalized = normalizeLedger(ledger);
  if (JSON.stringify(normalized).length <= maxCharacters) {
    return [normalized];
  }
  const boundedSections = normalized.sections.flatMap((section) => splitFactSectionForBudget(section, maxCharacters));
  const result: QwenPageFactLedger[] = [];
  let sections: QwenPageFactSection[] = [];
  for (const section of boundedSections) {
    const candidate = { sections: [...sections, section] };
    if (sections.length && JSON.stringify(candidate).length > maxCharacters) {
      result.push({ sections });
      sections = [section];
    } else {
      sections.push(section);
    }
  }
  if (sections.length) {
    result.push({ sections });
  }
  if (result.some((item) => JSON.stringify(item).length > maxCharacters)) {
    throw new Error("Tek bir Qwen3 ledger bolumu reduce context butcesini asiyor.");
  }
  return result;
}

function splitFactSectionForBudget(section: QwenPageFactSection, maxCharacters: number): QwenPageFactSection[] {
  if (JSON.stringify({ sections: [section] }).length <= maxCharacters) {
    return [section];
  }
  const empty = (): QwenPageFactSection => ({
    heading: section.heading,
    findings: [],
    sourceReferences: [],
    uncertainties: []
  });
  const overhead = JSON.stringify({ sections: [empty()] }).length + 32;
  const maxItemCharacters = Math.max(64, maxCharacters - overhead);
  const items: Array<{ key: "findings" | "sourceReferences" | "uncertainties"; value: string }> = [
    ...section.findings.flatMap((value) => splitBoundedString(value, maxItemCharacters).map((part) => ({ key: "findings" as const, value: part }))),
    ...section.sourceReferences.flatMap((value) => splitBoundedString(value, maxItemCharacters).map((part) => ({ key: "sourceReferences" as const, value: part }))),
    ...section.uncertainties.flatMap((value) => splitBoundedString(value, maxItemCharacters).map((part) => ({ key: "uncertainties" as const, value: part })))
  ];
  const result: QwenPageFactSection[] = [];
  let current = empty();
  for (const item of items) {
    const candidate: QwenPageFactSection = {
      ...current,
      findings: [...current.findings],
      sourceReferences: [...current.sourceReferences],
      uncertainties: [...current.uncertainties]
    };
    candidate[item.key].push(item.value);
    if (hasFactItems(current) && JSON.stringify({ sections: [candidate] }).length > maxCharacters) {
      result.push(current);
      current = empty();
      current[item.key].push(item.value);
    } else {
      current = candidate;
    }
  }
  if (hasFactItems(current) || !result.length) {
    result.push(current);
  }
  if (result.some((item) => JSON.stringify({ sections: [item] }).length > maxCharacters)) {
    throw new Error("Qwen3 ledger alani bounded parcalamadan sonra context butcesini asiyor.");
  }
  return result;
}

function splitBoundedString(value: string, maxCharacters: number): string[] {
  if (value.length <= maxCharacters) {
    return [value];
  }
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxCharacters) {
    parts.push(value.slice(offset, offset + maxCharacters));
  }
  return parts;
}

function hasFactItems(section: QwenPageFactSection): boolean {
  return Boolean(section.findings.length || section.sourceReferences.length || section.uncertainties.length);
}

function packLedgers(ledgers: QwenPageFactLedger[], maxCharacters: number): QwenPageFactLedger[][] {
  const batches: QwenPageFactLedger[][] = [];
  let current: QwenPageFactLedger[] = [];
  for (const ledger of ledgers) {
    const candidate = [...current, ledger];
    if (current.length && serializeLedgerList(candidate).length > maxCharacters) {
      batches.push(current);
      current = [ledger];
    } else {
      current = candidate;
    }
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

function serializeLedgerList(ledgers: QwenPageFactLedger[]): string {
  return ledgers.map((ledger, index) => `LEDGER ${index + 1}\n${JSON.stringify(ledger, null, 2)}`).join("\n\n---\n\n");
}

function ensureCanonicalSections(markdown: string): string {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  const sections = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = current.index ?? 0;
    const end = matches[index + 1]?.index ?? markdown.length;
    const heading = canonicalHeading(current[1]);
    const body = markdown.slice(start + current[0].length, end).trim();
    if (heading) {
      sections.set(heading, [...(sections.get(heading) ?? []), body].filter(Boolean));
    } else {
      unmatched.push(markdown.slice(start, end).trim());
    }
  }
  const preamble = matches.length ? markdown.slice(0, matches[0].index ?? 0).trim() : markdown.trim();
  const canonical = qwenPageDocumentSections.map((heading) => [
    `## ${heading}`,
    (sections.get(heading) ?? []).join("\n\n") || "Provided context içinde net görünmüyor."
  ].join("\n\n"));
  return [preamble, ...canonical, ...unmatched].filter(Boolean).join("\n\n");
}

function appendCoverageWarnings(markdown: string, warnings: string[]): string {
  const safeWarnings = uniqueStrings(warnings.map((warning) => maskSecretsWithStats(warning).text))
    .map((warning) => warning.length <= 800 ? warning : `${warning.slice(0, 765)} [WARNING_TEXT_TRUNCATED]`);
  if (!safeWarnings.length) {
    return markdown;
  }

  const maxWarningCharacters = 8000;
  const included: string[] = [];
  let characters = 0;
  for (const warning of safeWarnings) {
    const item = `- ${warning}`;
    if (characters + item.length > maxWarningCharacters) {
      break;
    }
    included.push(item);
    characters += item.length;
  }
  if (included.length < safeWarnings.length) {
    included.push(`- ${safeWarnings.length - included.length} ek pipeline kapsama uyarisi boyut siniri nedeniyle burada listelenmedi; run manifestindeki maskelenmis warnings alani korunmustur.`);
  }

  const uncertaintyHeading = qwenPageDocumentSections.at(-1);
  if (!uncertaintyHeading) {
    return markdown;
  }
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  const index = headings.findIndex((match) => canonicalHeading(match[1]) === uncertaintyHeading);
  if (index < 0) {
    return `${markdown.trim()}\n\n## ${uncertaintyHeading}\n\n### Pipeline Kapsam Uyarilari\n\n${included.join("\n")}`;
  }
  const insertAt = headings[index + 1]?.index ?? markdown.length;
  const warningBlock = `\n\n### Pipeline Kapsam Uyarilari\n\n${included.join("\n")}\n\n`;
  return `${markdown.slice(0, insertAt).trimEnd()}${warningBlock}${markdown.slice(insertAt).trimStart()}`.trim();
}

function canonicalHeading(value: string): string | undefined {
  const normalized = foldToAscii(value).replace(/^\s*\d+[.)\-\s]+/, "").replace(/[^a-z0-9]/g, "");
  return qwenPageDocumentSections.find((heading) =>
    foldToAscii(heading).replace(/[^a-z0-9]/g, "") === normalized
  );
}

function foldToAscii(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u011f/g, "g")
    .replace(/\u00fc/g, "u")
    .replace(/\u015f/g, "s")
    .replace(/\u00f6/g, "o")
    .replace(/\u00e7/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function validateQwen3Response(response: DocumentationModelResponse, expectedMarker: string): void {
  if (response.provider !== "qwen") {
    throw new Error(`Qwen3-only pipeline provider '${response.provider}' yanitini kabul etmez.`);
  }
  const identity = `${response.model.id} ${response.model.name} ${response.model.family}`.toLowerCase();
  if (!containsIdentitySegment(identity, expectedMarker)) {
    throw new Error(`Qwen3-only pipeline beklenmeyen model yaniti aldi: ${response.model.id}.`);
  }
  if (!response.text.trim()) {
    throw new Error("Qwen3 bos model yaniti dondurdu.");
  }
}

function containsIdentitySegment(identity: string, expectedMarker: string): boolean {
  const marker = expectedMarker.trim().toLowerCase();
  if (!marker) {
    return false;
  }
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(identity);
}

function assertPromptBudget(prompt: DocumentationModelRequest, maxCharacters: number, label: string): void {
  const combined = prompt.combinedText ?? `${prompt.instructions ?? ""}\n\n${prompt.userPrompt}`;
  if (combined.length > maxCharacters) {
    throw new Error(`${label} promptu ${combined.length} karakterle Qwen3 ${maxCharacters} karakter context butcesini asti.`);
  }
}

function cleanModelText(value: string): string {
  const withoutThinking = value
    .replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "")
    .trim();
  const outerFence = withoutThinking.match(/^```(?:json|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return (outerFence?.[1] ?? withoutThinking).trim();
}

function ensureNotCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new Error("Qwen3 sayfa pipeline'i kullanici tarafindan iptal edildi.");
  }
}

function safeError(error: unknown): string {
  return maskSecretsWithStats(error instanceof Error ? error.message : String(error)).text.slice(0, 4000);
}

function resolveRunArtifact(runRoot: string, relativePath: string): string {
  const resolved = path.resolve(runRoot, relativePath);
  if (!ensureWithin(runRoot, resolved)) {
    throw new Error("Resume artifact path run workspace sinirinin disinda.");
  }
  return resolved;
}

async function readReusableOutput(filePath: string, expectedHash: string): Promise<string | undefined> {
  const content = await readOptional(filePath);
  return content && sha256(content) === expectedHash ? content : undefined;
}

async function backupDifferentCanonical(filePath: string, nextContent: string, timestamp: string): Promise<void> {
  const previous = await readOptional(filePath);
  if (!previous || previous === nextContent) {
    return;
  }
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  await fs.copyFile(filePath, `${filePath}.bak-${safeTimestamp}`);
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}
