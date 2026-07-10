import { ScannedFile } from "../repositoryScanner";

export interface BffDtoRecord {
  className: string;
  packageName: string;
  file: string;
  fields: string[];
  reason: string;
}

export class BffDtoExtractor {
  extract(files: ScannedFile[]): BffDtoRecord[] {
    return files
      .filter((file) => file.kind === "java")
      .map((file) => this.extractOne(file))
      .filter((record): record is BffDtoRecord => Boolean(record));
  }

  private extractOne(file: ScannedFile): BffDtoRecord | undefined {
    const className = file.content.match(/\b(?:class|record)\s+([A-Za-z0-9_]+)/)?.[1];
    if (!className) {
      return undefined;
    }
    const pathReason = /dto|model|request|response|command|query/i.test(file.file);
    const nameReason = /(Request|Response|Dto|DTO|Command|Query)$/i.test(className);
    if (!pathReason && !nameReason) {
      return undefined;
    }

    return {
      className,
      packageName: file.content.match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/)?.[1] ?? "",
      file: file.file,
      fields: [...file.content.matchAll(/(?:private|public|protected)\s+(?:final\s+)?([A-Za-z0-9_<>,.?]+)\s+([A-Za-z0-9_]+)\s*;/g)].map((match) => `${match[2]}: ${match[1]}`),
      reason: nameReason ? "class name suffix" : "package/path convention"
    };
  }
}
