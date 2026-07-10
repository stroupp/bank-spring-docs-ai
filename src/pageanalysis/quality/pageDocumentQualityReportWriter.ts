import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl } from "../../storage/jsonlWriter";
import { PageDocumentQualityScore } from "./pageDocumentQualityScorer";

export class PageDocumentQualityReportWriter {
  async write(pageRoot: string, score: PageDocumentQualityScore): Promise<string> {
    const target = path.join(pageRoot, "quality-report.md");
    await fs.writeFile(target, [
      "# Sayfa Dokuman Kalite Raporu",
      "",
      `Sayfa: ${score.page}`,
      `Route: ${score.route ?? "Not visible from provided context."}`,
      `Skor: ${score.score}`,
      `Grade: ${score.grade}`,
      "",
      "## Kapsam",
      `- Zorunlu bolumler: ${score.requiredSectionsPresent}/${score.requiredSectionsTotal}`,
      `- Kaynak referansi: ${score.sourceReferenceCount}`,
      `- Final dokuman uzunlugu: ${score.finalDocumentLength}`,
      `- Acik gap: ${score.unresolvedGapCount}`,
      `- High severity gap: ${score.highSeverityGapCount}`,
      "",
      "## Coverage",
      `- UI API call coverage: ${score.uiApiCallCoverage}`,
      `- BFF match coverage: ${score.bffMatchCoverage}`,
      `- BE match coverage: ${score.beMatchCoverage}`,
      `- Parameter coverage: ${score.parameterCoverage}`,
      `- Validation coverage: ${score.validationCoverage}`,
      `- Service flow coverage: ${score.serviceFlowCoverage}`,
      `- Repository/entity coverage: ${score.repositoryEntityCoverage}`,
      `- Qwen semantic coverage: ${score.qwenSemanticCoverage}`,
      `- Context pack available: ${score.contextPackAvailable ? "evet" : "hayir"}`,
      `- Evidence pack available: ${score.evidencePackAvailable ? "evet" : "hayir"}`,
      `- Output freshness issue: ${score.outputFreshnessIssues}`,
      `- Unknown metric data: ${score.metricsWithUnknownData.length ? score.metricsWithUnknownData.join(", ") : "yok"}`,
      ""
    ].join("\n"), "utf8");
    return target;
  }

  async writeAggregate(multiRepoRoot: string): Promise<string> {
    const scores = await readJsonl<PageDocumentQualityScore>(path.join(multiRepoRoot, "quality", "page-document-quality.jsonl"));
    const target = path.join(multiRepoRoot, "quality", "page-document-quality-report.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, [
      "# Sayfa Dokuman Kalite Raporu",
      "",
      `Olusturulma zamani: ${new Date().toISOString()}`,
      `Sayfa sayisi: ${scores.length}`,
      "",
      "## Sayfa Skorlari",
      scores.length
        ? "| Page | Route | Score | Grade | Gaps | High | Source Refs | Length | Freshness Issues | Unknown |\n|---|---|---:|---|---:|---:|---:|---:|---:|---|\n" +
          scores
            .sort((a, b) => a.page.localeCompare(b.page))
            .map((score) => `| ${score.page} | ${score.route ?? ""} | ${score.score} | ${score.grade} | ${score.unresolvedGapCount} | ${score.highSeverityGapCount} | ${score.sourceReferenceCount} | ${score.finalDocumentLength} | ${score.outputFreshnessIssues} | ${score.metricsWithUnknownData.join(", ")} |`)
            .join("\n")
        : "Henuz sayfa kalite skoru bulunamadi.",
      "",
      "## Ozet",
      `- Ortalama skor: ${scores.length ? Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length) : 0}`,
      `- A/B grade sayisi: ${scores.filter((item) => item.grade === "A" || item.grade === "B").length}`,
      `- High severity gap toplami: ${scores.reduce((sum, item) => sum + item.highSeverityGapCount, 0)}`,
      `- Unknown metric data olan sayfa: ${scores.filter((item) => item.metricsWithUnknownData.length > 0).length}`,
      `- Output freshness issue toplami: ${scores.reduce((sum, item) => sum + item.outputFreshnessIssues, 0)}`,
      ""
    ].join("\n"), "utf8");
    return target;
  }
}
