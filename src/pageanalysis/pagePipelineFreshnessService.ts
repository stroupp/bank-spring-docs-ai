import * as fs from "fs/promises";
import * as path from "path";
import { LocalKnowledgeGraphBuilder } from "../graph/localKnowledgeGraphBuilder";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { MultiRepoQualityReportGenerator } from "../multirepo/multiRepoQualityReportGenerator";
import { MultiRepoTraceabilityService } from "../multirepo/multiRepoTraceabilityService";
import { MultiRepoArtifactIdentityService } from "../multirepo/multiRepoArtifactIdentityService";
import { atomicWriteJson } from "../storage/atomicFile";
import { PipelineArtifactReceiptService } from "../multirepo/pipelineArtifactReceiptService";

export interface PagePipelineFreshnessIssue {
  artifact: string;
  severity: "high" | "medium" | "low";
  problem: "missing" | "stale";
  message: string;
}

export interface PagePipelineFreshnessResult {
  checkedAt: string;
  regeneratedDerivedArtifacts: boolean;
  issues: PagePipelineFreshnessIssue[];
  artifactTimestamps: Record<string, string>;
  reportPath: string;
}

const baseArtifacts = [
  "ui/page-index.jsonl",
  "ui/route-index.jsonl",
  "ui/component-index.jsonl",
  "ui/interaction-index.jsonl",
  "ui/api-call-index.jsonl",
  "bff/api-endpoints.jsonl",
  "bff/outbound-calls.jsonl",
  "bff/bff-flow-index.jsonl",
  "be/api-endpoints.jsonl",
  "be/java-method-call-index.jsonl",
  "be/service-flow-index.jsonl",
  "be/repository-method-index.jsonl",
  "be/entity-index.jsonl",
  "be/validation-index.jsonl"
];

const optionalBaseArtifacts = [
  "bff/dto-index.jsonl",
  "be/dto-index.jsonl"
];

const derivedArtifacts = [
  "traceability/ui-to-bff.jsonl",
  "traceability/bff-to-be.jsonl",
  "traceability/page-flows.jsonl",
  "traceability/pipeline-manifest.json",
  "graph/nodes.jsonl",
  "graph/edges.jsonl",
  "quality/multi-repo-quality-report.json"
];

export class PagePipelineFreshnessService {
  async ensure(multiRepoRoot: string, manifest: MultiRepoManifest): Promise<PagePipelineFreshnessResult> {
    const identityIssues = await new MultiRepoArtifactIdentityService().inspect(multiRepoRoot, manifest);
    const firstCheck = await this.inspect(multiRepoRoot);
    firstCheck.issues.unshift(...identityIssues.map((issue) => ({
      artifact: `${issue.role}/manifest.json`,
      severity: "high" as const,
      problem: "stale" as const,
      message: issue.message
    })));
    try {
      await new PipelineArtifactReceiptService()
        .assertTraceabilityCompatible(multiRepoRoot, manifest, { allowMissing: true });
    } catch (error) {
      firstCheck.issues.push({
        artifact: "traceability/pipeline-manifest.json",
        severity: "medium",
        problem: "stale",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    const missingBase = firstCheck.issues.filter((issue) => issue.severity === "high");
    const derivedNeedsRefresh = firstCheck.issues.some((issue) => derivedArtifacts.includes(issue.artifact));
    let regeneratedDerivedArtifacts = false;

    if (missingBase.length === 0 && derivedNeedsRefresh) {
      await new MultiRepoTraceabilityService().build(multiRepoRoot, manifest);
      await new LocalKnowledgeGraphBuilder().build(multiRepoRoot, manifest);
      await new MultiRepoQualityReportGenerator().generate(multiRepoRoot, manifest);
      regeneratedDerivedArtifacts = true;
    }

    const finalCheck = regeneratedDerivedArtifacts ? await this.inspect(multiRepoRoot) : firstCheck;
    const result: PagePipelineFreshnessResult = {
      checkedAt: new Date().toISOString(),
      regeneratedDerivedArtifacts,
      issues: finalCheck.issues,
      artifactTimestamps: finalCheck.artifactTimestamps,
      reportPath: path.join(multiRepoRoot, "audit", "page-pipeline-freshness.json")
    };
    await fs.mkdir(path.dirname(result.reportPath), { recursive: true });
    await atomicWriteJson(result.reportPath, result);
    return result;
  }

  private async inspect(multiRepoRoot: string): Promise<{ issues: PagePipelineFreshnessIssue[]; artifactTimestamps: Record<string, string> }> {
    const artifactTimestamps: Record<string, string> = {};
    const issues: PagePipelineFreshnessIssue[] = [];
    const baseStats = await Promise.all(baseArtifacts.map((artifact) => statArtifact(multiRepoRoot, artifact)));
    const optionalBaseStats = await Promise.all(optionalBaseArtifacts.map((artifact) => statArtifact(multiRepoRoot, artifact)));
    const derivedStats = await Promise.all(derivedArtifacts.map((artifact) => statArtifact(multiRepoRoot, artifact)));

    for (const stat of [...baseStats, ...optionalBaseStats, ...derivedStats]) {
      artifactTimestamps[stat.artifact] = stat.mtimeIso ?? "missing";
    }

    for (const stat of baseStats) {
      if (!stat.mtimeMs) {
        issues.push({
          artifact: stat.artifact,
          severity: "high",
          problem: "missing",
          message: `Base artifact is missing: ${stat.artifact}. Run UI/BFF/BE analysis before page analysis.`
        });
      }
    }

    for (const stat of optionalBaseStats) {
      if (!stat.mtimeMs) {
        issues.push({
          artifact: stat.artifact,
          severity: "medium",
          problem: "missing",
          message: `Optional DTO artifact is missing: ${stat.artifact}. Rerun BFF/BE local analysis for richer request-response documentation.`
        });
      }
    }

    const newestBase = Math.max(...[...baseStats, ...optionalBaseStats].map((stat) => stat.mtimeMs ?? 0));
    for (const stat of derivedStats) {
      if (!stat.mtimeMs) {
        issues.push({
          artifact: stat.artifact,
          severity: "medium",
          problem: "missing",
          message: `Derived artifact is missing and can be regenerated: ${stat.artifact}.`
        });
      } else if (newestBase > 0 && stat.mtimeMs < newestBase) {
        issues.push({
          artifact: stat.artifact,
          severity: "low",
          problem: "stale",
          message: `Derived artifact is older than one or more base indexes: ${stat.artifact}.`
        });
      }
    }

    return { issues, artifactTimestamps };
  }
}

async function statArtifact(root: string, artifact: string): Promise<{ artifact: string; mtimeMs?: number; mtimeIso?: string }> {
  try {
    const stat = await fs.stat(path.join(root, artifact));
    return { artifact, mtimeMs: stat.mtimeMs, mtimeIso: stat.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { artifact };
    }
    throw error;
  }
}
