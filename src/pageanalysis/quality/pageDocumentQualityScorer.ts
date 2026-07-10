import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl, writeJsonl } from "../../storage/jsonlWriter";
import { PageOutputFreshnessService } from "../pageOutputFreshnessService";

export interface PageDocumentQualityScore {
  page: string;
  route?: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  requiredSectionsPresent: number;
  requiredSectionsTotal: number;
  sourceReferenceCount: number;
  unresolvedGapCount: number;
  highSeverityGapCount: number;
  uiApiCallCoverage: number;
  bffMatchCoverage: number;
  beMatchCoverage: number;
  parameterCoverage: number;
  validationCoverage: number;
  serviceFlowCoverage: number;
  repositoryEntityCoverage: number;
  qwenSemanticCoverage: number;
  evidencePackAvailable: boolean;
  contextPackAvailable: boolean;
  finalDocumentLength: number;
  metricsWithUnknownData: string[];
  outputFreshnessIssues: number;
}

const requiredSections = [
  "Sayfa Amaci",
  "Route ve Ana Component",
  "Kullanilan Alt Componentler",
  "Kritik Kullanici Aksiyonlari",
  "Form Alanlari ve Parametreler",
  "UI State Yonetimi",
  "UI API Cagrilari",
  "BFF Endpoint Eslesmesi",
  "BFF Sorumluluklari",
  "Backend Endpoint Eslesmesi",
  "Backend Servis / Repository / Entity Akisi",
  "DTO ve Model Kullanimi",
  "Validasyon ve Hata Yonetimi",
  "Guvenlik Gozlemleri",
  "Degisiklik Etkisi ve Riskler",
  "Kaynak Referanslari",
  "Belirsizlikler"
];

