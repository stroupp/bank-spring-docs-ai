import * as fs from "fs/promises";
import * as path from "path";
import { classifyJavaFile, JavaFileType } from "./javaFileClassifier";
import { relativePosix } from "../utils/pathUtils";

export interface ScannedFile {
  file: string;
  absolutePath: string;
  extension: string;
  kind: "java" | "build" | "config";
  classification?: JavaFileType;
  size: number;
  content: string;
}

const ignoredFolders = new Set([".git", ".idea", ".vscode", ".ai-docs", "node_modules", "target", "build", "dist", "out", ".gradle"]);
const configNames = new Set(["application.yml", "application.yaml", "application.properties", "bootstrap.yml", "bootstrap.properties"]);

export class RepositoryScanner {
  async scan(repoRoot: string): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    await this.walk(repoRoot, repoRoot, files);
    return files;
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

  private async walk(repoRoot: string, currentDir: string, files: ScannedFile[]): Promise<void> {
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
      const extension = path.extname(entry.name);
      const kind = this.kindFor(relative);
      files.push({
        file: relative,
        absolutePath,
        extension,
        kind,
        classification: kind === "java" ? classifyJavaFile(relative, content) : undefined,
        size: buffer.length,
        content
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
      normalized.startsWith("src/main/java/") && normalized.endsWith(".java") ||
      normalized.startsWith("src/test/java/") && normalized.endsWith(".java") ||
      normalized.startsWith("src/main/resources/") && configNames.has(name)
    );
  }

  private kindFor(relative: string): "java" | "build" | "config" {
    const name = path.posix.basename(relative.toLowerCase());
    if (relative.endsWith(".java")) {
      return "java";
    }
    if (configNames.has(name)) {
      return "config";
    }
    return "build";
  }
}
