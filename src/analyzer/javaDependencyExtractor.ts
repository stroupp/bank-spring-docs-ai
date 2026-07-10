import { ScannedFile } from "./repositoryScanner";

export interface DependencyEdge {
  from: string;
  to: string;
  relation: string;
  file: string;
}

export class JavaDependencyExtractor {
  extract(files: ScannedFile[]): DependencyEdge[] {
    return files.filter((file) => file.kind === "java").flatMap((file) => {
      const from = file.content.match(/\b(?:class|interface)\s+([A-Za-z0-9_]+)/)?.[1];
      if (!from) {
        return [];
      }
      return [...file.content.matchAll(/\bimport\s+([A-Za-z0-9_.]+)\s*;/g)].map((match) => ({
        from,
        to: match[1].split(".").at(-1) ?? match[1],
        relation: "class_imports_class",
        file: file.file
      }));
    });
  }
}
