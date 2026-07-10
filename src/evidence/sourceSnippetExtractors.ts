import * as fs from "fs/promises";
import * as path from "path";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";

type JsonRecord = Record<string, unknown>;

export interface EvidenceSnippet {
  group: EvidenceSnippetGroup;
  file: string;
  symbolName: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  code: string;
}

export type EvidenceSnippetGroup =
  | "React Page Evidence"
  | "React Interaction Evidence"
  | "React API Client Evidence"
  | "BFF Endpoint Evidence"
  | "BFF Service / Outbound Client Evidence"
  | "Backend Endpoint Evidence"
  | "Backend Service Evidence"
  | "Repository / Entity Evidence";

export interface EvidenceSnippetResult {
  snippets: EvidenceSnippet[];
  uncertainties: string[];
}

export async function buildPageEvidenceSnippets(
  manifest: MultiRepoManifest,
  pageFlow: Record<string, unknown>,
  maxSnippetCharacters: number
): Promise<EvidenceSnippetResult> {
  const snippets: EvidenceSnippet[] = [];
  const uncertainties: string[] = [];
  snippets.push(...await reactHandlerSnippetExtractor(manifest.repos.ui.localPath, pageFlow, maxSnippetCharacters, uncertainties));
  snippets.push(...await reactApiClientSnippetExtractor(manifest.repos.ui.localPath, pageFlow, maxSnippetCharacters, uncertainties));
  snippets.push(...await javaControllerMethodSnippetExtractor(manifest.repos.bff.localPath, pageFlow, "bff", maxSnippetCharacters, uncertainties));
  snippets.push(...await javaServiceMethodSnippetExtractor(manifest.repos.bff.localPath, pageFlow, "bff", maxSnippetCharacters, uncertainties));
  snippets.push(...await javaControllerMethodSnippetExtractor(manifest.repos.be.localPath, pageFlow, "be", maxSnippetCharacters, uncertainties));
  snippets.push(...await javaServiceMethodSnippetExtractor(manifest.repos.be.localPath, pageFlow, "be", maxSnippetCharacters, uncertainties));
  snippets.push(...await javaRepositoryMethodSnippetExtractor(manifest.repos.be.localPath, pageFlow, maxSnippetCharacters, uncertainties));
  return { snippets: dedupeSnippets(snippets), uncertainties: unique(uncertainties) };
}

export async function reactHandlerSnippetExtractor(
  repoRoot: string,
  pageFlow: Record<string, unknown>,
  maxSnippetCharacters: number,
  uncertainties: string[]
): Promise<EvidenceSnippet[]> {
  const result: EvidenceSnippet[] = [];
  const selectedPage = asRecord(pageFlow.selectedPage);
  const componentNames = unique([
    String(selectedPage.pageName ?? ""),
    ...asRecords(pageFlow.components).map((item) => String(item.component ?? item.page ?? ""))
  ].filter(Boolean));

  for (const component of asRecords(pageFlow.components)) {
    const file = String(component.file ?? "");
    if (!file) {
      continue;
    }
    const content = await readRepoFile(repoRoot, file);
    if (!content) {
      uncertainties.push(`React component snippet not found because file is unreadable: ${file}`);
      continue;
    }
    const componentName = String(component.component ?? selectedPage.pageName ?? path.basename(file));
    const block = extractReactDeclaration(content, componentName);
    if (block) {
      result.push(snippet("React Page Evidence", file, componentName, "Selected React page/component declaration.", "high", block, maxSnippetCharacters));
    } else {
      uncertainties.push(`Exact React component declaration was not found for ${componentName} in ${file}.`);
    }
  }

  for (const interaction of asRecords(pageFlow.interactions)) {
    const file = String(interaction.file ?? "");
    const handler = cleanHandlerName(String(interaction.handler ?? ""));
    if (!file || !handler) {
      continue;
    }
    const content = await readRepoFile(repoRoot, file);
    if (!content) {
      uncertainties.push(`React interaction snippet not found because file is unreadable: ${file}`);
      continue;
    }
    const blocks = [
      extractReactDeclaration(content, handler),
      extractJsxElementForHandler(content, String(interaction.event ?? ""), handler),
      ...componentNames.map((name) => extractNearbyStateAndImports(content, name, handler)).filter((value): value is string => Boolean(value))
    ].filter((value): value is string => Boolean(value));
    if (blocks.length) {
      result.push(snippet("React Interaction Evidence", file, handler, `Interaction ${interaction.event ?? "event"} uses handler ${handler}.`, confidence(interaction), blocks.join("\n\n...\n\n"), maxSnippetCharacters));
    } else {
      uncertainties.push(`Exact React handler snippet was not found for ${handler} in ${file}.`);
    }
  }
  return result;
}

