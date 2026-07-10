import { ScannedFile } from "./repositoryScanner";
import { extractAnnotationPath } from "./springComponentExtractor";

export interface ApiEndpoint {
  httpMethod: string;
  path: string;
  className: string;
  handlerMethod: string;
  requestBody?: string;
  responseType?: string;
  pathVariables: string[];
  requestParams: string[];
  parameters: ApiParameter[];
  file: string;
}

export interface ApiParameter {
  name: string;
  type: string;
  source: "path" | "query" | "header" | "body" | "request" | "unknown";
  required?: boolean;
  defaultValue?: string;
  raw: string;
}

const mappingMethods: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE"
};

export class SpringEndpointExtractor {
  extract(files: ScannedFile[]): ApiEndpoint[] {
    return files
      .filter((file) => file.kind === "java" && file.classification === "controller")
      .flatMap((file) => this.extractOne(file));
  }

  private extractOne(file: ScannedFile): ApiEndpoint[] {
    const content = file.content;
    const className = content.match(/\b(?:class|interface)\s+([A-Za-z0-9_]+)/)?.[1] ?? "";
    const basePath = extractAnnotationPath(content, "RequestMapping") ?? "";
    const endpoints: ApiEndpoint[] = [];
    const mappingRegex = /@(?<annotation>GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?<args>\((?:[^()]|\([^()]*\))*\))?/g;

    for (const match of content.matchAll(mappingRegex)) {
      const groups = match.groups;
      if (!groups) {
        continue;
      }
      const annotation = groups.annotation;
      const args = groups.args ?? "";
      const signature = this.findMethodSignature(content.slice((match.index ?? 0) + match[0].length));
      if (!signature) {
        continue;
      }

      const httpMethod = annotation === "RequestMapping" ? this.requestMappingMethod(args) : mappingMethods[annotation];
      const parameters = parseParameters(signature.params);
      endpoints.push({
        httpMethod,
        path: joinPaths(basePath, this.pathFromArgs(args)),
        className,
        handlerMethod: signature.methodName,
        requestBody: parameters.find((parameter) => parameter.source === "body")?.type,
        responseType: signature.returnType,
        pathVariables: parameters.filter((parameter) => parameter.source === "path").map((parameter) => parameter.name),
        requestParams: parameters.filter((parameter) => parameter.source === "query").map((parameter) => parameter.name),
        parameters,
        file: file.file
      });
    }
    return endpoints;
  }

  private findMethodSignature(afterMapping: string): { returnType?: string; methodName: string; params: string } | undefined {
    const signatureRegex =
      /^\s*(?:@[A-Za-z0-9_.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?<returnType>[A-Za-z0-9_<>,.? \[\]]+?)\s+(?<methodName>[A-Za-z0-9_]+)\s*\((?<params>(?:[^()]|\([^()]*\))*)\)/s;
    const match = afterMapping.match(signatureRegex);
    if (!match?.groups) {
      return undefined;
    }
    return {
      returnType: normalizeWhitespace(match.groups.returnType),
      methodName: match.groups.methodName,
      params: match.groups.params
    };
  }

  private pathFromArgs(args: string): string {
    return args.match(/(?:value|path)\s*=\s*\{\s*["']([^"']+)["']/)?.[1] ?? args.match(/(?:value|path)?\s*=?\s*["']([^"']+)["']/)?.[1] ?? "";
  }

  private requestMappingMethod(args: string): string {
    return args.match(/method\s*=\s*(?:\{\s*)?RequestMethod\.([A-Z]+)/)?.[1] ?? "REQUEST";
  }
}

function joinPaths(basePath: string, methodPath: string): string {
  const combined = `/${basePath}/${methodPath}`.replace(/\/+/g, "/");
  return combined.length > 1 ? combined.replace(/\/$/, "") : combined;
}

function parseParameters(params: string): ApiParameter[] {
  return splitTopLevel(params)
    .map((param) => parseParameter(param))
    .filter((param): param is ApiParameter => Boolean(param));
}

function parseParameter(rawParam: string): ApiParameter | undefined {
  const raw = normalizeWhitespace(rawParam);
  if (!raw) {
    return undefined;
  }

  const source = parameterSource(raw);
  const annotationName = annotationValue(raw, source);
  const required = parseRequired(raw);
  const defaultValue = raw.match(/defaultValue\s*=\s*["']([^"']+)["']/)?.[1];
  const withoutAnnotations = normalizeWhitespace(raw.replace(/@[A-Za-z0-9_.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?/g, "").replace(/\bfinal\s+/g, ""));
  const pieces = withoutAnnotations.split(/\s+/).filter(Boolean);
  if (!pieces.length) {
    return undefined;
  }

  const variableName = pieces[pieces.length - 1].replace(/\.\.\.$/, "");
  const type = pieces.slice(0, -1).join(" ") || "unknown";
  const name = annotationName || variableName;
  return {
    name,
    type,
    source,
    ...(required === undefined ? {} : { required }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    raw
  };
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let parenDepth = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  for (const char of value) {
    if (char === "(") {
      parenDepth++;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "<") {
      angleDepth++;
    } else if (char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (char === "{") {
      braceDepth++;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }

    if (char === "," && parenDepth === 0 && angleDepth === 0 && braceDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

function parameterSource(raw: string): ApiParameter["source"] {
  if (/@PathVariable\b/.test(raw)) {
    return "path";
  }
  if (/@RequestParam\b/.test(raw)) {
    return "query";
  }
  if (/@RequestHeader\b/.test(raw)) {
    return "header";
  }
  if (/@RequestBody\b/.test(raw)) {
    return "body";
  }
  if (/(HttpServletRequest|ServletRequest|Principal|Authentication|Pageable)\b/.test(raw)) {
    return "request";
  }
  return "unknown";
}

function annotationValue(raw: string, source: ApiParameter["source"]): string | undefined {
  const annotation = sourceAnnotation(source);
  if (!annotation) {
    return undefined;
  }
  const args = raw.match(new RegExp(`@${annotation}\\s*\\(([^)]*)\\)`))?.[1];
  if (!args) {
    return undefined;
  }
  return (
    args.match(/(?:value|name)\s*=\s*["']([^"']+)["']/)?.[1] ??
    args.match(/^\s*["']([^"']+)["']\s*$/)?.[1]
  );
}

function sourceAnnotation(source: ApiParameter["source"]): string | undefined {
  switch (source) {
    case "path":
      return "PathVariable";
    case "query":
      return "RequestParam";
    case "header":
      return "RequestHeader";
    case "body":
      return "RequestBody";
    default:
      return undefined;
  }
}

function parseRequired(raw: string): boolean | undefined {
  const match = raw.match(/required\s*=\s*(true|false)/);
  return match ? match[1] === "true" : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
