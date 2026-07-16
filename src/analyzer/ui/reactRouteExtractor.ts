import { ReactScannedFile } from "./reactRepositoryScanner";
import { findJsxOpeningTags, jsxAttributeExpression, literalJsxAttribute, readBalancedSource, splitTopLevel } from "./reactSourceUtils";

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

      for (const tag of findJsxOpeningTags(file.content, new Set(["Route"]))) {
        const route = literalJsxAttribute(tag.attributes, "path");
        const element = jsxAttributeExpression(tag.attributes, "element");
        const pageComponent = element ? pageComponentFromElement(element) : undefined;
        if (route && pageComponent) {
          records.push({ route, pageComponent, file: file.file, confidence: "high" });
        }
      }

      for (const object of routeObjects(file.content)) {
        const properties = splitTopLevel(object);
        const route = properties.map((property) => property.match(/^\s*path\s*:\s*["'`]([^"'`]+)["'`]/)?.[1]).find(Boolean);
        const element = properties.find((property) => /^\s*(?:element|component)\s*:/.test(property));
        const pageComponent = element ? pageComponentFromElement(element.replace(/^\s*(?:element|component)\s*:\s*/, "")) : undefined;
        if (route && pageComponent) {
          records.push({ route, pageComponent, file: file.file, confidence: "medium" });
        }
      }
    }

    return dedupe(records, (record) => `${record.route}|${record.pageComponent}|${record.file}`);
  }
}

function pageComponentFromElement(element: string): string | undefined {
  const explicitComponent = [...element.matchAll(/\b(?:component|page)\s*=\s*\{\s*([A-Z][A-Za-z0-9_]*)\s*\}/g)]
    .map((match) => match[1]);
  const jsxComponents = [...element.matchAll(/<([A-Z][A-Za-z0-9_.]*)\b/g)]
    .map((match) => match[1].split(".").pop() ?? match[1])
    .filter((name) => !["Fragment"].includes(name));

  // Route elements are commonly wrapped by guards, layouts, providers, or Suspense.
  // The last JSX component is the rendered leaf and therefore the page named by the route.
  return [...explicitComponent, ...jsxComponents].pop();
}

function routeObjects(source: string): string[] {
  const objects: string[] = [];
  const seen = new Set<number>();
  for (const match of source.matchAll(/\bpath\s*:\s*["'`][^"'`]+["'`]/g)) {
    const matchIndex = match.index ?? 0;
    let selected: { content: string; start: number } | undefined;
    for (let start = source.lastIndexOf("{", matchIndex); start >= 0; start = source.lastIndexOf("{", start - 1)) {
      const candidate = readBalancedSource(source, start, "{", "}");
      if (candidate && candidate.end > matchIndex) {
        selected = { content: candidate.content, start };
        break;
      }
    }
    if (selected && !seen.has(selected.start) && /\b(?:element|component)\s*:/.test(selected.content)) {
      seen.add(selected.start);
      objects.push(selected.content);
    }
  }
  return objects;
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
