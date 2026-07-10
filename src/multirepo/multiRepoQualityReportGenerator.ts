import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl } from "../storage/jsonlWriter";
import { MultiRepoManifest } from "./multiRepoManifestService";

type Severity = "critical" | "warning" | "info";

interface ArtifactSpec {
  key: string;
  relativePath: string;
  label: string;
  critical: boolean;
}

interface ArtifactRating {
  key: string;
  label: string;
  relativePath: string;
  records: number;
  rating: "good" | "weak" | "empty" | "missing";
  notes: string[];
}

interface Finding {
  severity: Severity;
  message: string;
  recommendation: string;
}

export interface MultiRepoQualityReportResult {
  markdownPath: string;
  jsonPath: string;
  score: number;
  rating: "good" | "needs-attention" | "poor";
  findings: number;
  criticalFindings: number;
}

const artifacts: ArtifactSpec[] = [
  { key: "uiFiles", relativePath: "ui/file-index.jsonl", label: "UI file index", critical: true },
  { key: "uiPages", relativePath: "ui/page-index.jsonl", label: "UI page index", critical: true },
  { key: "uiRoutes", relativePath: "ui/route-index.jsonl", label: "UI route index", critical: false },
  { key: "uiInteractions", relativePath: "ui/interaction-index.jsonl", label: "UI interaction index", critical: true },
  { key: "uiApiCalls", relativePath: "ui/api-call-index.jsonl", label: "UI API call index", critical: true },
  { key: "uiForms", relativePath: "ui/form-field-index.jsonl", label: "UI form field index", critical: false },
  { key: "bffFiles", relativePath: "bff/file-index.jsonl", label: "BFF file index", critical: true },
  { key: "bffEndpoints", relativePath: "bff/api-endpoints.jsonl", label: "BFF endpoint index", critical: true },
  { key: "bffOutbound", relativePath: "bff/outbound-calls.jsonl", label: "BFF outbound call index", critical: true },
  { key: "bffDtos", relativePath: "bff/dto-index.jsonl", label: "BFF DTO index", critical: false },
  { key: "bffFlows", relativePath: "bff/bff-flow-index.jsonl", label: "BFF flow index", critical: false },
  { key: "beFiles", relativePath: "be/file-index.jsonl", label: "BE file index", critical: true },
  { key: "beEndpoints", relativePath: "be/api-endpoints.jsonl", label: "BE endpoint index", critical: true },
  { key: "beMethodCalls", relativePath: "be/java-method-call-index.jsonl", label: "BE Java method call index", critical: false },
  { key: "beDtos", relativePath: "be/dto-index.jsonl", label: "BE DTO index", critical: false },
  { key: "beRepository", relativePath: "be/repository-method-index.jsonl", label: "BE repository method index", critical: false },
  { key: "beValidation", relativePath: "be/validation-index.jsonl", label: "BE validation index", critical: false },
  { key: "beExceptions", relativePath: "be/exception-flow-index.jsonl", label: "BE exception flow index", critical: false },
  { key: "beServiceFlows", relativePath: "be/service-flow-index.jsonl", label: "BE service flow index", critical: false },
  { key: "uiToBff", relativePath: "traceability/ui-to-bff.jsonl", label: "UI to BFF traceability", critical: true },
  { key: "bffToBe", relativePath: "traceability/bff-to-be.jsonl", label: "BFF to BE traceability", critical: true },
  { key: "pageFlows", relativePath: "traceability/page-flows.jsonl", label: "Page flow traceability", critical: true },
  { key: "unresolved", relativePath: "traceability/unresolved-matches.jsonl", label: "Unresolved matches", critical: false },
  { key: "graphNodes", relativePath: "graph/nodes.jsonl", label: "Knowledge graph nodes", critical: false },
  { key: "graphEdges", relativePath: "graph/edges.jsonl", label: "Knowledge graph edges", critical: false },
  { key: "interactionSemantics", relativePath: "ui/semantic/interaction-semantics.jsonl", label: "Qwen interaction semantics", critical: false },
  { key: "pageFlowSemantics", relativePath: "traceability/semantic/page-flow-semantics.jsonl", label: "Qwen page-flow semantics", critical: false }
];

