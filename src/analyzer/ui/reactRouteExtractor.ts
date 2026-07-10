import { ReactScannedFile } from "./reactRepositoryScanner";

export interface ReactRouteRecord {
  route: string;
  pageComponent: string;
  file: string;
  confidence: "high" | "medium" | "low";
}

export class ReactRouteExtractor {
  extract(files: ReactScannedFile[]): ReactRouteRecord[] {
    const records: ReactRouteRecord[] = [];
    for (const file of files) {
      if (!["route", "component", "page"].includes(file.classification)) {
        continue;
      }

      for (const match of file.content.matchAll(/<Route[^>]*\bpath=["']([^"']+)["'][^>]*\belement=\{\s*<([A-Z][A-Za-z0-9_]*)/g)) {
        records.push({ route: match[1], pageComponent: match[2], file: file.file, confidence: "high" });
      }

      for (const match of file.content.matchAll(/\bpath\s*:\s*["']([^"']+)["'][\s\S]{0,160}?\belement\s*:\s*<([A-Z][A-Za-z0-9_]*)/g)) {
        records.push({ route: match[1], pageComponent: match[2], file: file.file, confidence: "medium" });
      }
    }

    return dedupe(records, (record) => `${record.route}|${record.pageComponent}|${record.file}`);
  }
}

function dedupe<T>(records: T[], keyFor: (record: T) => string): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = keyFor(record);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
