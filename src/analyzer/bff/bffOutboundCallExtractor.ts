import { ScannedFile } from "../repositoryScanner";

export interface BffOutboundCall {
  client: string;
  method: string;
  sourceMethod?: string;
  httpMethod: string;
  targetPath: string;
  sourceEndpoint?: string;
  sourceController?: string;
  sourceHandler?: string;
  headers?: string[];
  bodyExpression?: string;
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
    const methodRanges = methodRangesFor(file.content);
    const records: BffOutboundCall[] = [];

    if (/@FeignClient\b/.test(file.content)) {
      for (const match of file.content.matchAll(/@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*(\([^)]*\))?[\s\r\n]+[A-Za-z0-9_<>,.?]+\s+([A-Za-z0-9_]+)\s*\(/g)) {
        records.push({
          client: className,
          method: match[3],
          sourceMethod: match[3],
          httpMethod: mappingAnnotations[match[1]],
          targetPath: extractPath(match[2] ?? "") || "/",
          sourceEndpoint: sourceEndpointAt(endpointRanges, match.index ?? 0),
          file: file.file,
          line: lineNumberAt(file.content, match.index ?? 0),
          confidence: "high"
        });
      }
    }

    for (const call of extractFluentHttpCalls(file.content)) {
      const sourceMethod = sourceMethodAt(methodRanges, call.index);
      const sourceEndpoint = sourceEndpointAt(endpointRanges, call.index);
      records.push({
        client: className,
        method: sourceMethod ?? call.operation,
        ...(sourceMethod ? { sourceMethod } : {}),
        httpMethod: call.httpMethod,
        targetPath: call.targetPath,
        ...(sourceEndpoint ? { sourceEndpoint, sourceController: className, sourceHandler: sourceMethod } : {}),
        ...(call.headers.length ? { headers: call.headers } : {}),
        ...(call.bodyExpression ? { bodyExpression: call.bodyExpression } : {}),
        file: file.file,
        line: lineNumberAt(file.content, call.index),
        confidence: "high"
      });
    }

