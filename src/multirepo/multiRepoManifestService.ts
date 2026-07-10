import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { parseBitbucketUrl } from "../git/bitbucketUrlParser";
import { LocalStorageService } from "../storage/localStorageService";
import { sha256 } from "../utils/hash";
import { safeName } from "../utils/pathUtils";

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
  projectName: string;
  branch: string;
  repos: Record<MultiRepoRole, MultiRepoEntry>;
  updatedAt: string;
}

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
      return JSON.parse(content) as MultiRepoManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async saveManifest(input: MultiRepoInput): Promise<MultiRepoManifest> {
    const previous = await this.readManifest();
    const projectName = input.projectName.trim() || previous?.projectName || "UI BFF BE";
    const branch = input.branch.trim() || previous?.branch || "release/liv";
    const manifest: MultiRepoManifest = {
      projectName,
      branch,
      repos: {
        ui: this.createEntry("ui", input.uiRepoUrl.trim(), branch, projectName, previous),
        bff: this.createEntry("bff", input.bffRepoUrl.trim(), branch, projectName, previous),
        be: this.createEntry("be", input.beRepoUrl.trim(), branch, projectName, previous)
      },
      updatedAt: new Date().toISOString()
    };

    await this.writeManifest(manifest);
    return manifest;
  }

  async updateManifest(manifest: MultiRepoManifest): Promise<MultiRepoManifest> {
    const updated = { ...manifest, updatedAt: new Date().toISOString() };
    await this.writeManifest(updated);
    return updated;
  }

  getMultiRepoRoot(): string {
    return path.join(new LocalStorageService(this.context).getCloneRoot(), ".ai-docs", "multi-repo");
  }

  getManifestPath(): string {
    return path.join(this.getMultiRepoRoot(), "manifest.json");
  }

  getRepositoryRoot(projectName: string): string {
    return path.join(new LocalStorageService(this.context).getCloneRoot(), "mr", safeName(projectName || "ui-bff-be").slice(0, 24));
  }

  private createEntry(
    role: MultiRepoRole,
    url: string,
    branch: string,
    projectName: string,
    previous?: MultiRepoManifest
  ): MultiRepoEntry {
    const previousEntry = previous?.repos[role];
    const localPath = url
      ? path.join(this.getRepositoryRoot(projectName), `${role}-${this.getRepoFolderName(url, branch)}`)
      : previousEntry?.localPath || path.join(this.getRepositoryRoot(projectName), role);

    const status: MultiRepoStatus = previousEntry?.url === url
      ? previousEntry.status
      : "not-analyzed";

    return {
      type: roleTypes[role],
      url,
      localPath,
      status,
      error: previousEntry?.url === url ? previousEntry.error : undefined
    };
  }

  private getRepoFolderName(repoUrl: string, branch: string): string {
    try {
      const parsed = parseBitbucketUrl(repoUrl, branch);
      return `${safeName(parsed.repo).slice(0, 24)}-${sha256(`${repoUrl}:${branch}`).slice(0, 8)}`;
    } catch {
      return `${safeName(repoUrl).slice(0, 24) || "repository"}-${sha256(`${repoUrl}:${branch}`).slice(0, 8)}`;
    }
  }

  private async writeManifest(manifest: MultiRepoManifest): Promise<void> {
    await this.ensureStructure();
    await fs.writeFile(this.getManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private async ensureStructure(): Promise<void> {
    const root = this.getMultiRepoRoot();
    const folders = [
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

    await Promise.all(folders.map((folder) => fs.mkdir(folder, { recursive: true })));
  }
}
