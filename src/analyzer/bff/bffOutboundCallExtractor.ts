import { ScannedFile } from "../repositoryScanner";

export interface BffOutboundCall {
  client: string;
  method: string;
  httpMethod: string;
  targetPath: string;
  sourceEndpoint?: string;
  file: string;
  line?: number;
  confidence: "high" | "medium" | "low";
}

const mappingAnnotations: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE"
};

export class BffOutboundCallExtractor {
  extract(files: ScannedFile[]): BffOutboundCall[] {
    return files
      .filter((file) => file.kind === "java")
      .flatMap((file) => this.extractOne(file));
  }

  private extractOne(file: ScannedFile): BffOutboundCall[] {
    const className = file.content.match(/\b(?:class|interface)\s+([A-Za-z0-9_]+)/)?.[1] ?? "UnknownClient";
    const basePath = extractPathFromAnnotation(file.content.match(/@RequestMapping\s*(\([^)]*\))?[\s\r\n]+(?:public\s+)?class/)?.[1] ?? "") || "";
    const endpointRanges = endpointRangesFor(file.content, basePath);
    const records: BffOutboundCall[] = [];

    if (/@FeignClient\b/.test(file.content)) {
      for (const match of file.content.matchAll(/@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*(\([^)]*\))?[\s\r\n]+[A-Za-z0-9_<>,.?]+\s+([A-Za-z0-9_]+)\s*\(/g)) {
        records.push({
          client: className,
          method: match[3],
          httpMethod: mappingAnnotations[match[1]],
          targetPath: extractPath(match[2] ?? "") || "/",
          sourceEndpoint: sourceEndpointAt(endpointRanges, match.index ?? 0),
          file: file.file,
          line: lineNumberAt(file.content, match.index ?? 0),
          confidence: "high"
        });
      }
    }

    for (const match of file.content.matchAll(/\b(?:webClient|restClient)\s*\.[\s\S]{0,120}?\.(get|post|put|patch|delete)\s*\(\s*\)[\s\S]{0,180}?\.uri\s*\(\s*["']([^"']+)["']/gi)) {
      records.push({
        client: className,
        method: "inlineHttpCall",
        httpMethod: match[1].toUpperCase(),
        targetPath: normalizeTargetPath(match[2]),
        sourceEndpoint: sourceEndpointAt(endpointRanges, match.index ?? 0),
        file: file.file,
        line: lineNumberAt(file.content, match.index ?? 0),
        confidence: "medium"
      });
    }

    for (const call of extractRestTemplateCalls(file.content)) {
      records.push({
        client: className,
        method: call.method,
        httpMethod: call.httpMethod,
        targetPath: call.targetPath,
        sourceEndpoint: sourceEndpointAt(endpointRanges, call.index),
        file: file.file,
        line: call.line,
        confidence: call.confidence
      });
    }

    return dedupe(records);
  }
}

function extractPath(args: string): string {
  return args.match(/(?:value|path)?\s*=?\s*["']([^"']+)["']/)?.[1] ?? "";
}

function methodFromRestTemplate(method: string): string {
  if (method.toLowerCase().startsWith("post")) {
    return "POST";
  }
  if (method.toLowerCase() === "exchange") {
    return "REQUEST";
  }
  return "GET";
}

interface RestTemplateCall {
  method: string;
  httpMethod: string;
  targetPath: string;
  index: number;
  line: number;
  confidence: "high" | "medium" | "low";
}

function extractRestTemplateCalls(content: string): RestTemplateCall[] {
  const records: RestTemplateCall[] = [];
  const pattern = /\brestTemplate\.(getForObject|getForEntity|postForObject|postForEntity|put|delete|exchange)\s*\(/gi;
  for (const match of content.matchAll(pattern)) {
    const method = match[1];
    const start = match.index ?? 0;
    const args = readCallArguments(content, start + match[0].length - 1);
    if (!args) {
      continue;
    }

    const targetPath = extractTargetPathFromExpression(args);
    if (!targetPath) {
      continue;
    }

    records.push({
      method,
      httpMethod: method.toLowerCase() === "exchange" ? methodFromExchangeArgs(args) : methodFromRestTemplate(method),
      targetPath,
      index: start,
      line: lineNumberAt(content, start),
      confidence: targetPath.includes("{param}") ? "low" : "medium"
    });
  }
  return records;
}

function readCallArguments(content: string, openParenIndex: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openParenIndex; index < content.length; index += 1) {
    const char = content[index];
    const previous = content[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openParenIndex + 1, index);
      }
    }
  }
  return undefined;
}

function extractTargetPathFromExpression(args: string): string | undefined {
  const firstArg = splitTopLevelArgs(args)[0] ?? args;
  const stringParts = [...firstArg.matchAll(/["']([^"']+)["']/g)].map((part) => part[1]);
  const pathPart = stringParts.find((part) => part.startsWith("/")) ?? stringParts[0];
  return pathPart ? normalizeTargetPath(pathPart) : undefined;
}

interface EndpointRange {
  start: number;
  end: number;
  endpoint: string;
}

function endpointRangesFor(content: string, basePath: string): EndpointRange[] {
  const ranges: EndpointRange[] = [];
  const pattern = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(\([^)]*\))?/g;
  for (const match of content.matchAll(pattern)) {
    const annotation = match[1];
    const annotationEnd = (match.index ?? 0) + match[0].length;
    const openBrace = content.indexOf("{", annotationEnd);
    if (openBrace === -1 || openBrace - annotationEnd > 1200) {
      continue;
    }
    const signature = content.slice(annotationEnd, openBrace);
    if (/\b(class|interface|enum)\b/.test(signature)) {
      continue;
    }
    const end = matchingBraceIndex(content, openBrace);
    if (end === undefined) {
      continue;
    }
    const method = annotation === "RequestMapping" ? requestMappingMethod(match[2] ?? "") : mappingAnnotations[annotation];
    const methodPath = extractPathFromAnnotation(match[2] ?? "");
    ranges.push({
      start: openBrace,
      end,
      endpoint: `${method} ${joinPaths(basePath, methodPath)}`
    });
  }
  return ranges;
}

function sourceEndpointAt(ranges: EndpointRange[], index: number): string | undefined {
  return ranges.find((range) => index >= range.start && index <= range.end)?.endpoint;
}

function matchingBraceIndex(content: string, openBraceIndex: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    const previous = content[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function extractPathFromAnnotation(args: string): string {
  return args.match(/(?:value|path)?\s*=?\s*["']([^"']+)["']/)?.[1] ?? "";
}

function requestMappingMethod(args: string): string {
  return args.match(/method\s*=\s*RequestMethod\.([A-Z]+)/)?.[1] ?? "REQUEST";
}

function joinPaths(basePath: string, methodPath: string): string {
  const combined = `/${basePath}/${methodPath}`.replace(/\/+/g, "/");
  return combined.length > 1 ? combined.replace(/\/$/, "") : combined;
}

function methodFromExchangeArgs(args: string): string {
  return args.match(/\bHttpMethod\.([A-Z]+)/)?.[1] ?? "REQUEST";
}

function splitTopLevelArgs(args: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    const previous = args[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "<" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === ">" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      result.push(args.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(args.slice(start).trim());
  return result;
}

function normalizeTargetPath(value: string): string {
  const withoutQuery = value.trim();
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function dedupe(records: BffOutboundCall[]): BffOutboundCall[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.client}|${record.method}|${record.httpMethod}|${record.targetPath}|${record.file}|${record.line ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
