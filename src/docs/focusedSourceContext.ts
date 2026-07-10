import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl } from "../storage/jsonlWriter";

export interface FocusedSourceIndex {
  indexPath: string;
  maxRecords?: number;
  filter?: (record: Record<string, unknown>) => boolean;
}

export interface FocusedSourceContextInput {
  repoRoot: string;
  indexes: FocusedSourceIndex[];
  previousArtifacts?: string[];
  maxFileCharacters: number;
  maxTotalCharacters: number;
}

export interface FocusedSourceContextResult {
  content: string;
  files: string[];
}

const sourcePathPattern = /(?:[A-Za-z]:)?[A-Za-z0-9_./\\ -]+\.(?:java|kt|ts|tsx|js|jsx|properties|ya?ml|xml|json)/g;

export async function buildFocusedSourceContext(input: FocusedSourceContextInput): Promise<FocusedSourceContextResult> {
  const files = new Set<string>();
  for (const index of input.indexes) {
    const records = await readIndexRecords(index.indexPath);
    for (const record of records.slice(0, index.maxRecords ?? 80)) {
      if (index.filter && !index.filter(record)) {
        continue;
      }
      collectRecordFiles(record, files);
    }
  }

  for (const artifact of input.previousArtifacts ?? []) {
    for (const match of artifact.matchAll(sourcePathPattern)) {
      const normalized = normalizeRelativePath(match[0]);
      if (normalized) {
        files.add(normalized);
      }
    }
  }

  return sourceContextFromFiles(input.repoRoot, [...files], input.maxFileCharacters, input.maxTotalCharacters);
}

export async function sourceContextFromFiles(
  repoRoot: string,
  files: string[],
  maxFileCharacters: number,
  maxTotalCharacters: number
): Promise<FocusedSourceContextResult> {
  const chunks: string[] = [];
  const included: string[] = [];
  let used = 0;
  for (const file of dedupe(files.map(normalizeRelativePath).filter((value): value is string => Boolean(value)))) {
    const fullPath = path.resolve(repoRoot, file);
    if (!isWithin(repoRoot, fullPath)) {
      continue;
    }
    const content = await readText(fullPath, file, maxFileCharacters);
    if (!content) {
      continue;
    }
    const chunk = `### ${file}\n\`\`\`\n${content}\n\`\`\``;
    if (used + chunk.length > maxTotalCharacters) {
      break;
    }
    chunks.push(chunk);
    included.push(file);
    used += chunk.length;
  }
  return { content: chunks.join("\n\n"), files: included };
}

async function readIndexRecords(indexPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    return await readJsonl<Record<string, unknown>>(indexPath);
  } catch {
    return [];
  }
}

function collectRecordFiles(value: unknown, files: Set<string>): void {
  if (!value) {
    return;
  }
  if (typeof value === "string") {
    const normalized = normalizeRelativePath(value);
    if (normalized && /\.(java|kt|ts|tsx|js|jsx|properties|ya?ml|xml|json)$/i.test(normalized)) {
      files.add(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecordFiles(item, files));
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["file", "sourceFile", "targetFile", "callerFile", "calleeFile", "componentFile", "pageFile", "routeFile"]) {
      collectRecordFiles(record[key], files);
    }
  }
}

function normalizeRelativePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^["'`(]+|["'`),.:;]+$/g, "");
  if (!trimmed || /^[a-z]+:\/\//i.test(trimmed)) {
    return undefined;
  }
  const srcIndex = trimmed.search(/(?:^|[\\/])src[\\/]/i);
  const relative = srcIndex > 0 ? trimmed.slice(srcIndex + 1) : trimmed;
  return relative.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readText(filePath: string, relativePath: string, maxCharacters: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return selectFocusedSnippet(relativePath, content, maxCharacters);
  } catch {
    return "";
  }
}

function selectFocusedSnippet(relativePath: string, content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }

  const structuredBlocks = buildFocusedBlocks(relativePath, content);
  if (structuredBlocks.length) {
    const structured = renderBlocks(relativePath, content, mergeBlocks(structuredBlocks), maxCharacters);
    if (structured) {
      return structured;
    }
  }

  const windows = buildFocusedLineWindows(relativePath, content);
  if (windows.length === 0) {
    return `${content.slice(0, maxCharacters)}\n[FILE_TRUNCATED_TO_FIRST_${maxCharacters}_CHARS]`;
  }

  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  let used = 0;
  for (const window of mergeWindows(windows)) {
    const body = lines.slice(window.start, window.end + 1).join("\n");
    const chunk = `[lines ${window.start + 1}-${window.end + 1}]\n${body}`;
    if (used + chunk.length > maxCharacters) {
      break;
    }
    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.length
    ? `Focused snippets from ${relativePath}; unrelated code omitted.\n\n${chunks.join("\n\n...\n\n")}`
    : `${content.slice(0, maxCharacters)}\n[FILE_TRUNCATED_TO_FIRST_${maxCharacters}_CHARS]`;
}

function buildFocusedBlocks(relativePath: string, content: string): Array<{ start: number; end: number }> {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".java" || extension === ".kt") {
    return javaFocusedBlocks(content);
  }
  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx") {
    return reactFocusedBlocks(content);
  }
  return [];
}

