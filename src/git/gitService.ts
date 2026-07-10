import * as fs from "fs/promises";
import * as path from "path";
import { runCommand } from "../utils/shell";

export class GitService {
  async cloneOrUpdate(repoUrl: string, branch: string, targetDir: string): Promise<void> {
    const gitDir = path.join(targetDir, ".git");
    const exists = await this.exists(gitDir);

    if (!exists) {
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      try {
        await runCommand("git", ["-c", "core.longpaths=true", "clone", "--depth=1", "--branch", branch, repoUrl, targetDir]);
      } catch (error) {
        throw this.decorateBranchError(error, branch, "clone");
      }
      return;
    }

    try {
      await runCommand("git", ["-c", "core.longpaths=true", "fetch", "origin", branch], targetDir);
      await runCommand("git", ["-c", "core.longpaths=true", "checkout", branch], targetDir);
      await runCommand("git", ["-c", "core.longpaths=true", "pull", "origin", branch], targetDir);
    } catch (error) {
      throw this.decorateBranchError(error, branch, "update");
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private decorateBranchError(error: unknown, branch: string, operation: string): Error {
    const detail = error instanceof Error ? error.message : String(error);
    if (/couldn't find remote ref|remote branch .* not found|pathspec .* did not match/i.test(detail)) {
      return new Error(`Could not ${operation} branch "${branch}". Verify the branch exists or enter another branch name.`);
    }
    return new Error(`Git ${operation} failed for branch "${branch}": ${detail}`);
  }
}