export async function reactApiClientSnippetExtractor(
  repoRoot: string,
  pageFlow: Record<string, unknown>,
  maxSnippetCharacters: number,
  uncertainties: string[]
): Promise<EvidenceSnippet[]> {
  const result: EvidenceSnippet[] = [];
  for (const apiCall of asRecords(pageFlow.uiApiCalls)) {
    const file = String(apiCall.file ?? "");
    const symbol = String(apiCall.clientFunction ?? "");
    if (!file) {
      continue;
    }
    const content = await readRepoFile(repoRoot, file);
    if (!content) {
      uncertainties.push(`React API client snippet not found because file is unreadable: ${file}`);
      continue;
    }
    const blocks = [
      symbol ? extractReactDeclaration(content, symbol) : undefined,
      extractApiCallWindow(content, String(apiCall.path ?? ""), String(apiCall.httpMethod ?? ""))
    ].filter((value): value is string => Boolean(value));
    if (blocks.length) {
      result.push(snippet("React API Client Evidence", file, symbol || `${apiCall.httpMethod ?? "GET"} ${apiCall.path ?? ""}`, "UI API call/client function matched from page flow.", confidence(apiCall), blocks.join("\n\n...\n\n"), maxSnippetCharacters));
    } else {
      uncertainties.push(`Exact React API client snippet was not found for ${apiCall.httpMethod ?? ""} ${apiCall.path ?? ""} in ${file}.`);
    }
  }
  return result;
}

export async function javaControllerMethodSnippetExtractor(
  repoRoot: string,
  pageFlow: Record<string, unknown>,
  layer: "bff" | "be",
  maxSnippetCharacters: number,
  uncertainties: string[]
): Promise<EvidenceSnippet[]> {
  const endpoints = asRecords(layer === "bff" ? pageFlow.bffEndpoints : pageFlow.beEndpoints);
  const group = layer === "bff" ? "BFF Endpoint Evidence" : "Backend Endpoint Evidence";
  const result: EvidenceSnippet[] = [];
  for (const endpoint of endpoints) {
    const file = String(endpoint.file ?? "");
    const handler = String(endpoint.handlerMethod ?? "");
    if (!file || !handler) {
      continue;
    }
    const content = await readRepoFile(repoRoot, file);
    const block = content ? extractJavaMethod(content, handler, true) : undefined;
    if (block) {
      result.push(snippet(group, file, `${endpoint.className ?? "Controller"}.${handler}`, `${endpoint.httpMethod ?? ""} ${endpoint.path ?? ""} endpoint method.`, confidence(endpoint), block, maxSnippetCharacters));
    } else {
      uncertainties.push(`Exact ${layer.toUpperCase()} controller method snippet was not found for ${handler} in ${file}.`);
    }
  }
  return result;
}

