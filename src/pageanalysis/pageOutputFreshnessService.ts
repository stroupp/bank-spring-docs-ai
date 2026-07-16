import * as fs from "fs/promises";
import * as path from "path";
import { atomicWriteJson } from "../storage/atomicFile";

export interface PageOutputFreshnessIssue {
  target: string;
  dependency: string;
  targetModifiedAt?: string;
  dependencyModifiedAt?: string;
  problem: "missing-target" | "missing-dependency" | "stale-target";
}

export interface PageOutputFreshnessResult {
  checkedAt: string;
  issues: PageOutputFreshnessIssue[];
  reportPath: string;
}

export class PageOutputFreshnessService {
  async check(pageRoot: string, target: string, dependencies: string[]): Promise<PageOutputFreshnessResult> {
    return this.checkMany(pageRoot, [{ target, dependencies }]);
  }

  async checkMany(pageRoot: string, checks: Array<{ target: string; dependencies: string[] }>): Promise<PageOutputFreshnessResult> {
    const issues = (await Promise.all(checks.map((check) => inspectTarget(pageRoot, check.target, check.dependencies)))).flat();
    const reportPath = path.join(pageRoot, "output-freshness.json");
    const result = { checkedAt: new Date().toISOString(), issues, reportPath };
    await atomicWriteJson(reportPath, result);
    return result;
  }
}

async function inspectTarget(pageRoot: string, target: string, dependencies: string[]): Promise<PageOutputFreshnessIssue[]> {
    const targetStat = await statRelative(pageRoot, target);
    const issues: PageOutputFreshnessIssue[] = [];
    if (!targetStat.mtimeMs) {
      issues.push({ target, dependency: "", problem: "missing-target" });
    }

    for (const dependency of dependencies) {
      const dependencyStat = await statRelative(pageRoot, dependency);
      if (!dependencyStat.mtimeMs) {
        issues.push({ target, dependency, problem: "missing-dependency" });
        continue;
      }
      if (targetStat.mtimeMs && targetStat.mtimeMs < dependencyStat.mtimeMs) {
        issues.push({
          target,
          dependency,
          targetModifiedAt: targetStat.mtimeIso,
          dependencyModifiedAt: dependencyStat.mtimeIso,
          problem: "stale-target"
        });
      }
    }
    return issues;
}

async function statRelative(root: string, relativePath: string): Promise<{ mtimeMs?: number; mtimeIso?: string }> {
  try {
    const stat = await fs.stat(path.join(root, relativePath));
    return { mtimeMs: stat.mtimeMs, mtimeIso: stat.mtime.toISOString() };
  } catch {
    return {};
  }
}
