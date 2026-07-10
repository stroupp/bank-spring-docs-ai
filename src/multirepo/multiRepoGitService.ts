import { GitService } from "../git/gitService";
import { MultiRepoManifest, MultiRepoRole } from "./multiRepoManifestService";

export interface MultiRepoCloneResult {
  manifest: MultiRepoManifest;
  cloned: MultiRepoRole[];
  failed: Array<{ role: MultiRepoRole; message: string }>;
}

export class MultiRepoGitService {
  private readonly gitService = new GitService();

  async cloneOrUpdateAll(manifest: MultiRepoManifest): Promise<MultiRepoCloneResult> {
    const cloned: MultiRepoRole[] = [];
    const failed: Array<{ role: MultiRepoRole; message: string }> = [];
    const roles: MultiRepoRole[] = ["ui", "bff", "be"];

    for (const role of roles) {
      const repo = manifest.repos[role];
      if (!repo.url.trim()) {
        repo.status = "error";
        repo.error = "Repository URL bos.";
        failed.push({ role, message: repo.error });
        continue;
      }

      try {
        await this.gitService.cloneOrUpdate(repo.url, manifest.branch, repo.localPath);
        repo.status = "ready";
        repo.error = undefined;
        cloned.push(role);
      } catch (error) {
        repo.status = "error";
        repo.error = error instanceof Error ? error.message : String(error);
        failed.push({ role, message: repo.error });
      }
    }

    return {
      manifest,
      cloned,
      failed
    };
  }
}