function javaFocusedBlocks(content: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const methodOrClass = /(?:^\s*(?:@[A-Za-z0-9_.]+(?:\([^)]*\))?\s*)*)^\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:class|interface|record|enum|[A-Za-z0-9_<>,.? \[\]]+\s+[A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^;{}]*\))?\s*(?:throws\s+[A-Za-z0-9_,\s]+)?\s*\{/gm;
  for (const match of content.matchAll(methodOrClass)) {
    const text = match[0];
    if (!/(RestController|Controller|Service|Repository|Entity|Component|Mapping|public|private|protected|class|record)/.test(text)) {
      continue;
    }
    const openBrace = (match.index ?? 0) + text.length - 1;
    const end = findMatchingBrace(content, openBrace);
    if (end > openBrace) {
      blocks.push({ start: Math.max(0, annotationStart(content, match.index ?? 0)), end: end + 1 });
    }
  }
  return blocks;
}

function reactFocusedBlocks(content: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const declarations = /(?:export\s+default\s+)?(?:export\s+)?(?:async\s+)?function\s+[A-Z_a-z][A-Za-z0-9_]*\s*\([^)]*\)\s*\{|(?:export\s+)?const\s+[A-Z_a-z][A-Za-z0-9_]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  for (const match of content.matchAll(declarations)) {
    const name = match[0];
    if (!/(use[A-Z]|handle[A-Z]|onSubmit|onClick|onChange|fetch|api|return\s*\(|[A-Z][A-Za-z0-9_])/.test(name + content.slice(match.index ?? 0, (match.index ?? 0) + 800))) {
      continue;
    }
    const openBrace = content.indexOf("{", match.index ?? 0);
    const end = findMatchingBrace(content, openBrace);
    if (end > openBrace) {
      blocks.push({ start: match.index ?? 0, end: end + 1 });
    }
  }
  return blocks;
}

function renderBlocks(relativePath: string, content: string, blocks: Array<{ start: number; end: number }>, maxCharacters: number): string {
  const lineStarts = collectLineStarts(content);
  const chunks: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const snippet = content.slice(block.start, block.end);
    const startLine = lineForOffset(lineStarts, block.start);
    const endLine = lineForOffset(lineStarts, block.end);
    const chunk = `[lines ${startLine}-${endLine}]\n${snippet}`;
    if (chunk.length > maxCharacters) {
      continue;
    }
    if (used + chunk.length > maxCharacters) {
      break;
    }
    chunks.push(chunk);
    used += chunk.length;
  }
  return chunks.length
    ? `Focused method/component snippets from ${relativePath}; unrelated code omitted.\n\n${chunks.join("\n\n...\n\n")}`
    : "";
}

function mergeBlocks(blocks: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = blocks.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (last && block.start <= last.end + 2) {
      last.end = Math.max(last.end, block.end);
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

function annotationStart(content: string, start: number): number {
  const before = content.slice(Math.max(0, start - 800), start);
  const match = [...before.matchAll(/^\s*@[A-Za-z0-9_.]+/gm)].at(-1);
  return match?.index === undefined ? start : Math.max(0, start - 800) + match.index;
}

function findMatchingBrace(content: string, openBrace: number): number {
  if (openBrace < 0) {
    return -1;
  }
  let depth = 0;
  for (let index = openBrace; index < content.length; index++) {
    if (content[index] === "{") {
      depth++;
    } else if (content[index] === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function collectLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(1, high + 1);
}

function buildFocusedLineWindows(relativePath: string, content: string): Array<{ start: number; end: number }> {
  const lines = content.split(/\r?\n/);
  const extension = path.extname(relativePath).toLowerCase();
  const patterns = patternsForExtension(extension);
  const windows: Array<{ start: number; end: number }> = [];

  lines.forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) {
      windows.push({
        start: Math.max(0, index - 8),
        end: Math.min(lines.length - 1, index + 18)
      });
    }
  });

  return windows;
}

function patternsForExtension(extension: string): RegExp[] {
  if (extension === ".java" || extension === ".kt") {
    return [
      /@(RestController|Controller|Service|Repository|Entity|Component)\b/,
      /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/,
      /\b(ResponseEntity|RestTemplate|WebClient|FeignClient)\b/,
      /\b(public|private|protected)\s+[\w<>, ?[\]]+\s+\w+\s*\(/,
      /@(Column|Id|ManyToOne|OneToMany|OneToOne|ManyToMany|JoinColumn)\b/
    ];
  }
  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx") {
    return [
      /\b(export\s+default|export\s+function|function\s+\w+)\b/,
      /\bconst\s+\w+\s*=\s*(async\s*)?\(/,
      /\b(useEffect|useMemo|useCallback|useState|useReducer)\b/,
      /\b(fetch|axios|apiClient)\s*(\.|\()/,
      /\b(onSubmit|onClick|onChange|handle\w+)\b/,
      /\breturn\s*\(/
    ];
  }
  return [];
}

function mergeWindows(windows: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = windows.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + 3) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)].sort();
}