    for (const call of extractRestTemplateCalls(file.content)) {
      const sourceMethod = sourceMethodAt(methodRanges, call.index);
      const sourceEndpoint = sourceEndpointAt(endpointRanges, call.index);
      records.push({
        client: className,
        method: call.method,
        ...(sourceMethod ? { sourceMethod } : {}),
        httpMethod: call.httpMethod,
        targetPath: call.targetPath,
        ...(sourceEndpoint ? { sourceEndpoint, sourceController: className, sourceHandler: sourceMethod } : {}),
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
  const normalized = method.toLowerCase();
  if (normalized.startsWith("post")) {
    return "POST";
  }
  if (normalized === "put") {
    return "PUT";
  }
  if (normalized === "delete") {
    return "DELETE";
  }
  if (normalized === "exchange") {
    return "REQUEST";
  }
  return "GET";
}

interface FluentHttpCall {
  operation: string;
  httpMethod: string;
  targetPath: string;
  headers: string[];
  bodyExpression?: string;
  index: number;
}

function extractFluentHttpCalls(content: string): FluentHttpCall[] {
  const receivers = httpClientReceivers(content);
  const records: FluentHttpCall[] = [];
  const pattern = /\b(?:this\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(get|post|put|patch|delete|method)\s*\(/gi;
  for (const match of content.matchAll(pattern)) {
    const receiver = match[1];
    if (!receivers.has(receiver.toLowerCase())) {
      continue;
    }
    const start = match.index ?? 0;
    const openParen = start + match[0].lastIndexOf("(");
    const methodArgs = readCallArguments(content, openParen);
    if (methodArgs === undefined) {
      continue;
    }
    const operation = match[2].toLowerCase();
    const httpMethod = operation === "method"
      ? methodArgs.match(/\bHttpMethod\.([A-Z]+)/)?.[1]
      : operation.toUpperCase();
    if (!httpMethod) {
      continue;
    }

    const chain = readFluentChain(content, start);
    const uriArgs = callArgumentsFor(chain, "uri");
    if (uriArgs === undefined) {
      continue;
    }
    const targetPath = extractUriTargetPath(uriArgs, content.slice(0, start));
    if (!targetPath) {
      continue;
    }
    const requestMetadata = extractRequestMetadata(chain);
    records.push({
      operation,
      httpMethod,
      targetPath,
      headers: requestMetadata.headers,
      ...(requestMetadata.bodyExpression ? { bodyExpression: requestMetadata.bodyExpression } : {}),
      index: start
    });
  }
  return records;
}

function httpClientReceivers(content: string): Set<string> {
  const result = new Set(["restclient", "webclient"]);
  for (const match of content.matchAll(/\b(?:RestClient|WebClient)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    result.add(match[1].toLowerCase());
  }
  return result;
}

function readFluentChain(content: string, start: number): string {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: string | undefined;
  const limit = Math.min(content.length, start + 12000);
  for (let index = start; index < limit; index += 1) {
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
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        return content.slice(start, index);
      }
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === ";" && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      return content.slice(start, index + 1);
    }
  }
  return content.slice(start, limit);
}

function callArgumentsFor(value: string, method: string): string | undefined {
  const match = new RegExp(`\\.\\s*${method}\\s*\\(`).exec(value);
  if (!match) {
    return undefined;
  }
  return readCallArguments(value, match.index + match[0].lastIndexOf("("));
}

function extractUriTargetPath(args: string, precedingContent: string): string | undefined {
  const builderPath = extractUriBuilderPath(args);
  if (builderPath) {
    return normalizeTargetPath(builderPath);
  }

  const directPath = extractTargetPathFromExpression(splitTopLevelArgs(args)[0] ?? args);
  if (directPath) {
    return directPath;
  }

  const variable = (splitTopLevelArgs(args)[0] ?? "").trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  if (!variable) {
    return undefined;
  }
  const assignmentPattern = new RegExp(`\\b${variable}\\s*=\\s*([\\s\\S]{1,1600}?);`, "g");
  let resolved: string | undefined;
  for (const assignment of precedingContent.matchAll(assignmentPattern)) {
    const expression = assignment[1];
    resolved = extractUriBuilderPath(expression) ?? extractTargetPathFromExpression(expression) ?? resolved;
  }
  return resolved ? normalizeTargetPath(resolved) : undefined;
}

function extractUriBuilderPath(value: string): string | undefined {
  if (!/=>|\.(?:path|replacePath|pathSegment)\s*\(/.test(value)) {
    return undefined;
  }
  let result = "";
  const pattern = /\.(path|replacePath|pathSegment)\s*\(/g;
  for (const match of value.matchAll(pattern)) {
    const args = readCallArguments(value, (match.index ?? 0) + match[0].lastIndexOf("("));
    if (args === undefined) {
      continue;
    }
    if (match[1] === "pathSegment") {
      const segments = [...args.matchAll(/["']([^"']+)["']/g)].map((part) => part[1]).filter(Boolean);
      if (segments.length) {
        result = joinTargetPaths(result, segments.join("/"));
      }
      continue;
    }
    const path = extractTargetPathFromExpression(args);
    if (!path) {
      continue;
    }
    result = match[1] === "replacePath" ? path : joinTargetPaths(result, path);
  }
  return result || undefined;
}

function joinTargetPaths(left: string, right: string): string {
  const combined = `/${left}/${right}`.replace(/\/+/g, "/");
  return combined.length > 1 ? combined.replace(/\/$/, "") : combined;
}

function extractRequestMetadata(chain: string): { headers: string[]; bodyExpression?: string } {
  const terminalIndexes = [chain.search(/\.\s*retrieve\s*\(/), chain.search(/\.\s*exchange\s*\(/)].filter((index) => index >= 0);
  const requestPart = terminalIndexes.length ? chain.slice(0, Math.min(...terminalIndexes)) : chain;
  const headers: string[] = [];
  for (const method of ["header", "headers"]) {
    const pattern = new RegExp(`\\.\\s*${method}\\s*\\(`, "g");
    for (const match of requestPart.matchAll(pattern)) {
      const args = readCallArguments(requestPart, (match.index ?? 0) + match[0].lastIndexOf("("));
      if (!args) {
        continue;
      }
      if (method === "header") {
        const name = args.match(/["']([^"']+)["']/)?.[1];
        if (name) {
          headers.push(name);
        }
        continue;
      }
      const nestedNames = [...args.matchAll(/\.\s*(?:set|add|setIfAbsent)\s*\(\s*["']([^"']+)["']/g)].map((nested) => nested[1]);
      headers.push(...nestedNames);
      if (/\.\s*setBearerAuth\s*\(/.test(args)) {
        headers.push("Authorization");
      }
      if (!nestedNames.length) {
        const name = args.match(/["']([^"']+)["']/)?.[1];
        if (name) {
          headers.push(name);
        }
      }
    }
  }
  if (/\.\s*contentType\s*\(/.test(requestPart)) {
    headers.push("Content-Type");
  }
  if (/\.\s*accept\s*\(/.test(requestPart)) {
    headers.push("Accept");
  }

  const bodyArgs = callArgumentsFor(requestPart, "body") ?? callArgumentsFor(requestPart, "bodyValue");
  const bodyExpression = bodyArgs === undefined ? undefined : compactExpression(splitTopLevelArgs(bodyArgs)[0] ?? bodyArgs);
  return {
    headers: [...new Set(headers)],
    ...(bodyExpression ? { bodyExpression } : {})
  };
}

function compactExpression(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
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

interface MethodRange {
  start: number;
  end: number;
  method: string;
}

function methodRangesFor(content: string): MethodRange[] {
  const ranges: MethodRange[] = [];
  const pattern = /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?[A-Za-z_][A-Za-z0-9_<>,.? \[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:throws\s+[A-Za-z0-9_.,\s]+)?\s*\{/g;
  for (const match of content.matchAll(pattern)) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    const end = matchingBraceIndex(content, openBrace);
    if (end !== undefined) {
      ranges.push({ start: openBrace, end, method: match[1] });
    }
  }
  return ranges;
}

function sourceMethodAt(ranges: MethodRange[], index: number): string | undefined {
  return ranges
    .filter((range) => index >= range.start && index <= range.end)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0]?.method;
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
  let path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      // Preserve the literal for conservative normalization below.
    }
  }
  path = path.replace(/^\$\{[^}]+\}(?=\/)/, "");
  return path.startsWith("/") ? path : `/${path}`;
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
