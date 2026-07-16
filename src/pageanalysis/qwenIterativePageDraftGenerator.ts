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
  /** Output budgets are phase-specific so short map calls do not reserve final-document capacity. */
  analysisMaxOutputTokens?: number;
  reduceMaxOutputTokens?: number;
  synthesisMaxOutputTokens?: number;
  /** Number of bounded retries for transient gateway/network failures before adaptive splitting. */
  maxGatewayRetries?: number;
  retryBaseDelayMs?: number;
  /** Repeatedly failing evidence chunks may be split into deterministic overlapping children. */
  maxAdaptiveSplitDepth?: number;
  minAdaptiveSplitCharacters?: number;
  adaptiveSplitOverlapCharacters?: number;
  /** Number of canonical sections rendered by one bounded synthesis request. */
  finalSectionGroupSize?: number;
  /** Qwen deployment identity included in resume compatibility. */
  modelIdentity?: string;
  /** Every response model id/name must contain this marker. */
  expectedModelMarker?: string;
  /** Deterministic injection seam for tests. */
  now?: () => Date;
  /** Deterministic injection seam for tests. */
  runIdFactory?: () => string;
  /** Deterministic no-sleep seam for retry tests. */
  delay?: (milliseconds: number, token: vscode.CancellationToken) => Promise<void>;
  /** Optional run-wide budget hook shared with semantic and repair phases. */
  onModelCall?: (phase: "analysis" | "reduce" | "synthesis") => void;
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
  resolution?: "adaptive-split";
  splitInto?: string[];
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
  adaptiveSplits?: Record<string, {
    inputHash: string;
    depth: number;
    childHashes: string[];
    reason: string;
    createdAt: string;
  }>;
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
  analysisMaxOutputTokens: number;
  reduceMaxOutputTokens: number;
  synthesisMaxOutputTokens: number;
  maxGatewayRetries: number;
  retryBaseDelayMs: number;
  maxAdaptiveSplitDepth: number;
  minAdaptiveSplitCharacters: number;
  adaptiveSplitOverlapCharacters: number;
  finalSectionGroupSize: number;
  modelIdentity: string;
  expectedModelMarker: string;
  now: () => Date;
  runIdFactory: () => string;
  delay: (milliseconds: number, token: vscode.CancellationToken) => Promise<void>;
  onModelCall?: (phase: "analysis" | "reduce" | "synthesis") => void;
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
  maxModelCalls: 96,
  maxReduceLevels: 5,
  analysisMaxOutputTokens: 2048,
  reduceMaxOutputTokens: 3072,
  synthesisMaxOutputTokens: 4096,
  maxGatewayRetries: 2,
  retryBaseDelayMs: 750,
  maxAdaptiveSplitDepth: 3,
  minAdaptiveSplitCharacters: 4000,
  adaptiveSplitOverlapCharacters: 600,
  finalSectionGroupSize: 4,
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
        input.onProgress?.({
          phase: "analysis",
          message: `Qwen3 evidence chunk ${index + 1}/${context.chunks.length} analiz ediliyor: ${chunk.sourceLabel}`,
          completed: index,
          total: context.chunks.length,
          modelCalls: counters.newModelCalls,
          reusedSteps: counters.reusedSteps
        });
        const chunkLedgers = await this.analyzeChunkWithResilience({
          runRoot,
          statusRoot,
          manifest,
          counters,
          chunkId: chunk.id,
          sourceLabel: chunk.sourceLabel,
          content: chunk.content,
          depth: 0,
          token: input.token,
          onProgress: input.onProgress,
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
        ledgers.push(...chunkLedgers);
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
      const groups = sectionGroups(this.options.finalSectionGroupSize);
      const finalParts: string[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        ensureNotCancelled(input.token);
        const sections = groups[index];
        const groupId = `group-${index + 1}-of-${groups.length}`;
        const ledgerText = serializeLedgerForSections(reduced.ledgers, sections);
        const groupOutputTokens = sectionGroupOutputTokens(
          sections.length,
          this.options.synthesisMaxOutputTokens
        );
        const finalPrompt: DocumentationModelRequest = {
          ...buildQwenPageFinalSynthesisPrompt({ pageName, route, ledger: ledgerText, sections, groupId }),
          maxOutputTokens: groupOutputTokens
        };
        assertPromptBudget(finalPrompt, this.options.maxInputCharacters, `final synthesis ${groupId}`);
        input.onProgress?.({
          phase: "synthesis",
          message: `Qwen3 nihai dokuman bolum grubu ${index + 1}/${groups.length} sentezleniyor.`,
          completed: index,
          total: groups.length,
          modelCalls: counters.newModelCalls,
          reusedSteps: counters.reusedSteps
        });
        let finalStep: StepResult<string>;
        try {
          finalStep = await this.runMarkdownStepWithRetry({
            runRoot,
            statusRoot,
            manifest,
            counters,
            stepId: `final-synthesis-${groupId}-${sha256(ledgerText).slice(0, 16)}`,
            kind: "synthesis",
            contextText: ledgerText,
            prompt: finalPrompt,
            token: input.token,
            onUsage: (usage) => input.onProgress?.({
              phase: "synthesis",
              message: `Qwen3 nihai dokuman bolum grubu ${index + 1}/${groups.length} tamamlandi.`,
              completed: index + 1,
              total: groups.length,
              modelCalls: counters.newModelCalls,
              reusedSteps: counters.reusedSteps,
              usage
            })
          });
        } catch (error) {
          if (isAdaptiveSplitQwenFailure(error) && sections.length > 1) {
            const midpoint = Math.ceil(sections.length / 2);
            const children = [sections.slice(0, midpoint), sections.slice(midpoint)]
              .filter((group) => group.length) as Array<Array<(typeof qwenPageDocumentSections)[number]>>;
            groups.splice(index, 1, ...children);
            manifest.warnings = uniqueStrings([
              ...manifest.warnings,
              `Qwen3 final synthesis ${groupId} timeout veya boyut siniri nedeniyle ${children.length} daha kucuk bolum grubuna ayrildi.`
            ]);
            await this.persistManifest(statusRoot, runRoot, manifest);
            index -= 1;
            continue;
          }
          throw error;
        }
        const selected = selectCanonicalSections(finalStep.value, sections);
        if (selected.markdown) {
          finalParts.push(selected.markdown);
        }
        if (selected.missingSections.length) {
          const missingNames = selected.missingSections.join(", ");
          manifest.warnings = uniqueStrings([
            ...manifest.warnings,
            `Qwen3 final synthesis ${groupId} yaniti beklenen bolumleri atladı; hedefli ikinci istek calistirildi: ${missingNames}.`
          ]);
          await this.persistManifest(statusRoot, runRoot, manifest);
          const repairLedgerText = serializeLedgerForSections(reduced.ledgers, selected.missingSections);
          const repairPrompt: DocumentationModelRequest = {
            ...buildQwenPageFinalSynthesisPrompt({
              pageName,
              route,
              ledger: repairLedgerText,
              sections: selected.missingSections,
              groupId: `${groupId}-missing-sections`
            }),
            maxOutputTokens: sectionGroupOutputTokens(
              selected.missingSections.length,
              this.options.synthesisMaxOutputTokens
            )
          };
          assertPromptBudget(repairPrompt, this.options.maxInputCharacters, `final synthesis ${groupId} missing sections`);
          const repairStep = await this.runMarkdownStepWithRetry({
            runRoot,
            statusRoot,
            manifest,
            counters,
            stepId: `final-synthesis-${groupId}-missing-${sha256(repairLedgerText).slice(0, 16)}`,
            kind: "synthesis",
            contextText: repairLedgerText,
            prompt: repairPrompt,
            token: input.token
          });
          const repaired = selectCanonicalSections(repairStep.value, selected.missingSections);
          if (repaired.markdown) {
            finalParts.push(repaired.markdown);
          }
          if (repaired.missingSections.length) {
            manifest.warnings = uniqueStrings([
              ...manifest.warnings,
              `Qwen3 final synthesis ${groupId} hedefli ikinci istekte de bolum atladı: ${repaired.missingSections.join(", ")}. Placeholder korunarak gap repair'e birakildi.`
            ]);
            await this.persistManifest(statusRoot, runRoot, manifest);
          }
        }
      }

      const canonicalMarkdown = appendCoverageWarnings(
        ensureCanonicalSections(finalParts.join("\n\n")),
        manifest.warnings
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
        warnings: manifest.warnings,
        modelIds: [...manifest.modelIds]
      };
    } catch (error) {
      const cancelled = input.token.isCancellationRequested || /cancel|iptal/i.test(error instanceof Error ? error.message : String(error));
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

  private async analyzeChunkWithResilience(input: {
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    counters: InvocationCounters;
    chunkId: string;
    sourceLabel: string;
    content: string;
    depth: number;
    token: vscode.CancellationToken;
    onProgress?: QwenIterativePageDraftInput["onProgress"];
    onUsage?: (usage: DocumentationModelUsage) => void;
  }): Promise<QwenPageFactLedger[]> {
    const stepId = `analysis-${input.chunkId}`;
    const prompt: DocumentationModelRequest = {
      ...buildQwenPageChunkAnalysisPrompt({
        chunkId: input.chunkId,
        sourceLabel: input.sourceLabel,
        content: input.content
      }),
      maxOutputTokens: this.options.analysisMaxOutputTokens
    };
    assertPromptBudget(prompt, this.options.maxInputCharacters, input.sourceLabel);
    const promptHash = modelRequestHash(prompt);
    const parts = splitAdaptiveChunk(
      input.content,
      this.options.minAdaptiveSplitCharacters,
      this.options.adaptiveSplitOverlapCharacters
    );
    const childInputs = parts?.map((content, index) => ({
      content,
      chunkId: `${input.chunkId}-d${input.depth + 1}-p${index + 1}-${sha256(content).slice(0, 10)}`
    }));
    const decision = input.manifest.adaptiveSplits?.[stepId];
    const reusableDecision = decision
      && decision.inputHash === promptHash
      && childInputs
      && equalStringArrays(decision.childHashes, childInputs.map((child) => sha256(child.content)));

    if (reusableDecision && childInputs) {
      const reused: QwenPageFactLedger[] = [];
      for (let index = 0; index < childInputs.length; index += 1) {
        const child = childInputs[index];
        reused.push(...await this.analyzeChunkWithResilience({
          ...input,
          chunkId: child.chunkId,
          sourceLabel: `${input.sourceLabel} [adaptive ${index + 1}/${childInputs.length}]`,
          content: child.content,
          depth: input.depth + 1
        }));
      }
      return reused;
    }

    try {
      const result = await this.runJsonLedgerStepWithRetry({
        runRoot: input.runRoot,
        statusRoot: input.statusRoot,
        manifest: input.manifest,
        counters: input.counters,
        stepId,
        kind: "analysis",
        contextText: input.content,
        sourceLabel: input.sourceLabel,
        prompt,
        token: input.token,
        onUsage: input.onUsage
      });
      return [result.value];
    } catch (error) {
      if (
        !isAdaptiveSplitQwenFailure(error) ||
        !childInputs ||
        input.depth >= this.options.maxAdaptiveSplitDepth
      ) {
        throw error;
      }
      ensureNotCancelled(input.token);
      const childHashes = childInputs.map((child) => sha256(child.content));
      input.manifest.adaptiveSplits ??= {};
      input.manifest.adaptiveSplits[stepId] = {
        inputHash: promptHash,
        depth: input.depth,
        childHashes,
        reason: boundedError(error),
        createdAt: this.timestamp()
      };
      const parentStep = input.manifest.steps[safeName(stepId) || stepId];
      if (parentStep) {
        parentStep.status = "completed";
        parentStep.completedAt = this.timestamp();
        parentStep.error = undefined;
        parentStep.resolution = "adaptive-split";
        parentStep.splitInto = childInputs.map((child) => `analysis-${child.chunkId}`);
      }
      input.manifest.currentStep = undefined;
      input.manifest.warnings = uniqueStrings([
        ...input.manifest.warnings,
        `${input.sourceLabel} timeout veya istek/yanit boyutu siniri nedeniyle ${childInputs.length} daha kucuk overlapping parcaya ayrildi.`
      ]);
      await this.persistManifest(input.statusRoot, input.runRoot, input.manifest);
      input.onProgress?.({
        phase: "analysis",
        message: `Qwen3 ${input.sourceLabel} istegi timeout ya da boyut siniri sonrasi ${childInputs.length} parcaya ayriliyor.`,
        completed: 0,
        total: childInputs.length,
        modelCalls: input.counters.newModelCalls,
        reusedSteps: input.counters.reusedSteps
      });
      const splitLedgers: QwenPageFactLedger[] = [];
      for (let index = 0; index < childInputs.length; index += 1) {
        const child = childInputs[index];
        splitLedgers.push(...await this.analyzeChunkWithResilience({
          ...input,
          chunkId: child.chunkId,
          sourceLabel: `${input.sourceLabel} [adaptive ${index + 1}/${childInputs.length}]`,
          content: child.content,
          depth: input.depth + 1
        }));
      }
      return splitLedgers;
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

    while (!ledgersFitFinalSectionGroups(fragments, payloadBudget, this.options.finalSectionGroupSize)) {
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
        const prompt: DocumentationModelRequest = {
          ...buildQwenPageLedgerReducePrompt({
            level,
            batchId: `${index + 1}/${batches.length}`,
            ledgers: ledgerText
          }),
          maxOutputTokens: this.options.reduceMaxOutputTokens
        };
        assertPromptBudget(prompt, this.options.maxInputCharacters, `reduce level ${level} batch ${index + 1}`);
        input.onProgress?.({
          phase: "reduce",
          message: `Qwen3 ledger reduce seviye ${level}, batch ${index + 1}/${batches.length}.`,
          completed: index,
          total: batches.length,
          modelCalls: input.counters.newModelCalls,
          reusedSteps: input.counters.reusedSteps
        });
        const result = await this.runJsonLedgerStepWithRetry({
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
    sourceLabel?: string;
    prompt: DocumentationModelRequest;
    token: vscode.CancellationToken;
    onUsage?: (usage: DocumentationModelUsage) => void;
  }): Promise<StepResult<QwenPageFactLedger>> {
    return this.runModelStep({
      ...input,
      extension: "json",
      parse: (raw) => {
        const ledger = normalizeLedger(parseStrictJson(cleanModelText(raw)));
        if (input.kind === "analysis") {
          if (!input.sourceLabel) {
            throw responseContractError("Qwen3 analysis ledger source label bilgisi eksik.");
          }
          return groundLedgerToSuppliedSource(ledger, input.sourceLabel, input.contextText);
        }
        return demoteUnreferencedFindings(ledger);
      },
      serialize: (ledger) => `${JSON.stringify(ledger, null, 2)}\n`
    });
  }

  private async runJsonLedgerStepWithRetry(input: {
    runRoot: string;
    statusRoot: string;
    manifest: QwenPageDraftRunManifest;
    counters: InvocationCounters;
    stepId: string;
    kind: "analysis" | "reduce";
    contextText: string;
    sourceLabel?: string;
    prompt: DocumentationModelRequest;
    token: vscode.CancellationToken;
    onUsage?: (usage: DocumentationModelUsage) => void;
  }): Promise<StepResult<QwenPageFactLedger>> {
    return this.withTransientRetry(
      () => this.runJsonLedgerStep(input),
      input.token
    );
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

  private async runMarkdownStepWithRetry(input: {
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
    return this.withTransientRetry(
      () => this.runMarkdownStep(input),
      input.token
    );
  }

  private async withTransientRetry<T>(
    operation: () => Promise<T>,
    token: vscode.CancellationToken
  ): Promise<T> {
    let retry = 0;
    while (true) {
      ensureNotCancelled(token);
      try {
        return await operation();
      } catch (error) {
        if (!isTransientQwenFailure(error) || retry >= this.options.maxGatewayRetries) {
          throw error;
        }
        retry += 1;
        const delayMs = Math.min(30000, this.options.retryBaseDelayMs * (2 ** (retry - 1)));
        await this.options.delay(delayMs, token);
        ensureNotCancelled(token);
        // The failed attempt is already persisted by runModelStep; the next
        // invocation increments its attempt counter and preserves auditability.
      }
    }
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
    const stepInputHash = modelRequestHash(input.prompt);
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
    this.options.onModelCall?.(input.kind);
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
        warnings: uniqueStrings([...(loaded.warnings ?? []), ...input.warnings]),
        steps: loaded.steps ?? {},
        adaptiveSplits: loaded.adaptiveSplits ?? {},
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
      steps: {},
      adaptiveSplits: {}
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
  const minAdaptiveSplitCharacters = positiveInteger(
    options.minAdaptiveSplitCharacters ?? defaults.minAdaptiveSplitCharacters,
    "minAdaptiveSplitCharacters",
    100000
  );
  const adaptiveSplitOverlapCharacters = nonNegativeInteger(
    options.adaptiveSplitOverlapCharacters ?? defaults.adaptiveSplitOverlapCharacters,
    "adaptiveSplitOverlapCharacters",
    Math.max(0, minAdaptiveSplitCharacters - 1)
  );
  return {
    maxInputCharacters,
    maxChunkCharacters: Math.min(requestedChunk, maxInputCharacters - promptOverheadReserve),
    maxSourceFileCharacters: positiveInteger(options.maxSourceFileCharacters ?? defaults.maxSourceFileCharacters, "maxSourceFileCharacters", 1000000),
    maxTotalSourceCharacters: positiveInteger(options.maxTotalSourceCharacters ?? defaults.maxTotalSourceCharacters, "maxTotalSourceCharacters", 5000000),
    maxModelCalls: positiveInteger(options.maxModelCalls ?? defaults.maxModelCalls, "maxModelCalls", 200),
    maxReduceLevels: positiveInteger(options.maxReduceLevels ?? defaults.maxReduceLevels, "maxReduceLevels", 10),
    analysisMaxOutputTokens: positiveInteger(options.analysisMaxOutputTokens ?? defaults.analysisMaxOutputTokens, "analysisMaxOutputTokens", 65536),
    reduceMaxOutputTokens: positiveInteger(options.reduceMaxOutputTokens ?? defaults.reduceMaxOutputTokens, "reduceMaxOutputTokens", 65536),
    synthesisMaxOutputTokens: positiveInteger(options.synthesisMaxOutputTokens ?? defaults.synthesisMaxOutputTokens, "synthesisMaxOutputTokens", 65536),
    maxGatewayRetries: nonNegativeInteger(options.maxGatewayRetries ?? defaults.maxGatewayRetries, "maxGatewayRetries", 5),
    retryBaseDelayMs: positiveInteger(options.retryBaseDelayMs ?? defaults.retryBaseDelayMs, "retryBaseDelayMs", 30000),
    maxAdaptiveSplitDepth: nonNegativeInteger(options.maxAdaptiveSplitDepth ?? defaults.maxAdaptiveSplitDepth, "maxAdaptiveSplitDepth", 8),
    minAdaptiveSplitCharacters,
    adaptiveSplitOverlapCharacters,
    finalSectionGroupSize: positiveInteger(options.finalSectionGroupSize ?? defaults.finalSectionGroupSize, "finalSectionGroupSize", qwenPageDocumentSections.length),
    modelIdentity,
    expectedModelMarker,
    now: options.now ?? (() => new Date()),
    runIdFactory: options.runIdFactory ?? (() => `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`),
    delay: options.delay ?? waitForRetryDelay,
    onModelCall: options.onModelCall
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
  if (!Array.isArray(record.sections)) {
    throw responseContractError("Qwen3 ledger yaniti 'sections' dizisini icermiyor.");
  }
  const rawSections = record.sections;
  const byHeading = new Map<string, QwenPageFactSection>();
  for (const item of rawSections) {
    const section = asRecord(item);
    const heading = canonicalHeading(String(section.heading ?? ""));
    if (!heading) {
      throw responseContractError("Qwen3 ledger yaniti canonical olmayan veya bos bir section heading iceriyor.");
    }
    for (const field of ["findings", "sourceReferences", "uncertainties"] as const) {
      if (!Array.isArray(section[field]) || section[field].some((entry) => typeof entry !== "string")) {
        throw responseContractError(`Qwen3 ledger '${heading}' bolumunde '${field}' string dizisi degil.`);
      }
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
  const sharedReferences = sharedReferencesForBudget(section, maxCharacters);
  const empty = (): QwenPageFactSection => ({
    heading: section.heading,
    findings: [],
    sourceReferences: [...sharedReferences],
    uncertainties: []
  });
  const overhead = JSON.stringify({ sections: [empty()] }).length + 32;
  const maxItemCharacters = Math.max(64, maxCharacters - overhead);
  const items: Array<{ key: "findings" | "sourceReferences" | "uncertainties"; value: string }> = [
    ...section.findings.flatMap((value) => splitBoundedString(value, maxItemCharacters).map((part) => ({ key: "findings" as const, value: part }))),
    ...section.sourceReferences
      .filter((value) => !sharedReferences.includes(value))
      .flatMap((value) => splitBoundedString(value, maxItemCharacters).map((part) => ({ key: "sourceReferences" as const, value: part }))),
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

function sharedReferencesForBudget(section: QwenPageFactSection, maxCharacters: number): string[] {
  const references: string[] = [];
  const target = Math.max(256, Math.floor(maxCharacters * 0.3));
  for (const reference of uniqueStrings(section.sourceReferences)) {
    const candidate = {
      sections: [{
        heading: section.heading,
        findings: [],
        sourceReferences: [...references, reference],
        uncertainties: []
      }]
    };
    if (JSON.stringify(candidate).length > target) {
      break;
    }
    references.push(reference);
  }
  return references;
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

function serializeLedgerForSections(
  ledgers: QwenPageFactLedger[],
  requestedSections: readonly (typeof qwenPageDocumentSections)[number][]
): string {
  const crossLayerSpine = new Set<string>([
    "UI API Çağrıları",
    "BFF Endpoint Eşleşmesi",
    "Backend Endpoint Eşleşmesi",
    "Belirsizlikler"
  ]);
  const included = new Set<string>([...requestedSections, ...crossLayerSpine]);
  const aggregateHeadings = new Set<string>(["Kaynak Referansları", "Belirsizlikler"]);
  const filtered = ledgers
    .map((ledger) => ({
      sections: ledger.sections.filter((section) =>
        included.has(section.heading) &&
        !(requestedSections.includes(section.heading as (typeof qwenPageDocumentSections)[number]) && aggregateHeadings.has(section.heading))
      )
    }))
    .filter((ledger) => ledger.sections.length);
  const aggregateSections: QwenPageFactSection[] = [];
  if (requestedSections.includes("Kaynak Referansları")) {
    aggregateSections.push({
      heading: "Kaynak Referansları",
      findings: [],
      sourceReferences: uniqueStrings(ledgers.flatMap((ledger) =>
        ledger.sections.flatMap((section) => section.sourceReferences)
      )),
      uncertainties: []
    });
  }
  if (requestedSections.includes("Belirsizlikler")) {
    aggregateSections.push({
      heading: "Belirsizlikler",
      findings: [],
      sourceReferences: [],
      uncertainties: uniqueStrings(ledgers.flatMap((ledger) =>
        ledger.sections.flatMap((section) => section.uncertainties)
      ))
    });
  }
  const projected = aggregateSections.length ? [...filtered, { sections: aggregateSections }] : filtered;
  return serializeLedgerList(projected.length ? projected : [{ sections: [] }]);
}

function sectionGroups(size: number): Array<Array<(typeof qwenPageDocumentSections)[number]>> {
  const groups: Array<Array<(typeof qwenPageDocumentSections)[number]>> = [];
  for (let index = 0; index < qwenPageDocumentSections.length; index += size) {
    groups.push(qwenPageDocumentSections.slice(index, index + size) as Array<(typeof qwenPageDocumentSections)[number]>);
  }
  return groups;
}

function ledgersFitFinalSectionGroups(
  ledgers: QwenPageFactLedger[],
  payloadBudget: number,
  groupSize: number
): boolean {
  return sectionGroups(groupSize).every((sections) =>
    serializeLedgerForSections(ledgers, sections).length <= payloadBudget
  );
}

function sectionGroupOutputTokens(sectionCount: number, maximum: number): number {
  return Math.min(maximum, 512 + (Math.max(1, sectionCount) * 900));
}

function selectCanonicalSections(
  markdown: string,
  requestedSections: readonly (typeof qwenPageDocumentSections)[number][]
): { markdown: string; missingSections: Array<(typeof qwenPageDocumentSections)[number]> } {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  if (!matches.length) {
    return { markdown: "", missingSections: [...requestedSections] };
  }
  const bodies = new Map<string, string[]>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = canonicalHeading(match[1]);
    if (!heading || !requestedSections.includes(heading as (typeof qwenPageDocumentSections)[number])) {
      continue;
    }
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(bodyStart, bodyEnd).trim();
    bodies.set(heading, [...(bodies.get(heading) ?? []), body].filter(Boolean));
  }
  const missingSections = requestedSections.filter((heading) => !(bodies.get(heading) ?? []).length);
  const rendered = requestedSections
    .filter((heading) => !missingSections.includes(heading))
    .map((heading) => [
      `## ${heading}`,
      (bodies.get(heading) ?? []).join("\n\n")
    ].join("\n\n"))
    .join("\n\n");
  return { markdown: rendered, missingSections };
}

function groundLedgerToSuppliedSource(
  ledger: QwenPageFactLedger,
  sourceLabel: string,
  suppliedContent: string
): QwenPageFactLedger {
  return {
    sections: ledger.sections.map((section) => {
      const sourceReferences = uniqueStrings(section.sourceReferences)
        .filter((reference) => isSuppliedSourceReference(reference, sourceLabel, suppliedContent));
      if (!section.findings.length || sourceReferences.length) {
        return { ...section, sourceReferences };
      }
      return {
        ...section,
        findings: [],
        sourceReferences,
        uncertainties: uniqueStrings([
          ...section.uncertainties,
          ...section.findings.map((finding) =>
            `Model bulgusu gecerli bir supplied source reference ile eslesmedigi icin belirsizlige tasindi: ${finding}`
          )
        ])
      };
    })
  };
}

function isSuppliedSourceReference(reference: string, sourceLabel: string, suppliedContent: string): boolean {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.length > 800) {
    return false;
  }
  if (trimmed === sourceLabel) {
    return true;
  }
  const withoutLineRange = trimmed.replace(/:\d+(?:-\d+)?$/, "");
  if (
    withoutLineRange.length < 5 ||
    !/(?:^|[\\/])[\w.@() -]+(?:[\\/][\w.@() -]+)*\.(?:java|kt|kts|groovy|xml|ya?ml|properties|jsonl?|md|tsx?|jsx?|vue|html|css|scss)$/i.test(withoutLineRange)
  ) {
    return false;
  }
  const normalizedReference = withoutLineRange.replace(/\\/g, "/");
  const normalizedContent = suppliedContent.replace(/\\/g, "/");
  return normalizedContent.includes(normalizedReference);
}

function responseContractError(message: string): Error {
  const error = new Error(message);
  error.name = "QwenResponseContractError";
  return error;
}

function demoteUnreferencedFindings(ledger: QwenPageFactLedger): QwenPageFactLedger {
  return {
    sections: ledger.sections.map((section) => section.findings.length && !section.sourceReferences.length
      ? {
        ...section,
        findings: [],
        uncertainties: uniqueStrings([
          ...section.uncertainties,
          ...section.findings.map((finding) => `Kaynak referansi reduce sirasinda korunamadi: ${finding}`)
        ])
      }
      : section)
  };
}

function splitAdaptiveChunk(value: string, minCharacters: number, overlapCharacters: number): string[] | undefined {
  if (value.length < minCharacters * 2) {
    return undefined;
  }
  const midpoint = Math.floor(value.length / 2);
  const previousBreak = value.lastIndexOf("\n", midpoint);
  const nextBreak = value.indexOf("\n", midpoint);
  const candidates = [previousBreak, nextBreak]
    .filter((index) => index >= minCharacters && value.length - index >= minCharacters)
    .sort((left, right) => Math.abs(left - midpoint) - Math.abs(right - midpoint));
  const splitAt = candidates[0] ?? midpoint;
  if (splitAt < minCharacters || value.length - splitAt < minCharacters) {
    return undefined;
  }
  const overlap = Math.min(overlapCharacters, Math.floor(minCharacters / 2));
  const left = value.slice(0, Math.min(value.length, splitAt + overlap));
  const right = value.slice(Math.max(0, splitAt - overlap));
  if (!left.trim() || !right.trim() || left.length >= value.length || right.length >= value.length) {
    return undefined;
  }
  return [left, right];
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function modelRequestHash(prompt: DocumentationModelRequest): string {
  const combinedText = prompt.combinedText ?? `${prompt.instructions ?? ""}\n${prompt.userPrompt}`;
  return sha256(JSON.stringify({ combinedText, maxOutputTokens: prompt.maxOutputTokens ?? null }));
}

function isTransientQwenFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "QwenRequestTimeoutError" ||
    /Qwen HTTP hatası:\s*(?:429|502|503|504)\b/i.test(message) ||
    /(?:ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|fetch failed|network error|gateway time-?out|Qwen bağlantısı kurulamadı)/i.test(message);
}

function isAdaptiveSplitQwenFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const folded = foldToAscii(message);
  return name === "QwenRequestTimeoutError" ||
    /qwen http hatasi:\s*(?:413|504)\b/i.test(folded) ||
    /(?:etimedout|gateway time-?out)/i.test(folded) ||
    /(?:qwen baglam butcesi asildi|context(?: length| window| budget)?.*(?:exceed|overflow|too large)|payload too large)/i.test(folded) ||
    /(?:maksimum token sinirinda kesildi|token cikti sinirinda kesildi|finish.reason.?length|output limit)/i.test(folded);
}

function boundedError(error: unknown): string {
  return safeError(error).slice(0, 800);
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

function waitForRetryDelay(milliseconds: number, token: vscode.CancellationToken): Promise<void> {
  ensureNotCancelled(token);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cancellation?.dispose();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    timeout = setTimeout(() => finish(), milliseconds);
    cancellation = token.onCancellationRequested(() =>
      finish(new Error("Qwen3 sayfa pipeline'i kullanici tarafindan iptal edildi."))
    );
  });
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

function nonNegativeInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a non-negative integer no greater than ${maximum}.`);
  }
  return value;
}
