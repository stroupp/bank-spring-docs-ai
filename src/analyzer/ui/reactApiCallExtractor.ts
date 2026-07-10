import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";

export interface ReactApiCallRecord {
  clientFunction?: string;
  httpMethod: string;
  path: string;
  parameters: string[];
  file: string;
  usedBy: string[];
  confidence: "high" | "medium" | "low";
}

const axiosMethodPattern = /\b(?:axios|apiClient)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]([^)]*)\)/gi;
const fetchPattern = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]([\s\S]{0,240}?)\)/gi;
const callablePattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(|(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g;

export class ReactApiCallExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactApiCallRecord[] {
    const componentByFile = new Map<string, string[]>();
    for (const component of components) {
      componentByFile.set(component.file, [...(componentByFile.get(component.file) ?? []), component.component]);
    }

    const records: ReactApiCallRecord[] = [];
    for (const file of files) {
      const constants = extractStringConstants(file.content);
      const localComponents = componentByFile.get(file.file);

      for (const match of file.content.matchAll(axiosMethodPattern)) {
        const functionName = functionNameNear(file.content, match.index ?? 0);
        records.push({
          clientFunction: functionName,
          httpMethod: match[1].toUpperCase(),
          path: resolveTemplatePath(match[2], constants),
          parameters: extractParameterNames(match[3]),
          file: file.file,
          usedBy: localComponents ?? findApiConsumers(files, functionName),
          confidence: "medium"
        });
      }

      for (const match of file.content.matchAll(fetchPattern)) {
        const path = resolveTemplatePath(match[1], constants);
        if (/\$\{path\}|\{param\}/.test(match[1]) && match[1].includes("${path}")) {
          continue;
        }
        const functionName = functionNameNear(file.content, match.index ?? 0);
        records.push({
          clientFunction: functionName,
          httpMethod: extractFetchMethod(match[2]),
          path,
          parameters: extractParameterNames(match[2]),
          file: file.file,
          usedBy: localComponents ?? findApiConsumers(files, functionName),
          confidence: "medium"
        });
      }
    }

    return records;
  }
}

function functionNameNear(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const ignored = new Set(["if", "for", "while", "switch", "catch"]);
  let selected: string | undefined;
  for (const match of before.matchAll(callablePattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name && !ignored.has(name)) {
      selected = name;
    }
  }
  return selected;
}

function extractStringConstants(content: string): Record<string, string> {
  const constants: Record<string, string> = {};
  for (const match of content.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:[^?;\n]+\?\?\s*)?["'`]([^"'`]+)["'`]/g)) {
    constants[match[1]] = match[2];
  }
  return constants;
}

function resolveTemplatePath(rawPath: string, constants: Record<string, string>): string {
  return rawPath.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
    const key = expression.trim();
    return constants[key] ?? "{param}";
  });
}

function extractFetchMethod(options: string): string {
  return options.match(/\bmethod\s*:\s*["']([A-Za-z]+)["']/)?.[1]?.toUpperCase() ?? "GET";
}

function extractParameterNames(value: string): string[] {
  return [...new Set([...value.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)]
    .map((match) => match[1])
    .filter((word) => !["params", "data", "body", "headers", "method", "JSON", "stringify", "true", "false"].includes(word))
    .slice(0, 12))];
}

function findApiConsumers(files: ReactScannedFile[], functionName?: string): string[] {
  if (!functionName) {
    return [];
  }
  return files
    .filter((file) => file.classification === "page" || file.classification === "component")
    .filter((file) => new RegExp(`(?:\\.|\\b)${escapeRegex(functionName)}\\s*\\(`).test(file.content))
    .map((file) => file.file)
    .slice(0, 20);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
