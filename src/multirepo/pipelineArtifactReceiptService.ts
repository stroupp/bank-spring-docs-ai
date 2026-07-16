import * as fs from "fs/promises";
import * as path from "path";
import { atomicWriteJson } from "../storage/atomicFile";
import { sha256 } from "../utils/hash";
import { ensureWithin } from "../utils/pathUtils";
import { MultiRepoManifest } from "./multiRepoManifestService";
import { assertPathContainedForWrite } from "../storage/localStorageService";

export interface PipelineArtifactFingerprint {
  path: string;
  sha256: string;
  bytes: number;
}

interface PipelineArtifactReceipt {
  schemaVersion: 1;
  stage: "traceability";
  pipelineIdentity: string;
  generatedAt: string;
  inputs: PipelineArtifactFingerprint[];
  outputs: PipelineArtifactFingerprint[];
}

export const traceabilityInputPaths = [
  "ui/api-call-index.jsonl",
  "ui/interaction-index.jsonl",
  "ui/route-index.jsonl",
  "bff/api-endpoints.jsonl",
  "bff/outbound-calls.jsonl",
  "be/api-endpoints.jsonl",
  "be/service-flow-index.jsonl",
  "be/entity-index.jsonl"
] as const;

export const traceabilityOutputPaths = [
  "traceability/ui-to-bff.jsonl",
  "traceability/bff-to-be.jsonl",
  "traceability/page-flows.jsonl",
  "traceability/unresolved-matches.jsonl",
  "traceability/traceability-report.md",
  "traceability/traceability-report.json"
] as const;

export class PipelineArtifactReceiptService {
  async captureInputs(multiRepoRoot: string): Promise<PipelineArtifactFingerprint[]> {
    return this.capture(multiRepoRoot, traceabilityInputPaths);
  }

  async invalidateTraceability(multiRepoRoot: string): Promise<void> {
    const receiptPath = this.traceabilityReceiptPath(multiRepoRoot);
    await assertPathContainedForWrite(multiRepoRoot, receiptPath);
    await fs.rm(receiptPath, { force: true });
  }

  async commitTraceability(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    capturedInputs: PipelineArtifactFingerprint[]
  ): Promise<void> {
    const pipelineIdentity = manifest.pipelineIdentity;
    if (!pipelineIdentity) {
      throw new Error("Traceability cannot be committed without a pipeline identity.");
    }
    const currentInputs = await this.captureInputs(multiRepoRoot);
    if (!sameFingerprints(capturedInputs, currentInputs)) {
      throw new Error("Traceability inputs changed while the stage was running; outputs were not committed.");
    }
    const outputs = await this.capture(multiRepoRoot, traceabilityOutputPaths);
    const receipt: PipelineArtifactReceipt = {
      schemaVersion: 1,
      stage: "traceability",
      pipelineIdentity,
      generatedAt: new Date().toISOString(),
      inputs: currentInputs,
      outputs
    };
    const receiptPath = this.traceabilityReceiptPath(multiRepoRoot);
    await assertPathContainedForWrite(multiRepoRoot, receiptPath);
    await atomicWriteJson(receiptPath, receipt);
  }

  async assertTraceabilityCompatible(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    options: { allowMissing?: boolean } = {}
  ): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.traceabilityReceiptPath(multiRepoRoot), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) {
        return false;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Traceability commit receipt is missing. Regenerate traceability first.");
      }
      throw new Error("Traceability commit receipt is unreadable or malformed.");
    }
    if (!isReceipt(parsed) || !manifest.pipelineIdentity || parsed.pipelineIdentity !== manifest.pipelineIdentity) {
      throw new Error("Traceability artifacts do not belong to the active pipeline selection.");
    }
    const currentInputs = await this.captureInputs(multiRepoRoot);
    const currentOutputs = await this.capture(multiRepoRoot, traceabilityOutputPaths);
    if (!sameFingerprints(parsed.inputs, currentInputs) || !sameFingerprints(parsed.outputs, currentOutputs)) {
      throw new Error("Traceability artifacts are stale, incomplete, or corrupt. Regenerate traceability first.");
    }
    return true;
  }

  private traceabilityReceiptPath(multiRepoRoot: string): string {
    return path.join(multiRepoRoot, "traceability", "pipeline-manifest.json");
  }

  private async capture(
    multiRepoRoot: string,
    relativePaths: readonly string[]
  ): Promise<PipelineArtifactFingerprint[]> {
    return Promise.all(relativePaths.map(async (relativePath) => {
      const absolutePath = path.resolve(multiRepoRoot, relativePath);
      if (!ensureWithin(multiRepoRoot, absolutePath)) {
        throw new Error("Pipeline artifact path escaped the active workspace.");
      }
      await assertPathContainedForWrite(multiRepoRoot, absolutePath);
      const content = await fs.readFile(absolutePath);
      return {
        path: relativePath,
        sha256: sha256(content),
        bytes: content.length
      };
    }));
  }
}

function isReceipt(value: unknown): value is PipelineArtifactReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Partial<PipelineArtifactReceipt>;
  return receipt.schemaVersion === 1 &&
    receipt.stage === "traceability" &&
    typeof receipt.pipelineIdentity === "string" &&
    Array.isArray(receipt.inputs) &&
    Array.isArray(receipt.outputs) &&
    receipt.inputs.every(isFingerprint) &&
    receipt.outputs.every(isFingerprint);
}

function isFingerprint(value: unknown): value is PipelineArtifactFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const fingerprint = value as Partial<PipelineArtifactFingerprint>;
  return typeof fingerprint.path === "string" &&
    typeof fingerprint.sha256 === "string" && /^[a-f0-9]{64}$/.test(fingerprint.sha256) &&
    typeof fingerprint.bytes === "number" && Number.isSafeInteger(fingerprint.bytes) && fingerprint.bytes >= 0;
}

function sameFingerprints(
  left: readonly PipelineArtifactFingerprint[],
  right: readonly PipelineArtifactFingerprint[]
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.path === other.path && item.sha256 === other.sha256 && item.bytes === other.bytes;
  });
}