export class MultiRepoQualityReportGenerator {
  async generate(multiRepoRoot: string, manifest: MultiRepoManifest): Promise<MultiRepoQualityReportResult> {
    const recordsByKey = new Map<string, Record<string, unknown>[]>();
    const ratings: ArtifactRating[] = [];
    const findings: Finding[] = [];

    for (const artifact of artifacts) {
      const fullPath = path.join(multiRepoRoot, artifact.relativePath);
      const exists = await fileExists(fullPath);
      const records = exists ? await readJsonl<Record<string, unknown>>(fullPath) : [];
      recordsByKey.set(artifact.key, records);
      const rating = this.rateArtifact(artifact, exists, records);
      ratings.push(rating);
      if (artifact.critical && rating.rating !== "good") {
        findings.push({
          severity: "critical",
          message: `${artifact.label} is ${rating.rating}.`,
          recommendation: this.recommendationFor(artifact.key)
        });
      }
    }

    this.addCrossArtifactFindings(recordsByKey, findings);
    const score = this.calculateScore(ratings, findings);
    const rating = score >= 85 ? "good" : score >= 65 ? "needs-attention" : "poor";
    const report = {
      projectName: manifest.projectName,
      branch: manifest.branch,
      generatedAt: new Date().toISOString(),
      score,
      rating,
      artifactRatings: ratings,
      findings
    };

    const reportRoot = path.join(multiRepoRoot, "quality");
    await fs.mkdir(reportRoot, { recursive: true });
    const jsonPath = path.join(reportRoot, "multi-repo-quality-report.json");
    const markdownPath = path.join(reportRoot, "multi-repo-quality-report.md");
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(markdownPath, this.toMarkdown(report), "utf8");

    return {
      markdownPath,
      jsonPath,
      score,
      rating,
      findings: findings.length,
      criticalFindings: findings.filter((finding) => finding.severity === "critical").length
    };
  }

  private rateArtifact(artifact: ArtifactSpec, exists: boolean, records: Record<string, unknown>[]): ArtifactRating {
    const notes: string[] = [];
    if (!exists) {
      notes.push("File has not been generated yet.");
      return { ...artifact, records: 0, rating: "missing", notes };
    }
    if (records.length === 0) {
      notes.push("File exists but contains no records.");
      return { ...artifact, records: 0, rating: "empty", notes };
    }
    if (artifact.key === "uiForms" && records.length < 2) {
      notes.push("Few form fields were detected; confirm UI form extraction for login/search screens.");
      return { ...artifact, records: records.length, rating: "weak", notes };
    }
    if ((artifact.key === "bffDtos" || artifact.key === "beDtos") && records.length === 0) {
      notes.push("No DTO classes were detected; this may be valid for thin APIs, but request/response analysis will be weaker.");
      return { ...artifact, records: records.length, rating: "weak", notes };
    }
    if (artifact.key === "graphEdges" && records.length < 50) {
      notes.push("Graph has low edge density for a multi-repo flow.");
      return { ...artifact, records: records.length, rating: "weak", notes };
    }
    return { ...artifact, records: records.length, rating: "good", notes };
  }

  private addCrossArtifactFindings(recordsByKey: Map<string, Record<string, unknown>[]>, findings: Finding[]): void {
    const uiApiCalls = recordsByKey.get("uiApiCalls") ?? [];
    const bffOutbound = recordsByKey.get("bffOutbound") ?? [];
    const uiToBff = recordsByKey.get("uiToBff") ?? [];
    const bffToBe = recordsByKey.get("bffToBe") ?? [];
    const pageFlows = recordsByKey.get("pageFlows") ?? [];
    const unresolved = recordsByKey.get("unresolved") ?? [];
    const graphNodes = recordsByKey.get("graphNodes") ?? [];
    const graphEdges = recordsByKey.get("graphEdges") ?? [];
    const interactionSemantics = recordsByKey.get("interactionSemantics") ?? [];
    const pageFlowSemantics = recordsByKey.get("pageFlowSemantics") ?? [];

    if (uiApiCalls.length > 0 && uiToBff.length === 0) {
      findings.push({
        severity: "critical",
        message: "UI API calls exist but no UI to BFF matches were produced.",
        recommendation: "Re-run the end-to-end flow map after UI and BFF analysis, then inspect path normalization."
      });
    }

    if (bffOutbound.length > 0 && bffToBe.length === 0) {
      findings.push({
        severity: "critical",
        message: "BFF outbound calls exist but no BFF to BE matches were produced.",
        recommendation: "Check BFF outbound extraction, query-string normalization, and BE endpoint paths."
      });
    }

    if (unresolved.length > 0) {
      findings.push({
        severity: "warning",
        message: `${unresolved.length} unresolved flow match records remain.`,
        recommendation: "Open unresolved matches and decide whether they are real gaps, background calls, or false positives."
      });
    }

    const unknownPages = pageFlows.filter((flow) => String(flow.page ?? "").toLowerCase().includes("unknownpage"));
    if (unknownPages.length > 0) {
      findings.push({
        severity: "warning",
        message: `${unknownPages.length} page flow records use UnknownPage.`,
        recommendation: "Classify background/session flows separately, or improve React ownership detection for the caller."
      });
    }

    const partialFlows = pageFlows.filter((flow) => String(flow.confidence ?? "") === "partial" || !flow.beEndpoint);
    if (partialFlows.length > 0) {
      findings.push({
        severity: "warning",
        message: `${partialFlows.length} page flows are partial.`,
        recommendation: "Run BFF outbound extraction and BE endpoint analysis before Qwen page semantics."
      });
    }

    if (graphNodes.length > 0 && graphEdges.length > 0 && graphEdges.length / graphNodes.length < 0.5) {
      findings.push({
        severity: "warning",
        message: "Knowledge graph edge density is low.",
        recommendation: "Add more relationship builders for component ownership, service calls, repository usage, DTO usage, and validation paths."
      });
    }

    if (interactionSemantics.length === 0 || pageFlowSemantics.length === 0) {
      findings.push({
        severity: "info",
        message: "Qwen semantic artifacts are not present.",
        recommendation: "Enable Qwen and run Qwen ile Sayfa Semantigi Olustur, or keep the agentic Qwen flag off for a local/Copilot-only pipeline."
      });
    }
  }

