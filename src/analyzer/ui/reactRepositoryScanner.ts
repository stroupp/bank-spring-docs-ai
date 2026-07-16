import * as fs from "fs/promises";
import * as path from "path";
import { relativePosix } from "../../utils/pathUtils";
import { classifyReactFile, ReactFileClassification } from "./reactFileClassifier";
import { RepositoryScanBudget, RepositoryScanOptions } from "../repositoryScanPolicy";

export interface ReactScannedFile {
  file: string;
  absolutePath: string;
  extension: string;
  classification: ReactFileClassification;
  size: number;
  content: string;
}

const ignoredFolders = new Set([".git", ".idea", ".vscode", ".ai-docs", "node_modules", "dist", "build", "coverage", "out", ".next", ".turbo"]);
const relevantConfigPatterns = [/^package\.json$/i, /^vite\.config\./i, /^webpack\.config\./i, /^next\.config\./i];
const relevantExtensions = new Set([".tsx", ".ts", ".jsx", ".js"]);

export class ReactRepositoryScanner {
  async scan(repoRoot: string, options: RepositoryScanOptions = {}): Promise<ReactScannedFile[]> {
    const files: ReactScannedFile[] = [];
    const budget = new RepositoryScanBudget(options);
    await this.walk(repoRoot, repoRoot, files, budget);
    return files.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  }

  detectIndicators(files: ReactScannedFile[]): string[] {
    const indicators: string[] = [];
    const packageJson = files.find((file) => path.posix.basename(file.file).toLowerCase() === "package.json" && /"react"\s*:/.test(file.content));
    if (packageJson) {
      indicators.push("package.json react dependency");
    }
    if (files.some((file) => /^vite\.config\./i.test(path.posix.basename(file.file)))) {
      indicators.push("Vite config");
    }
    if (files.some((file) => /^next\.config\./i.test(path.posix.basename(file.file)))) {
      indicators.push("Next.js config");
    }
    if (files.some((file) => /(?:^|\/)src\/(?:App\.(?:tsx|jsx)|main\.tsx|index\.tsx)$/i.test(file.file))) {
      indicators.push("React entry files");
    }
    return indicators;
  }

  private async walk(repoRoot: string, currentDir: string, files: ReactScannedFile[], budget: RepositoryScanBudget): Promise<void> {
    budget.checkCancellation();
    const entries = (await fs.readdir(currentDir, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      budget.checkCancellation();
      if (entry.isDirectory()) {
        if (!ignoredFolders.has(entry.name.toLowerCase())) {
          await this.walk(repoRoot, path.join(currentDir, entry.name), files, budget);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relative = relativePosix(repoRoot, absolutePath);
      if (!this.isRelevant(relative)) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      budget.assertReadable(relative, stat.size);
      const buffer = await fs.readFile(absolutePath);
      budget.commit(relative, buffer.length);
      if (buffer.includes(0)) {
        continue;
      }

      const content = buffer.toString("utf8");
      files.push({
        file: relative,
        absolutePath,
        extension: path.extname(entry.name),
        classification: classifyReactFile(relative, content),
        size: buffer.length,
        content
      });
    }
  }

  private isRelevant(relative: string): boolean {
    const name = path.posix.basename(relative);
    return relevantExtensions.has(path.posix.extname(name)) || relevantConfigPatterns.some((pattern) => pattern.test(name));
  }
}