export class PageDocumentQualityScorer {
  async score(multiRepoRoot: string, pageRoot: string): Promise<PageDocumentQualityScore> {
    const pageFlowPath = path.join(pageRoot, "page-flow.json");
    const gapsPath = path.join(pageRoot, "detected-gaps.json");
    const finalDocPath = path.join(pageRoot, "final-page-technical-analysis.md");
    const contextPackAvailable = await exists(path.join(pageRoot, "page-context-pack.md"));
    const evidencePackAvailable = await exists(path.join(pageRoot, "page-evidence-pack.md"));
    const pageFlowAvailable = await exists(pageFlowPath);
    const gapsAvailable = await exists(gapsPath);
    const qwenPageAvailable = await exists(path.join(pageRoot, "qwen-page-semantics.json"));
    const qwenInteractionAvailable = await exists(path.join(pageRoot, "qwen-interaction-semantics.jsonl"));
    const pageFlow = await readJson(pageFlowPath);
    const selectedPage = pageFlow.selectedPage as Record<string, unknown> | undefined;
    const finalDoc = await readOptional(finalDocPath) || await readOptional(path.join(pageRoot, "copilot-draft.md"));
    const finalDocAvailable = await exists(finalDocPath);
    const outputFreshnessDependencies = [
      "page-context-pack.md",
      "page-evidence-pack.md",
      ...(gapsAvailable ? ["detected-gaps.json"] : []),
      ...(finalDocAvailable ? ["copilot-draft.md"] : []),
      ...((await exists(path.join(pageRoot, "repaired-sections.md"))) ? ["repaired-sections.md"] : [])
    ];
    const outputChecks: Array<{ target: string; dependencies: string[] }> = [{
      target: finalDocAvailable ? "final-page-technical-analysis.md" : "copilot-draft.md",
      dependencies: outputFreshnessDependencies
    }];
    const draftDependencies = [
      "page-context-pack.md",
      "page-evidence-pack.md",
      ...(qwenPageAvailable ? ["qwen-page-semantics.json"] : []),
      ...(qwenInteractionAvailable ? ["qwen-interaction-semantics.jsonl"] : [])
    ];
    outputChecks.push({ target: "copilot-draft.md", dependencies: draftDependencies });
    if (qwenPageAvailable) {
      outputChecks.push({ target: "qwen-page-semantics.json", dependencies: ["page-context-pack.md", "page-evidence-pack.md"] });
    }
    if (qwenInteractionAvailable) {
      outputChecks.push({ target: "qwen-interaction-semantics.jsonl", dependencies: ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"] });
    }
    const outputFreshness = await new PageOutputFreshnessService().checkMany(pageRoot, outputChecks);
    const outputFreshnessIssueCount = outputFreshness.issues.length;
    const gaps = await readJsonArray(gapsPath);
    const headings = extractNormalizedHeadings(finalDoc);
    const requiredSectionsPresent = requiredSections.filter((section) => headings.has(normalizeHeading(section))).length;
    const sourceReferenceCount = (finalDoc.match(/src[\\/][^\s)`]+?\.(?:java|ts|tsx|js|jsx|properties|ya?ml|json)/g) ?? []).length;
    const highSeverityGapCount = gaps.filter((gap) => gap.severity === "high").length;
    const qwenFreshnessIssues = outputFreshness.issues.filter((issue) => issue.target.startsWith("qwen-")).length;
    const qwenSemanticCoverage = qwenPageAvailable ? (qwenFreshnessIssues ? 0.5 : 1) : 0;
    const finalDocumentLength = finalDoc.length;
    const metricsWithUnknownData = [
      ...(!pageFlowAvailable ? ["page-flow"] : []),
      ...(!contextPackAvailable ? ["context-pack"] : []),
      ...(!evidencePackAvailable ? ["evidence-pack"] : []),
      ...(!gapsAvailable ? ["gap-report"] : []),
      ...(!finalDoc ? ["final-or-draft-document"] : []),
      ...(outputFreshnessIssueCount ? ["stale-output"] : [])
    ];

    const uiApiCallCount = (pageFlow.uiApiCalls as unknown[] | undefined)?.length ?? 0;
    const uiApiCallCoverage = ratio(uiApiCallCount, uiApiCallCount);
    const bffMatchCoverage = ratio(nonEmptyCount(pageFlow.uiToBffMatches, "bffEndpoint"), uiApiCallCount);
    const beMatchCoverage = ratio(nonEmptyCount(pageFlow.bffToBeMatches, "beEndpoint"), Math.max(1, nonEmptyCount(pageFlow.uiToBffMatches, "bffEndpoint")));
    const beServiceFlows = asRecords(pageFlow.beServiceFlows);
    const trustedBeServiceFlowCount = beServiceFlows.filter((flow) => String(flow.confidence ?? "") !== "low").length;
    const serviceFlowCoverage = ratio(trustedBeServiceFlowCount, Math.max(1, nonEmptyCount(pageFlow.bffToBeMatches, "beEndpoint")));
    const repositoryEntityCoverage = ratio(((pageFlow.repositories as unknown[] | undefined)?.length ?? 0) + ((pageFlow.entities as unknown[] | undefined)?.length ?? 0), 2);
    const parameterCoverage = /parametre|parameter|form alan/i.test(finalDoc) ? 0.8 : 0;
    const validationCoverage = /validasyon|validation|@Valid|hata/i.test(finalDoc) ? 0.7 : 0;

    const score = Math.max(0, Math.min(100, Math.round(
      (requiredSectionsPresent / requiredSections.length) * 25 +
      Math.min(sourceReferenceCount / 10, 1) * 15 +
      (1 - Math.min(gaps.length / 10, 1)) * 15 +
      (1 - Math.min(highSeverityGapCount / 3, 1)) * 10 +
      bffMatchCoverage * 8 +
      beMatchCoverage * 8 +
      parameterCoverage * 5 +
      validationCoverage * 5 +
      serviceFlowCoverage * 4 +
      repositoryEntityCoverage * 3 +
      qwenSemanticCoverage * 1 +
      (evidencePackAvailable ? 1 : 0) +
      (contextPackAvailable ? 1 : 0) +
      documentLengthScore(finalDocumentLength) * 2 -
      Math.min(metricsWithUnknownData.length * 4, 12) -
      Math.min(outputFreshnessIssueCount * 2, 10)
    )));

    const result: PageDocumentQualityScore = {
      page: String(selectedPage?.pageName ?? path.basename(pageRoot)),
      route: selectedPage?.route ? String(selectedPage.route) : undefined,
      score,
      grade: grade(score),
      requiredSectionsPresent,
      requiredSectionsTotal: requiredSections.length,
      sourceReferenceCount,
      unresolvedGapCount: gaps.length,
      highSeverityGapCount,
      uiApiCallCoverage,
      bffMatchCoverage,
      beMatchCoverage,
      parameterCoverage,
      validationCoverage,
      serviceFlowCoverage,
      repositoryEntityCoverage,
      qwenSemanticCoverage,
      evidencePackAvailable,
      contextPackAvailable,
      finalDocumentLength,
      metricsWithUnknownData,
      outputFreshnessIssues: outputFreshnessIssueCount
    };
    await fs.writeFile(path.join(pageRoot, "quality-score.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await appendQuality(multiRepoRoot, result);
    return result;
  }
}

async function appendQuality(multiRepoRoot: string, score: PageDocumentQualityScore): Promise<void> {
  const target = path.join(multiRepoRoot, "quality", "page-document-quality.jsonl");
  const existing = await readJsonl<PageDocumentQualityScore>(target);
  await writeJsonl(target, [...existing.filter((item) => item.page !== score.page || item.route !== score.route), score]);
}

function ratio(value: number, total: number): number {
  if (total <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, value / total));
}

function nonEmptyCount(value: unknown, key: string): number {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && Boolean((item as Record<string, unknown>)[key])).length : 0;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function extractNormalizedHeadings(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => normalizeHeading(match[1])));
}

function normalizeHeading(value: string): string {
  return foldToAscii(value)
    .replace(/^\s*\d+[\).\-\s]+/, "")
    .replace(/[^a-z0-9]/g, "");
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

function documentLengthScore(length: number): number {
  if (length < 2000) {
    return 0;
  }
  if (length < 6000) {
    return 0.5;
  }
  return 1;
}

function grade(score: number): PageDocumentQualityScore["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readJsonArray(filePath: string): Promise<Array<Record<string, unknown>>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
