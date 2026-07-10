import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";

export interface ReactFormFieldRecord {
  page?: string;
  fieldName: string;
  component: string;
  source: string;
  file: string;
}

export class ReactFormFieldExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactFormFieldRecord[] {
    const ownerByFile = new Map<string, ReactComponentRecord | undefined>();
    for (const file of files) {
      const fileComponents = components.filter((component) => component.file === file.file);
      ownerByFile.set(file.file, fileComponents.find((component) => component.classification === "page") ?? fileComponents[0]);
    }

    const records: ReactFormFieldRecord[] = [];
    for (const file of files) {
      const owner = ownerByFile.get(file.file);
      if (!owner) {
        continue;
      }
      for (const match of file.content.matchAll(/<([A-Za-z][A-Za-z0-9.]*)\b[^>]*\bname=["']([^"']+)["']/g)) {
        records.push({
          page: owner.classification === "page" ? owner.component : undefined,
          fieldName: match[2],
          component: match[1],
          source: "name attribute",
          file: file.file
        });
      }
      for (const match of file.content.matchAll(/<Controller\b[^>]*\bname=["']([^"']+)["']/g)) {
        records.push({
          page: owner.classification === "page" ? owner.component : undefined,
          fieldName: match[1],
          component: "Controller",
          source: "react-hook-form Controller name",
          file: file.file
        });
      }
    }
    return records;
  }
}
