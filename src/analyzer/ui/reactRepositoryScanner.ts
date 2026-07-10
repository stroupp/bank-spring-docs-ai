import * as fs from "fs/promises";
import * as path from "path";
import { relativePosix } from "../../utils/pathUtils";
import { classifyReactFile, ReactFileClassification } from "./reactFileClassifier";

export interface ReactScannedFile {
  file: string;
  absolutePath: string;
  extension: string;
  classification: ReactFileClassification;
  size: number;
  content: string;
}

const ignoredFolders = new Set([".git", ".idea", ".vscode", ".ai-docs", "node_modules", "dist", "build", "coverage", "out"]);
const relevantConfigPatterns = [/^package\.json$/i, /^vite\.config\./i, /^webpack\.config\./i, /^next\.config\./i];
const relevantExtensions = new Set([".tsx", ".ts", ".jsx", ".js"]);

export class ReactRepositoryScanner {
  async scan(repoRoot: string): Promise<ReactScannedFile[]> {
    const files: ReactScannedFile[] = [];
    await this.walk(repoRoot, repoRoot, files);
    return files;
  }

  detectIndicators(files: ReactScannedFile[]): string[] {
    const indicators: string[] = [];
    const packageJson = files.find((file) => file.file === "package.json");
    if (packageJson && /"react"\s*:/.test(packageJson.content)) {
      indicators.push("package.json react dependency");
    }
    if (files.some((file) => /^vite\.config\./i.test(path.posix.basename(file.file)))) {
      indicators.push("Vite config");
    }
    if (files.some((file) => /^next\.config\./i.test(path.posix.basename(file.file)))) {
      indicators.push("Next.js config");
    }
    if (files.some((file) => ["src/App.tsx", "src/App.jsx", "src/main.tsx", "src/index.tsx"].includes(file.file))) {
      indicators.push("React entry files");
    }
    return indicators;
  }

  private async walk(repoRoot: string, currentDir: string, files: ReactScannedFile[]): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredFolders.has(entry.name)) {
          await this.walk(repoRoot, path.join(currentDir, entry.name), files);
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

      const buffer = await fs.readFile(absolutePath);
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
