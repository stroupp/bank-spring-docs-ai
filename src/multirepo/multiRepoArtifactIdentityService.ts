import * as fs from "fs/promises";
import * as path from "path";
import {
  canonicalRepositoryIdentity,
  MultiRepoManifest,
  MultiRepoRole
} from "./multiRepoManifestService";

export type ArtifactIdentityProblem =
  | "missing"
  | "malformed"
  | "repository-mismatch"
  | "branch-mismatch"
  | "pipeline-mismatch";

export interface ArtifactIdentityIssue {
  role: MultiRepoRole;
  problem: ArtifactIdentityProblem;
  message: string;
}

interface RepositoryArtifactManifest {
  repositoryUrl?: unknown;
  branch?: unknown;
  pipelineIdentity?: unknown;
}

export class MultiRepoArtifactIdentityService {
  async inspect(multiRepoRoot: string, manifest: MultiRepoManifest): Promise<ArtifactIdentityIssue[]> {
    const roles: MultiRepoRole[] = ["ui", "bff", "be"];
    const nested = await Promise.all(roles.map((role) => this.inspectRole(multiRepoRoot, manifest, role)));
    return nested.flat();
  }

  async assertCompatible(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    options: { allowMissing?: boolean } = {}
  ): Promise<void> {
    const issues = (await this.inspect(multiRepoRoot, manifest))
      .filter((issue) => !options.allowMissing || issue.problem !== "missing");
    if (issues.length) {
      throw new Error(`Multi-repository artifacts do not match the active manifest. ${issues.map((issue) => issue.message).join(" ")}`);
    }
  }

  private async inspectRole(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    role: MultiRepoRole
  ): Promise<ArtifactIdentityIssue[]> {
    const manifestPath = path.join(multiRepoRoot, role, "manifest.json");
    let parsed: RepositoryArtifactManifest;
    try {
      parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RepositoryArtifactManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [{ role, problem: "missing", message: `${role.toUpperCase()} analysis manifest is missing.` }];
      }
      return [{ role, problem: "malformed", message: `${role.toUpperCase()} analysis manifest is unreadable or malformed.` }];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [{ role, problem: "malformed", message: `${role.toUpperCase()} analysis manifest is unreadable or malformed.` }];
    }

    const issues: ArtifactIdentityIssue[] = [];
    if (typeof parsed.repositoryUrl !== "string" ||
      canonicalRepositoryIdentity(parsed.repositoryUrl) !== canonicalRepositoryIdentity(manifest.repos[role].url)) {
      issues.push({
        role,
        problem: "repository-mismatch",
        message: `${role.toUpperCase()} artifacts belong to a different repository.`
      });
    }
    if (typeof parsed.branch !== "string" || parsed.branch.trim() !== manifest.branch.trim()) {
      issues.push({
        role,
        problem: "branch-mismatch",
        message: `${role.toUpperCase()} artifacts belong to a different branch.`
      });
    }
    if (manifest.pipelineIdentity && parsed.pipelineIdentity !== manifest.pipelineIdentity) {
      issues.push({
        role,
        problem: "pipeline-mismatch",
        message: `${role.toUpperCase()} artifacts belong to a different pipeline selection.`
      });
    }
    return issues;
  }
}
