import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { parseBitbucketUrl } from "../git/bitbucketUrlParser";
import { assertPathContainedForWrite, LocalStorageService } from "../storage/localStorageService";
import { atomicWriteJson } from "../storage/atomicFile";
import { SelectedPageStateService } from "../pageanalysis/selectedPageStateService";
import { sha256 } from "../utils/hash";
import { safeName, safePathSegment } from "../utils/pathUtils";
import {
  assertRepositoryUrlHasNoEmbeddedCredentials,
  repositoryOriginIdentity,
  repositoryUrlForStorage
} from "../utils/repositoryUrl";

export type MultiRepoRole = "ui" | "bff" | "be";
export type MultiRepoStatus = "not-analyzed" | "ready" | "analyzed" | "error";

export interface MultiRepoInput {
  projectName: string;
  branch: string;
  uiRepoUrl: string;
  bffRepoUrl: string;
  beRepoUrl: string;
}

export interface MultiRepoEntry {
  type: "react" | "spring-bff" | "spring-be";
  url: string;
  localPath: string;
  status: MultiRepoStatus;
  error?: string;
}

export interface MultiRepoManifest {
  schemaVersion?: 3;
  pipelineIdentity?: string;
  projectName: string;
  branch: string;
  repos: Record<MultiRepoRole, MultiRepoEntry>;
  updatedAt: string;
}

export const multiRepoManifestSchemaVersion = 3 as const;

const activePipelineIdentityKey = "bankSpringDocs.multiRepo.activePipelineIdentity";
const roles: MultiRepoRole[] = ["ui", "bff", "be"];

const roleTypes: Record<MultiRepoRole, MultiRepoEntry["type"]> = {
  ui: "react",
  bff: "spring-bff",
  be: "spring-be"
};

