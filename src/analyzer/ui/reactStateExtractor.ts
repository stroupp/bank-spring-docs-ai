import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";

export interface ReactStateRecord {
  component: string;
  stateName: string;
  setter: string;
  initialValue: string;
  file: string;
}

export class ReactStateExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactStateRecord[] {
    const componentByFile = new Map<string, ReactComponentRecord | undefined>();
    for (const file of files) {
      const fileComponents = components.filter((component) => component.file === file.file);
      componentByFile.set(file.file, fileComponents.find((component) => component.classification === "page") ?? fileComponents[0]);
    }

    const records: ReactStateRecord[] = [];
    for (const file of files) {
      const owner = componentByFile.get(file.file);
      if (!owner) {
        continue;
      }
      for (const match of file.content.matchAll(/const\s*\[\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*\]\s*=\s*useState(?:<[^>]+>)?\s*\(([^)]*)\)/g)) {
        records.push({
          component: owner.component,
          stateName: match[1],
          setter: match[2],
          initialValue: match[3].trim() || "undefined",
          file: file.file
        });
      }
    }
    return records;
  }
}
