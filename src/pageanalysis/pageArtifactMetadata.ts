import * as fs from "fs/promises";
import * as path from "path";
import { sha256 } from "../utils/hash";

export const pagePipelineVersion = "page-analysis-v3";

export interface PageArtifactMetadata {
  generatedAt: string;
  projectName: string;
  branch: string;
  pageName: string;
  route?: string;
  sourceArtifacts: Record<string, string>;
  sourceArtifactModifiedTimes: Record<string, string>;
  inputHash: string;
  pipelineVersion: string;
}

export async function buildPageArtifactMetadata(pageRoot: string, inputFiles: string[] = []): Promise<PageArtifactMetadata> {
  const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
  const selectedPage = asRecord(pageFlow.selectedPage);
  const sourceArtifacts = stringRecord(pageFlow.sourceArtifactModifiedTimes ?? pageFlow.sourceArtifacts);
  const inputs: Record<string, string> = {};
  for (const fileName of inputFiles) {
    inputs[fileName] = await fileDigest(path.join(pageRoot, fileName));
  }

  return {
    generatedAt: new Date().toISOString(),
    projectName: String(pageFlow.projectName ?? "multi-repo-page-analysis"),
    branch: String(pageFlow.branch ?? "unknown"),
    pageName: String(selectedPage.pageName ?? path.basename(pageRoot)),
    ...(selectedPage.route ? { route: String(selectedPage.route) } : {}),
    sourceArtifacts,
    sourceArtifactModifiedTimes: sourceArtifacts,
    inputHash: sha256(JSON.stringify({
      projectName: pageFlow.projectName,
      branch: pageFlow.branch,
      selectedPage,
      sourceArtifacts,
      inputs
    })),
    pipelineVersion: pagePipelineVersion
  };
}

export function pageMetadataComment(metadata: PageArtifactMetadata): string {
  return `<!-- bank-spring-docs-metadata ${JSON.stringify(metadata)} -->`;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fileDigest(filePath: string): Promise<string> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return "missing";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, String(item)]));
}