export async function javaServiceMethodSnippetExtractor(
  repoRoot: string,
  pageFlow: Record<string, unknown>,
  layer: "bff" | "be",
  maxSnippetCharacters: number,
  uncertainties: string[]
): Promise<EvidenceSnippet[]> {
  const flows = asRecords(layer === "bff" ? pageFlow.bffServiceFlows : pageFlow.beServiceFlows);
  const components = asRecords(layer === "bff" ? pageFlow.bffComponents : pageFlow.beComponents);
  const result: EvidenceSnippet[] = [];
  for (const flow of flows) {
    const componentNames = [
      ...asStringArray(flow.candidateServices),
      ...asStringArray(flow.candidateClients)
    ];
    const methodNames = unique([
      String(flow.handler ?? ""),
      ...asStringArray(flow.methodCalls).map(extractMethodNameFromFlowText),
      ...asStringArray(flow.outboundCalls).map(extractMethodNameFromFlowText)
    ].filter(Boolean));
    for (const componentName of componentNames) {
      const component = components.find((item) => sameName(String(item.className ?? ""), componentName));
      const file = String(component?.file ?? "");
      if (!file) {
        uncertainties.push(`Service/outbound component file not visible for ${componentName}.`);
        continue;
      }
      const content = await readRepoFile(repoRoot, file);
      if (!content) {
        uncertainties.push(`Service/outbound snippet not found because file is unreadable: ${file}`);
        continue;
      }
      const blocks = methodNames.map((method) => extractJavaMethod(content, method, false)).filter((value): value is string => Boolean(value));
      if (blocks.length) {
        const symbolName = `${componentName}.${methodNames.slice(0, Math.max(1, blocks.length)).join("|")}`;
        result.push(snippet(layer === "bff" ? "BFF Service / Outbound Client Evidence" : "Backend Service Evidence", file, symbolName, `Service/client flow evidence for ${flow.endpoint ?? "endpoint"}.`, confidence(flow), blocks.join("\n\n...\n\n"), maxSnippetCharacters));
      } else {
        uncertainties.push(`Exact service/client method snippet was not found for ${componentName} in ${file}.`);
      }
    }
  }
  return result;
}

export async function javaRepositoryMethodSnippetExtractor(
  repoRoot: string,
  pageFlow: Record<string, unknown>,
  maxSnippetCharacters: number,
  uncertainties: string[]
): Promise<EvidenceSnippet[]> {
  const result: EvidenceSnippet[] = [];
  for (const record of [...asRecords(pageFlow.repositories), ...asRecords(pageFlow.entities), ...asRecords(pageFlow.beDtos), ...asRecords(pageFlow.beValidations)]) {
    const file = String(record.file ?? "");
    if (!file) {
      continue;
    }
    const content = await readRepoFile(repoRoot, file);
    if (!content) {
      uncertainties.push(`Repository/entity/DTO snippet not found because file is unreadable: ${file}`);
      continue;
    }
    const method = String(record.method ?? "");
    const block = method ? extractJavaMethod(content, method, true) : extractJavaClassBlock(content, String(record.entity ?? record.className ?? ""));
    if (block) {
      result.push(snippet("Repository / Entity Evidence", file, String(record.method ?? record.entity ?? record.className ?? path.basename(file)), "Repository/entity/DTO evidence matched from backend flow.", confidence(record), block, maxSnippetCharacters));
    } else {
      uncertainties.push(`Exact repository/entity/DTO snippet was not found in ${file}.`);
    }
  }
  return result;
}

function extractJavaMethod(content: string, methodName: string, includeAnnotations: boolean): string | undefined {
  if (!methodName) {
    return undefined;
  }
  const methodPattern = new RegExp(`(?:^\\s*(?:@[A-Za-z0-9_.]+(?:\\s*\\((?:[^()]|\\([^()]*\\))*\\))?\\s*)*)^\\s*(?:(?:public|private|protected)\\s+)?(?:static\\s+)?[A-Za-z0-9_<>,.? \\[\\]]+\\s+${escapeRegex(methodName)}\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?:throws\\s+[A-Za-z0-9_,\\s]+)?\\s*(?:\\{|;)`, "gm");
  const match = methodPattern.exec(content);
  if (!match) {
    return undefined;
  }
  const imports = relevantImports(content);
  const className = content.match(/\b(?:class|interface|record)\s+([A-Za-z0-9_]+)/)?.[1] ?? "UnknownClass";
  const start = includeAnnotations ? annotationStart(content, match.index) : match.index;
  if (match[0].trim().endsWith(";")) {
    return [`// class ${className}`, imports, content.slice(start, methodPattern.lastIndex)].filter(Boolean).join("\n");
  }
  const openBrace = content.indexOf("{", match.index);
  const end = findMatchingBrace(content, openBrace);
  if (end <= openBrace) {
    return undefined;
  }
  return [`// class ${className}`, imports, content.slice(start, end + 1)].filter(Boolean).join("\n");
}

