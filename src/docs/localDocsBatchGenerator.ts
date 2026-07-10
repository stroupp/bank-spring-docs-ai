import { AnalysisQualityReportGenerator } from "../analyzer/analysisQualityReportGenerator";
import { LocalDocumentKind, LocalDocumentationGenerator } from "./localDocumentationGenerator";

export const allLocalDocumentKinds: LocalDocumentKind[] = [
  "repository-overview",
  "spring-architecture",
  "api-endpoints",
  "service-layer",
  "repository-layer",
  "entities",
  "configuration",
  "external-integrations",
  "test-analysis",
  "technical-analysis"
];

export interface LocalDocsBatchResult {
  generatedPaths: string[];
  qualityReportMarkdownPath: string;
  qualityReportJsonPath: string;
}

export async function generateAllLocalDocs(aiDocsPath: string, onDocument?: (kind: LocalDocumentKind) => void): Promise<LocalDocsBatchResult> {
  const generator = new LocalDocumentationGenerator();
  const generatedPaths: string[] = [];
  for (const kind of allLocalDocumentKinds) {
    onDocument?.(kind);
    generatedPaths.push(await generator.generate(aiDocsPath, kind));
  }
  const quality = await new AnalysisQualityReportGenerator().generate(aiDocsPath);
  return {
    generatedPaths,
    qualityReportMarkdownPath: quality.markdownPath,
    qualityReportJsonPath: quality.jsonPath
  };
}
