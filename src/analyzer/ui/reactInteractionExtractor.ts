import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";

export interface ReactInteractionRecord {
  page?: string;
  component: string;
  elementType: string;
  label: string;
  event: string;
  handler: string;
  file: string;
  confidence: "high" | "medium" | "low";
}

export class ReactInteractionExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactInteractionRecord[] {
    const componentByFile = new Map<string, ReactComponentRecord[]>();
    for (const component of components) {
      componentByFile.set(component.file, [...(componentByFile.get(component.file) ?? []), component]);
    }

    const records: ReactInteractionRecord[] = [];
    for (const file of files) {
      const fileComponents = componentByFile.get(file.file) ?? [];
      const owner = fileComponents.find((component) => component.classification === "page") ?? fileComponents[0];
      if (!owner) {
        continue;
      }

      const elementPattern = /<([A-Za-z][A-Za-z0-9.]*)\b[^>]*\b(onClick|onSubmit|onChange)=\{([^}]+)\}[^>]*>([\s\S]{0,120}?)<\/\1>/g;
      for (const match of file.content.matchAll(elementPattern)) {
        records.push({
          page: owner.classification === "page" ? owner.component : undefined,
          component: owner.component,
          elementType: match[1],
          label: cleanLabel(match[4]),
          event: match[2],
          handler: match[3].trim(),
          file: file.file,
          confidence: "medium"
        });
      }

      for (const match of file.content.matchAll(/<form\b[^>]*\bonSubmit=\{([^}]+)\}/g)) {
        records.push({
          page: owner.classification === "page" ? owner.component : undefined,
          component: owner.component,
          elementType: "form",
          label: "form submit",
          event: "onSubmit",
          handler: match[1].trim(),
          file: file.file,
          confidence: "medium"
        });
      }
    }
    return records;
  }
}

function cleanLabel(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\{[^}]+\}/g, " ").replace(/\s+/g, " ").trim() || "Not visible";
}