function extractJavaClassBlock(content: string, className: string): string | undefined {
  const imports = relevantImports(content);
  const pattern = className
    ? new RegExp(`(?:^\\s*(?:@[A-Za-z0-9_.]+(?:\\([^)]*\\))?\\s*)*)^\\s*(?:(?:public|private|protected)\\s+)?(?:class|interface|record|enum)\\s+${escapeRegex(className)}\\b`, "gm")
    : /(?:^\s*(?:@[A-Za-z0-9_.]+(?:\([^)]*\))?\s*)*)^\s*(?:(?:public|private|protected)\s+)?(?:class|interface|record|enum)\s+[A-Za-z0-9_]+\b/gm;
  const match = pattern.exec(content);
  if (!match) {
    return undefined;
  }
  const openBrace = content.indexOf("{", match.index);
  const end = findMatchingBrace(content, openBrace);
  if (end <= openBrace) {
    return undefined;
  }
  return [imports, content.slice(annotationStart(content, match.index), end + 1)].filter(Boolean).join("\n");
}

function extractReactDeclaration(content: string, symbol: string): string | undefined {
  if (!symbol) {
    return undefined;
  }
  const patterns = [
    new RegExp(`(?:export\\s+default\\s+)?(?:export\\s+)?function\\s+${escapeRegex(symbol)}\\s*\\([^)]*\\)\\s*\\{`, "g"),
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(symbol)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, "g"),
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(symbol)}\\s*\\([^)]*\\)\\s*\\{`, "g")
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match) {
      continue;
    }
    const openBrace = content.indexOf("{", match.index);
    const end = findMatchingBrace(content, openBrace);
    if (end > openBrace) {
      return `${reactImportsFor(content, symbol)}\n${content.slice(match.index, end + 1)}`.trim();
    }
  }
  const expression = extractExpressionArrowDeclaration(content, symbol);
  if (expression) {
    return `${reactImportsFor(content, symbol)}\n${expression}`.trim();
  }
  return undefined;
}

function extractExpressionArrowDeclaration(content: string, symbol: string): string | undefined {
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(symbol)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_][A-Za-z0-9_]*)\\s*=>\\s*`, "g");
  const match = pattern.exec(content);
  if (!match) {
    return undefined;
  }
  const start = match.index;
  const expressionStart = pattern.lastIndex;
  const end = findExpressionEnd(content, expressionStart);
  return content.slice(start, end).trim();
}

function findExpressionEnd(content: string, start: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | undefined;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    const previous = content[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if ((char === ";" || char === "\n") && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return char === ";" ? index + 1 : index;
    }
  }
  return content.length;
}

function extractJsxElementForHandler(content: string, event: string, handler: string): string | undefined {
  const eventName = event || "onSubmit|onClick|onChange";
  const pattern = new RegExp(`<[A-Za-z][A-Za-z0-9.]*\\b[\\s\\S]{0,700}\\b(?:${eventName})=\\{[^}]*${escapeRegex(handler)}[^}]*\\}[\\s\\S]{0,700}?(?:/>|</[A-Za-z][A-Za-z0-9.]*>)`, "m");
  return content.match(pattern)?.[0];
}

