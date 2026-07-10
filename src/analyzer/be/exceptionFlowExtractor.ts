import { ScannedFile } from "../repositoryScanner";

export interface ExceptionFlowRecord {
  className: string;
  type: "throw" | "handler" | "advice" | "exception-class";
  detail: string;
  file: string;
}

export class ExceptionFlowExtractor {
  extract(files: ScannedFile[]): ExceptionFlowRecord[] {
    return files
      .filter((file) => file.kind === "java")
      .flatMap((file) => {
        const className = file.content.match(/\b(?:class|record)\s+([A-Za-z0-9_]+)/)?.[1] ?? "UnknownClass";
        const records: ExceptionFlowRecord[] = [];
        if (/@ControllerAdvice\b/.test(file.content)) {
          records.push({ className, type: "advice", detail: "@ControllerAdvice", file: file.file });
        }
        if (/(?:extends\s+RuntimeException|extends\s+Exception)/.test(file.content)) {
          records.push({ className, type: "exception-class", detail: className, file: file.file });
        }
        for (const match of file.content.matchAll(/@ExceptionHandler\s*(?:\(([^)]*)\))?/g)) {
          records.push({ className, type: "handler", detail: match[1] || "@ExceptionHandler", file: file.file });
        }
        for (const match of file.content.matchAll(/throw\s+new\s+([A-Za-z0-9_]+)/g)) {
          records.push({ className, type: "throw", detail: match[1], file: file.file });
        }
        return records;
      });
  }
}
