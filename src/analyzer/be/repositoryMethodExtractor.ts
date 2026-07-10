import { ScannedFile } from "../repositoryScanner";

export interface RepositoryMethodRecord {
  repository: string;
  method: string;
  entity?: string;
  query?: string;
  file: string;
  confidence: "high" | "medium";
}

export class RepositoryMethodExtractor {
  extract(files: ScannedFile[]): RepositoryMethodRecord[] {
    return files
      .filter((file) => file.kind === "java" && file.classification === "repository")
      .flatMap((file) => this.extractOne(file));
  }

  private extractOne(file: ScannedFile): RepositoryMethodRecord[] {
    const repository = file.content.match(/\b(?:interface|class)\s+([A-Za-z0-9_]+)/)?.[1] ?? "UnknownRepository";
    const entity = file.content.match(/extends\s+(?:JpaRepository|CrudRepository|PagingAndSortingRepository)\s*<\s*([A-Za-z0-9_]+)/)?.[1];
    const records: RepositoryMethodRecord[] = [];

    for (const match of file.content.matchAll(/@Query\s*\(\s*["']([^"']+)["'][\s\S]{0,160}?\b([A-Za-z0-9_<>,.?]+)\s+([A-Za-z0-9_]+)\s*\(/g)) {
      records.push({ repository, method: match[3], entity, query: match[1], file: file.file, confidence: "high" });
    }
    for (const match of file.content.matchAll(/\b(?:List<[^>]+>|Optional<[^>]+>|boolean|Boolean|long|Long|int|Integer|void|[A-Za-z0-9_]+)\s+((?:find|exists|delete|count|read|get)By[A-Za-z0-9_]+)\s*\(/g)) {
      records.push({ repository, method: match[1], entity, file: file.file, confidence: "medium" });
    }

    return records;
  }
}