function extractApiCallWindow(content: string, apiPath: string, method: string): string | undefined {
  const markers = [apiPath, apiPath.replace(/^\/api/, ""), method.toLowerCase()].filter(Boolean);
  const index = markers.map((marker) => content.toLowerCase().indexOf(marker.toLowerCase())).find((value) => value !== -1);
  if (index === undefined) {
    return undefined;
  }
  return content.slice(Math.max(0, index - 700), Math.min(content.length, index + 1200));
}

function extractNearbyStateAndImports(content: string, componentName: string, handler: string): string | undefined {
  const imports = reactImportsFor(content, handler);
  const stateLines = content.split(/\r?\n/).filter((line) => /\b(useState|useForm|Controller|register)\b/.test(line)).slice(0, 20).join("\n");
  return [imports, `// component/handler context: ${componentName}.${handler}`, stateLines].filter(Boolean).join("\n") || undefined;
}

function snippet(group: EvidenceSnippetGroup, file: string, symbolName: string, reason: string, confidenceValue: "high" | "medium" | "low", code: string, maxSnippetCharacters: number): EvidenceSnippet {
  return {
    group,
    file,
    symbolName,
    reason,
    confidence: confidenceValue,
    code: code.length <= maxSnippetCharacters ? code : `${code.slice(0, maxSnippetCharacters)}\n[SNIPPET_TRUNCATED]`
  };
}

function relevantImports(content: string): string {
  return [...content.matchAll(/^import\s+[^;]+;/gm)]
    .map((match) => match[0])
    .filter((line) => /(springframework|validation|data|Pageable|ResponseEntity|Repository|Service|Controller|Entity)/i.test(line))
    .slice(0, 30)
    .join("\n");
}

function reactImportsFor(content: string, symbol: string): string {
  return [...content.matchAll(/^import\s+.+;?$/gm)]
    .map((match) => match[0])
    .filter((line) => /react|axios|api|client|service|hook|form/i.test(line) || line.includes(symbol))
    .slice(0, 20)
    .join("\n");
}

function annotationStart(content: string, start: number): number {
  const before = content.slice(Math.max(0, start - 1000), start);
  const match = [...before.matchAll(/^\s*@[A-Za-z0-9_.]+/gm)].at(-1);
  return match?.index === undefined ? start : Math.max(0, start - 1000) + match.index;
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

async function readRepoFile(repoRoot: string, relativePath: string): Promise<string> {
  const fullPath = path.resolve(repoRoot, normalizeFile(relativePath));
  if (!isWithin(repoRoot, fullPath)) {
    return "";
  }
  try {
    return await fs.readFile(fullPath, "utf8");
  } catch {
    return "";
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cleanHandlerName(value: string): string {
  return value.replace(/^\(?\s*.*?\)?\s*=>\s*/, "").replace(/\(.*\)$/, "").replace(/[{}]/g, "").trim();
}

function extractMethodNameFromFlowText(value: string): string {
  const viaMatch = value.match(/\bvia\s+[A-Za-z0-9_$.]+\.([A-Za-z0-9_]+)\b/i);
  if (viaMatch) {
    return viaMatch[1];
  }
  const arrowTarget = value.split("->").at(-1)?.trim() ?? value;
  return arrowTarget.split(".").at(-1)?.replace(/\(.*/, "").trim() ?? "";
}

function confidence(record: JsonRecord): "high" | "medium" | "low" {
  const value = String(record.confidence ?? "medium");
  return value === "high" || value === "low" ? value : "medium";
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : value ? [String(value)] : [];
}

function sameName(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeFile(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^["'`(]+|["'`),.:;]+$/g, "").replace(/^\/+/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeSnippets(snippets: EvidenceSnippet[]): EvidenceSnippet[] {
  const seen = new Set<string>();
  const result: EvidenceSnippet[] = [];
  for (const item of snippets) {
    const key = `${item.group}:${item.file}:${item.symbolName}:${item.code.slice(0, 80)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
