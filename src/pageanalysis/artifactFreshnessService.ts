import * as fs from "fs/promises";
import * as path from "path";
import { atomicWriteJson } from "../storage/atomicFile";

export interface ArtifactFreshnessWarning {
  artifact: string;
  sourceArtifact?: string;
  problem: "missing" | "stale" | "invalid-metadata";
  message: string;
}

export interface ArtifactFreshnessResult {
  checkedAt: string;
  warnings: ArtifactFreshnessWarning[];
  reportPath: string;
}

const requiredPageArtifacts = ["page-flow.json", "page-context-pack.md", "page-evidence-pack.md"];

export class ArtifactFreshnessService {
  async check(pageRoot: string): Promise<ArtifactFreshnessResult> {
    await fs.mkdir(pageRoot, { recursive: true });
    const warnings: ArtifactFreshnessWarning[] = [];
    const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
    const sourceTimes = stringRecord(pageFlow.sourceArtifactModifiedTimes ?? pageFlow.sourceArtifacts);

    for (const artifact of requiredPageArtifacts) {
      if (!await statOptional(path.join(pageRoot, artifact))) {
        warnings.push({
          artifact,
          problem: "missing",
          message: `Required page artifact is missing: ${artifact}.`
        });
      }
    }

    if (!Object.keys(sourceTimes).length && Object.keys(pageFlow).length) {
      warnings.push({
        artifact: "page-flow.json",
        problem: "invalid-metadata",
        message: "page-flow.json does not contain source artifact modification metadata."
      });
    }

    for (const artifact of ["page-context-pack.md", "page-evidence-pack.md"]) {
      const target = await statOptional(path.join(pageRoot, artifact));
      if (!target) {
        continue;
      }
      for (const [sourceArtifact, modifiedAt] of Object.entries(sourceTimes)) {
        if (!modifiedAt || modifiedAt === "missing") {
          continue;
        }
        const sourceTime = Date.parse(modifiedAt);
        if (Number.isFinite(sourceTime) && target.mtimeMs < sourceTime) {
          warnings.push({
            artifact,
            sourceArtifact,
            problem: "stale",
            message: `${artifact} is older than source artifact ${sourceArtifact}.`
          });
        }
      }
    }

    const reportPath = path.join(pageRoot, "artifact-freshness.json");
    const result: ArtifactFreshnessResult = {
      checkedAt: new Date().toISOString(),
      warnings,
      reportPath
    };
    await atomicWriteJson(reportPath, result);
    return result;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function statOptional(filePath: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}