  private calculateScore(ratings: ArtifactRating[], findings: Finding[]): number {
    let score = 100;
    for (const rating of ratings) {
      if (rating.rating === "missing" && artifacts.find((artifact) => artifact.key === rating.key)?.critical) {
        score -= 12;
      } else if (rating.rating === "empty" && artifacts.find((artifact) => artifact.key === rating.key)?.critical) {
        score -= 15;
      } else if (rating.rating === "weak") {
        score -= 4;
      }
    }
    for (const finding of findings) {
      score -= finding.severity === "critical" ? 10 : finding.severity === "warning" ? 4 : 1;
    }
    return Math.max(0, Math.min(100, score));
  }

  private recommendationFor(key: string): string {
    if (key.startsWith("ui")) {
      return "Run React UI analysis and verify API client path extraction.";
    }
    if (key.startsWith("bff")) {
      return "Run BFF local analysis and verify outbound RestTemplate/WebClient calls.";
    }
    if (key.startsWith("be")) {
      return "Run BE local analysis and verify Spring controller scanning.";
    }
    if (key === "pageFlows" || key === "uiToBff" || key === "bffToBe") {
      return "Run end-to-end flow map after UI, BFF, and BE indexes are complete.";
    }
    return "Regenerate this artifact from the side panel.";
  }

  private toMarkdown(report: {
    projectName: string;
    branch: string;
    generatedAt: string;
    score: number;
    rating: string;
    artifactRatings: ArtifactRating[];
    findings: Finding[];
  }): string {
    const lines = [
      "# Coklu Repo Kalite Raporu",
      "",
      `Proje: ${report.projectName}`,
      `Branch: ${report.branch}`,
      `Olusturulma zamani: ${report.generatedAt}`,
      "",
      "## Ozet",
      `- Genel puan: ${report.score}/100`,
      `- Durum: ${report.rating}`,
      `- Bulgu sayisi: ${report.findings.length}`,
      `- Kritik bulgu: ${report.findings.filter((finding) => finding.severity === "critical").length}`,
      "",
      "## Artifact Puanlari",
      "| Artifact | Kayit | Durum | Not |",
      "| --- | ---: | --- | --- |"
    ];

    for (const rating of report.artifactRatings) {
      lines.push(`| ${rating.label} | ${rating.records} | ${rating.rating} | ${rating.notes.join(" ") || "-"} |`);
    }

    lines.push("", "## Bulgular");
    if (report.findings.length === 0) {
      lines.push("- Kritik veya uyarilacak bulgu yok.");
    } else {
      for (const finding of report.findings) {
        lines.push(`- ${finding.severity.toUpperCase()}: ${finding.message} Oneri: ${finding.recommendation}`);
      }
    }

    lines.push(
      "",
      "## Sonraki Iyilestirme Plani",
      "- UnknownPage kayitlarini background/session flow olarak ayri siniflandir.",
      "- Knowledge graph icin component ownership, DTO usage ve service-call edge tiplerini genislet.",
      "- Qwen semantik uretimini sadece tam veya kasitli partial flow kayitlarindan calistir.",
      "- Copilot context seciminde bu kalite raporundaki good artifact dosyalarini oncele.",
      ""
    );

    return lines.join("\n");
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
