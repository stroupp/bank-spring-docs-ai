import { ScannedFile } from "../repositoryScanner";

export interface ValidationRecord {
  className: string;
  fieldOrParameter: string;
  annotation: string;
  file: string;
}

const validationAnnotations = ["Valid", "NotNull", "NotBlank", "NotEmpty", "Size", "Min", "Max", "Pattern", "Email"];

export class ValidationExtractor {
  extract(files: ScannedFile[]): ValidationRecord[] {
    return files
      .filter((file) => file.kind === "java")
      .flatMap((file) => {
        const className = file.content.match(/\b(?:class|record)\s+([A-Za-z0-9_]+)/)?.[1] ?? "UnknownClass";
        const records: ValidationRecord[] = [];
        for (const annotation of validationAnnotations) {
          const pattern = new RegExp(`@${annotation}(?:\\([^)]*\\))?[\\s\\r\\n]+(?:private|public|protected)?\\s*(?:final\\s+)?[A-Za-z0-9_<>,.?]+\\s+([A-Za-z0-9_]+)`, "g");
          for (const match of file.content.matchAll(pattern)) {
            records.push({ className, fieldOrParameter: match[1], annotation, file: file.file });
          }
        }
        return records;
      });
  }
}
