import * as fs from "fs/promises";
import * as path from "path";
import { classifyJavaFile, JavaFileType } from "./javaFileClassifier";
import { relativePosix } from "../utils/pathUtils";
import { RepositoryScanBudget, RepositoryScanOptions } from "./repositoryScanPolicy";

export interface ScannedFile {
  file: string;
  absolutePath: string;
  extension: string;
  kind: "java" | "build" | "config";
  classification?: JavaFileType;
  size: number;
  content: string;
  modulePath?: string;
  sourceSet?: "main" | "test";
  sourceRoot?: string;
}

const ignoredFolders = new Set([".git", ".idea", ".vscode", ".ai-docs", "node_modules", "target", "build", "dist", "out", ".gradle"]);
const springConfigName = /^(?:application|bootstrap)(?:-.+)?\.(?:properties|ya?ml)$/i;

export class RepositoryScanner {
  async scan(repoRoot: string, options: RepositoryScanOptions = {}): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    const budget = new RepositoryScanBudget(options);
    await this.walk(repoRoot, repoRoot, files, budget);
    return files.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  }

  detectBuildTool(files: ScannedFile[]): "Maven" | "Gradle" | "Unknown" {
    if (files.some((file) => file.file.endsWith("pom.xml"))) {
      return "Maven";
    }
    if (files.some((file) => file.file.endsWith("build.gradle") || file.file.endsWith("build.gradle.kts"))) {
      return "Gradle";
    }
    return "Unknown";
  }

  private async walk(repoRoot: string, currentDir: string, files: ScannedFile[], budget: RepositoryScanBudget): Promise<void> {
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
      const extension = path.extname(entry.name);
      const kind = this.kindFor(relative);
      const layout = sourceLayout(relative);
      files.push({
        file: relative,
        absolutePath,
        extension,
        kind,
        classification: kind === "java" ? classifyJavaFile(relative, content) : undefined,
        size: buffer.length,
        content,
        modulePath: layout?.modulePath,
        sourceSet: layout?.sourceSet,
        sourceRoot: layout?.sourceRoot
      });
    }
  }

  private isRelevant(relative: string): boolean {
    const normalized = relative.toLowerCase();
    const name = path.posix.basename(normalized);
    return (
      name === "pom.xml" ||
      name === "build.gradle" ||
      name === "build.gradle.kts" ||
      name === "settings.gradle" ||
      name === "settings.gradle.kts" ||
      isSourcePath(normalized, "main", "java") && normalized.endsWith(".java") ||
      isSourcePath(normalized, "test", "java") && normalized.endsWith(".java") ||
      isSourcePath(normalized, "main", "resources") && springConfigName.test(name)
    );
  }

  private kindFor(relative: string): "java" | "build" | "config" {
    const normalized = relative.toLowerCase();
    const name = path.posix.basename(normalized);
    if (normalized.endsWith(".java")) {
      return "java";
    }
    if (springConfigName.test(name)) {
      return "config";
    }
    return "build";
  }
}

function isSourcePath(normalizedPath: string, sourceSet: "main" | "test", folder: "java" | "resources"): boolean {
  const marker = `src/${sourceSet}/${folder}/`;
  return normalizedPath.startsWith(marker) || normalizedPath.includes(`/${marker}`);
}

function sourceLayout(relativePath: string): { modulePath: string; sourceSet: "main" | "test"; sourceRoot: string } | undefined {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const sourceIndex = segments.findIndex((segment, index) =>
    segment.toLowerCase() === "src" &&
    (segments[index + 1]?.toLowerCase() === "main" || segments[index + 1]?.toLowerCase() === "test") &&
    (segments[index + 2]?.toLowerCase() === "java" || segments[index + 2]?.toLowerCase() === "resources")
  );
  if (sourceIndex < 0) {
    return undefined;
  }
  const sourceSet = segments[sourceIndex + 1].toLowerCase() as "main" | "test";
  return {
    modulePath: segments.slice(0, sourceIndex).join("/"),
    sourceSet,
    sourceRoot: segments.slice(0, sourceIndex + 3).join("/")
  };
}