export class MultiRepoManifestService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async readManifest(): Promise<MultiRepoManifest | undefined> {
    try {
      const content = await fs.readFile(this.getManifestPath(), "utf8");
      const parsed = JSON.parse(content) as MultiRepoManifest;
      const normalized = this.normalizeManifest(parsed);
      await this.context.globalState.update(activePipelineIdentityKey, normalized.pipelineIdentity);
      if (roles.some((role) => parsed.repos[role].url !== normalized.repos[role].url)) {
        await this.writeManifest(normalized);
      }
      return normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async saveManifest(input: MultiRepoInput): Promise<MultiRepoManifest> {
    for (const repoUrl of [input.uiRepoUrl, input.bffRepoUrl, input.beRepoUrl]) {
      if (repoUrl.trim()) {
        assertRepositoryUrlHasNoEmbeddedCredentials(repoUrl);
      }
    }
    const previous = await this.readManifest();
    const projectName = input.projectName.trim() || previous?.projectName || "UI BFF BE";
    const branch = input.branch.trim() || previous?.branch || "release/liv";
    const pipelineIdentity = createMultiRepoPipelineIdentity({
      projectName,
      branch,
      uiRepoUrl: input.uiRepoUrl.trim(),
      bffRepoUrl: input.bffRepoUrl.trim(),
      beRepoUrl: input.beRepoUrl.trim()
    });
    const canReusePreviousState = previous?.pipelineIdentity === pipelineIdentity;
    const manifest: MultiRepoManifest = {
      schemaVersion: multiRepoManifestSchemaVersion,
      pipelineIdentity,
      projectName,
      branch,
      repos: {
        ui: this.createEntry("ui", input.uiRepoUrl.trim(), branch, projectName, previous, canReusePreviousState),
        bff: this.createEntry("bff", input.bffRepoUrl.trim(), branch, projectName, previous, canReusePreviousState),
        be: this.createEntry("be", input.beRepoUrl.trim(), branch, projectName, previous, canReusePreviousState)
      },
      updatedAt: new Date().toISOString()
    };

    await this.writeManifest(manifest);
    if (previous && !canReusePreviousState) {
      await new SelectedPageStateService(this.context).clearSelectedPage();
    }
    return manifest;
  }

  async updateManifest(manifest: MultiRepoManifest): Promise<MultiRepoManifest> {
    const updated = {
      ...this.normalizeManifest(manifest),
      schemaVersion: multiRepoManifestSchemaVersion,
      updatedAt: new Date().toISOString()
    };
    await this.writeManifest(updated);
    return updated;
  }

  getMultiRepoRoot(manifest?: MultiRepoManifest): string {
    const identity = manifest?.pipelineIdentity ?? this.context.globalState.get<string>(activePipelineIdentityKey);
    if (!identity || !/^[a-f0-9]{64}$/.test(identity)) {
      return this.getMultiRepoControlRoot();
    }
    return path.join(this.getMultiRepoControlRoot(), "workspaces", identity);
  }

  getMultiRepoControlRoot(): string {
    return path.join(this.getCloneRoot(), ".ai-docs", "multi-repo");
  }

  getCloneRoot(): string {
    return new LocalStorageService(this.context).getCloneRoot();
  }

  getManifestPath(): string {
    return path.join(this.getMultiRepoControlRoot(), "manifest.json");
  }

  getRepositoryRoot(projectName: string): string {
    return path.join(
      this.getCloneRoot(),
      "mr",
      safePathSegment(projectName || "ui-bff-be", "ui-bff-be", 24)
    );
  }

  private createEntry(
    role: MultiRepoRole,
    url: string,
    branch: string,
    projectName: string,
    previous?: MultiRepoManifest,
    canReusePreviousState = false
  ): MultiRepoEntry {
    const previousEntry = previous?.repos[role];
    const localPath = this.repositoryLocalPath(role, url, branch, projectName);

    const sameRepository = previousEntry
      ? canonicalRepositoryIdentity(previousEntry.url) === canonicalRepositoryIdentity(url)
      : false;
    const sameLocalPath = previousEntry
      ? path.resolve(previousEntry.localPath) === path.resolve(localPath)
      : false;
    const reusable = canReusePreviousState && sameRepository && sameLocalPath;
    const status: MultiRepoStatus = reusable && previousEntry
      ? previousEntry.status
      : "not-analyzed";

    return {
      type: roleTypes[role],
      url,
      localPath,
      status,
      error: reusable ? previousEntry?.error : undefined
    };
  }

  private getRepoFolderName(repoUrl: string, branch: string): string {
    try {
      const parsed = parseBitbucketUrl(repoUrl, branch);
      return `${safeName(parsed.repo).slice(0, 24)}-${sha256(`${canonicalRepositoryIdentity(repoUrl)}:${branch}`).slice(0, 8)}`;
    } catch {
      return `${safeName(repoUrl).slice(0, 24) || "repository"}-${sha256(`${canonicalRepositoryIdentity(repoUrl)}:${branch}`).slice(0, 8)}`;
    }
  }

  private async writeManifest(manifest: MultiRepoManifest): Promise<void> {
    await this.ensureStructure(manifest);
    await atomicWriteJson(path.join(this.getMultiRepoRoot(manifest), "manifest.json"), manifest);
    await atomicWriteJson(this.getManifestPath(), manifest);
    await this.context.globalState.update(activePipelineIdentityKey, manifest.pipelineIdentity);
  }

  private async ensureStructure(manifest: MultiRepoManifest): Promise<void> {
    const cloneRoot = this.getCloneRoot();
    await fs.mkdir(cloneRoot, { recursive: true });
    const controlRoot = this.getMultiRepoControlRoot();
    const root = this.getMultiRepoRoot(manifest);
    await assertPathContainedForWrite(cloneRoot, controlRoot);
    await assertPathContainedForWrite(cloneRoot, root);
    const folders = [
      controlRoot,
      root,
      path.join(root, "ui", "generated-docs"),
      path.join(root, "ui", "semantic"),
      path.join(root, "bff", "generated-docs"),
      path.join(root, "bff", "semantic"),
      path.join(root, "be", "generated-docs"),
      path.join(root, "be", "semantic"),
      path.join(root, "traceability"),
      path.join(root, "context-packs", "pages"),
      path.join(root, "generated-docs", "pages"),
      path.join(root, "generated-docs", "flows")
    ];

    for (const folder of folders) {
      await assertPathContainedForWrite(cloneRoot, folder);
      await fs.mkdir(folder, { recursive: true });
      await assertPathContainedForWrite(cloneRoot, folder);
    }
    await assertPathContainedForWrite(cloneRoot, controlRoot);
    await assertPathContainedForWrite(cloneRoot, root);
  }

  private normalizeManifest(manifest: MultiRepoManifest): MultiRepoManifest {
    if (!manifest || typeof manifest !== "object" || typeof manifest.projectName !== "string" ||
      typeof manifest.branch !== "string" || !manifest.repos || typeof manifest.repos !== "object") {
      throw new Error("Stored multi-repository manifest is malformed.");
    }
    for (const role of roles) {
      if (!manifest.repos[role] || typeof manifest.repos[role].url !== "string") {
        throw new Error("Stored multi-repository manifest is malformed.");
      }
    }

    const safeUrls: Record<MultiRepoRole, string> = {
      ui: repositoryUrlForStorage(manifest.repos.ui.url),
      bff: repositoryUrlForStorage(manifest.repos.bff.url),
      be: repositoryUrlForStorage(manifest.repos.be.url)
    };
    const identity = createMultiRepoPipelineIdentity({
      projectName: manifest.projectName,
      branch: manifest.branch,
      uiRepoUrl: safeUrls.ui,
      bffRepoUrl: safeUrls.bff,
      beRepoUrl: safeUrls.be
    });
    const migrated = manifest.schemaVersion !== multiRepoManifestSchemaVersion || manifest.pipelineIdentity !== identity;
    const normalizedRepos = {} as Record<MultiRepoRole, MultiRepoEntry>;
    for (const role of roles) {
      const previous = manifest.repos[role];
      const expectedPath = this.repositoryLocalPath(role, safeUrls[role], manifest.branch, manifest.projectName);
      const pathMatches = typeof previous.localPath === "string" && path.resolve(previous.localPath) === path.resolve(expectedPath);
      const status = !migrated && pathMatches && isMultiRepoStatus(previous.status)
        ? previous.status
        : "not-analyzed";
      normalizedRepos[role] = {
        type: roleTypes[role],
        url: safeUrls[role],
        localPath: expectedPath,
        status,
        error: status === previous.status ? previous.error : undefined
      };
    }
    return {
      schemaVersion: multiRepoManifestSchemaVersion,
      pipelineIdentity: identity,
      projectName: manifest.projectName,
      branch: manifest.branch,
      repos: normalizedRepos,
      updatedAt: typeof manifest.updatedAt === "string" ? manifest.updatedAt : new Date().toISOString()
    };
  }

  private repositoryLocalPath(role: MultiRepoRole, url: string, branch: string, projectName: string): string {
    return url
      ? path.join(this.getRepositoryRoot(projectName), `${role}-${this.getRepoFolderName(url, branch)}`)
      : path.join(this.getRepositoryRoot(projectName), role);
  }
}

export function createMultiRepoPipelineIdentity(input: MultiRepoInput): string {
  return sha256(JSON.stringify({
    version: multiRepoManifestSchemaVersion,
    projectName: input.projectName.trim().toLowerCase(),
    branch: input.branch.trim(),
    repositories: {
      ui: canonicalRepositoryIdentity(input.uiRepoUrl),
      bff: canonicalRepositoryIdentity(input.bffRepoUrl),
      be: canonicalRepositoryIdentity(input.beRepoUrl)
    }
  }));
}

export function canonicalRepositoryIdentity(repoUrl: string): string {
  return repositoryOriginIdentity(repoUrl);
}

function isMultiRepoStatus(value: unknown): value is MultiRepoStatus {
  return value === "not-analyzed" || value === "ready" || value === "analyzed" || value === "error";
}
