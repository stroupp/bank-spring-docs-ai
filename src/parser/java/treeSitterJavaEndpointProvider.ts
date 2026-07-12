import Parser = require("tree-sitter");
import Java = require("tree-sitter-java");
import { ApiParameter } from "../../analyzer/springEndpointExtractor";
import { ParserProviderDiagnostics, ParserProviderWarning } from "../parserProviderTypes";
import {
  JavaParserProvider,
  ParsedJavaEndpoint,
  ParsedJavaModel,
  ParsedJavaParameter,
  ParsedJavaRepositoryMethod,
  ParsedJavaServiceMethod,
  ParsedSourceRange
} from "./javaParserProviderTypes";
import { RegexJavaParserProvider } from "./regexJavaParserProvider";

type AnnotationValue = {
  name: string;
  text: string;
  positional: string[];
  named: Map<string, string[]>;
};

const fixedMappings: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE"
};

const validationNames = new Set([
  "Valid", "Validated", "NotNull", "NotBlank", "NotEmpty", "Size", "Min", "Max", "Positive", "PositiveOrZero",
  "Negative", "NegativeOrZero", "Email", "Pattern", "Past", "PastOrPresent", "Future", "FutureOrPresent", "AssertTrue", "AssertFalse"
]);
const securityNames = new Set(["PreAuthorize", "PostAuthorize", "Secured", "RolesAllowed"]);

/**
 * Experimental controller-only provider. It is intentionally not registered as
 * the production default; unsupported capabilities delegate to the proven regex
 * provider while the AST spike is evaluated.
 */
export class TreeSitterJavaEndpointProvider implements JavaParserProvider {
  readonly identity = {
    name: "tree-sitter-java",
    version: "0.23.5",
    language: "java" as const,
    strategy: "ast" as const
  };

  private readonly parser: Parser;
  private readonly fallback = new RegexJavaParserProvider();
  private runtimeWarnings: ParserProviderWarning[] = [];

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Java);
  }

  parseControllerEndpoints(filePath: string, source: string): ParsedJavaEndpoint[] {
    this.runtimeWarnings = [];
    try {
      const tree = this.parser.parse(source);
      const endpoints = this.extractControllers(filePath, tree.rootNode);
      const regexEndpoints = this.fallback.parseControllerEndpoints(filePath, source);

      if (!endpoints.length && regexEndpoints.length) {
        return this.withFallbackMetadata(regexEndpoints, "AST endpoint çıkaramadı; regex sonucu kullanıldı.");
      }
      const astKeys = new Set(endpoints.map(endpointKey));
      const regexKeys = new Set(regexEndpoints.map(endpointKey));
      const astOnly = [...astKeys].filter((key) => !regexKeys.has(key)).length;
      const regexOnly = [...regexKeys].filter((key) => !astKeys.has(key)).length;
      if (astOnly || regexOnly) {
        this.runtimeWarnings.push({
          code: "AST_REGEX_DIVERGENCE",
          capability: "controller-endpoints",
          message: `AST/regex endpoint farkı algılandı (AST-only: ${astOnly}, regex-only: ${regexOnly}); sonuç AST olarak korundu.`
        });
      }
      if (tree.rootNode.hasError) {
        this.runtimeWarnings.push({
          code: "AST_RECOVERED_PARSE",
          capability: "controller-endpoints",
          message: "Java kaynak ağacında sözdizimi hatası bulundu; Tree-sitter kurtarma düğümleriyle devam edildi."
        });
        return endpoints.map((endpoint) => ({ ...endpoint, confidence: "medium" }));
      }
      return endpoints;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.withFallbackMetadata(this.fallback.parseControllerEndpoints(filePath, source), `AST ayrıştırma hatası: ${reason}`);
    }
  }

  parseDtoOrEntity(filePath: string, source: string): ParsedJavaModel[] {
    return this.fallback.parseDtoOrEntity(filePath, source);
  }

  parseServiceMethods(filePath: string, source: string): ParsedJavaServiceMethod[] {
    return this.fallback.parseServiceMethods(filePath, source);
  }

  parseRepositoryMethods(filePath: string, source: string): ParsedJavaRepositoryMethod[] {
    return this.fallback.parseRepositoryMethods(filePath, source);
  }

  diagnostics(): ParserProviderDiagnostics {
    return {
      ...this.identity,
      capabilities: ["controller-endpoints", "dto-entity-models (regex fallback)", "service-method-calls (regex fallback)", "repository-methods (regex fallback)"],
      confidence: this.runtimeWarnings.length ? "medium" : "high",
      warnings: [
        {
          code: "AST_SPIKE_ONLY",
          capability: "controller-endpoints",
          message: "Bu sağlayıcı deneysel karşılaştırma içindir ve üretim parser registry varsayılanı değildir."
        },
        {
          code: "REGEX_CAPABILITY_FALLBACK",
          capability: "dto-entity-models,service-method-calls,repository-methods",
          message: "Controller endpoint dışındaki Java yetenekleri mevcut regex sağlayıcısına devredilir."
        },
        ...this.runtimeWarnings
      ]
    };
  }

  private extractControllers(filePath: string, root: Parser.SyntaxNode): ParsedJavaEndpoint[] {
    const endpoints: ParsedJavaEndpoint[] = [];
    for (const classNode of root.descendantsOfType("class_declaration")) {
      const classAnnotations = annotationsOf(modifiersOf(classNode));
      if (!classAnnotations.some((annotation) => annotation.name === "RestController" || annotation.name === "Controller")) {
        continue;
      }
      const className = classNode.childForFieldName("name")?.text ?? "";
      const basePaths = mappingPaths(classAnnotations.find((annotation) => annotation.name === "RequestMapping"));
      const classValidation = namesMatching(classAnnotations, validationNames);
      const classSecurity = namesMatching(classAnnotations, securityNames);
      const body = classNode.childForFieldName("body");
      if (!body) {
        continue;
      }

      for (const methodNode of body.namedChildren.filter((node) => node.type === "method_declaration")) {
        const methodAnnotations = annotationsOf(modifiersOf(methodNode));
        const mappings = methodAnnotations.filter((annotation) => annotation.name in fixedMappings || annotation.name === "RequestMapping");
        if (!mappings.length) {
          continue;
        }
        const handlerMethod = methodNode.childForFieldName("name")?.text ?? "";
        const responseType = methodNode.childForFieldName("type")?.text;
        const parameters = parseParameters(methodNode.childForFieldName("parameters"));
        const methodValidation = namesMatching(methodAnnotations, validationNames);
        const securityAnnotations = namesMatching(methodAnnotations, securityNames);

        for (const mapping of mappings) {
          const methods = httpMethods(mapping);
          const methodPaths = mappingPaths(mapping);
          const allPaths = combinePaths(basePaths, methodPaths);
          for (const httpMethod of methods) {
            for (const path of allPaths) {
              endpoints.push({
                httpMethod,
                path,
                className,
                handlerMethod,
                requestBody: parameters.find((parameter) => parameter.source === "body")?.type,
                ...(responseType ? { responseType } : {}),
                pathVariables: parameters.filter((parameter) => parameter.source === "path").map((parameter) => parameter.name),
                requestParams: parameters.filter((parameter) => parameter.source === "query").map((parameter) => parameter.name),
                parameters,
                file: filePath.replace(/\\/g, "/"),
                parser: this.identity.name,
                parserVersion: this.identity.version,
                confidence: "high",
                annotations: methodAnnotations.map((annotation) => annotation.name),
                validationAnnotations: unique([...classValidation, ...methodValidation, ...parameters.flatMap((parameter) => parameter.validationAnnotations ?? [])]),
                securityAnnotations: unique([...classSecurity, ...securityAnnotations]),
                mappingPaths: allPaths,
                sourceRange: rangeOf(methodNode)
              });
            }
          }
        }
      }
    }
    return endpoints;
  }

  private withFallbackMetadata(endpoints: ParsedJavaEndpoint[], reason: string): ParsedJavaEndpoint[] {
    this.runtimeWarnings.push({ code: "AST_REGEX_FALLBACK", capability: "controller-endpoints", message: reason });
    return endpoints.map((endpoint) => ({
      ...endpoint,
      parser: this.fallback.identity.name,
      parserVersion: this.fallback.identity.version,
      confidence: "medium",
      fallbackReason: reason
    }));
  }
}

function annotationsOf(modifiers: Parser.SyntaxNode | null): AnnotationValue[] {
  if (!modifiers) {
    return [];
  }
  return modifiers.namedChildren
    .filter((node) => node.type === "annotation" || node.type === "marker_annotation")
    .map(parseAnnotation);
}

function parseAnnotation(node: Parser.SyntaxNode): AnnotationValue {
  const name = node.childForFieldName("name")?.text.split(".").pop() ?? "";
  const positional: string[] = [];
  const named = new Map<string, string[]>();
  const argumentsNode = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "annotation_argument_list") ?? null;
  for (const child of argumentsNode?.namedChildren ?? []) {
    if (child.type === "element_value_pair") {
      const key = child.childForFieldName("key")?.text ?? "";
      const value = child.childForFieldName("value");
      named.set(key, literalValues(value));
    } else {
      positional.push(...literalValues(child));
    }
  }
  return { name, text: node.text, positional, named };
}

function literalValues(node: Parser.SyntaxNode | null): string[] {
  if (!node) {
    return [];
  }
  if (node.type === "string_literal" || node.type === "character_literal") {
    return [stripQuotes(node.text)];
  }
  if (node.type === "true" || node.type === "false" || node.type === "identifier" || node.type === "field_access") {
    return [node.text];
  }
  const values = node.namedChildren.flatMap((child) => literalValues(child));
  return values.length ? values : [node.text];
}

function mappingPaths(annotation?: AnnotationValue): string[] {
  if (!annotation) {
    return [""];
  }
  const paths = annotation.named.get("path") ?? annotation.named.get("value") ?? annotation.positional;
  return paths.length ? unique(paths) : [""];
}

function httpMethods(annotation: AnnotationValue): string[] {
  if (annotation.name in fixedMappings) {
    return [fixedMappings[annotation.name]];
  }
  const configured = annotation.named.get("method") ?? [];
  const methods = configured
    .map((value) => value.match(/RequestMethod\.([A-Z]+)/)?.[1])
    .filter((value): value is string => Boolean(value));
  return methods.length ? unique(methods) : ["REQUEST"];
}

function parseParameters(parametersNode: Parser.SyntaxNode | null): ParsedJavaParameter[] {
  if (!parametersNode) {
    return [];
  }
  return parametersNode.namedChildren
    .filter((node) => node.type === "formal_parameter" || node.type === "spread_parameter")
    .map((node) => parseParameter(node));
}

function modifiersOf(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.childForFieldName("modifiers") ?? node.namedChildren.find((child) => child.type === "modifiers") ?? null;
}

function parseParameter(node: Parser.SyntaxNode): ParsedJavaParameter {
  const modifiers = node.childForFieldName("modifiers") ?? node.namedChildren.find((child) => child.type === "modifiers") ?? null;
  const annotations = annotationsOf(modifiers);
  const variableName = node.childForFieldName("name")?.text ?? "unknown";
  const type = node.childForFieldName("type")?.text ?? "unknown";
  const sourceAnnotation = annotations.find((annotation) => ["PathVariable", "RequestParam", "RequestHeader", "RequestBody"].includes(annotation.name));
  const source = parameterSource(sourceAnnotation?.name);
  const explicitName = sourceAnnotation?.named.get("name")?.[0] ?? sourceAnnotation?.named.get("value")?.[0] ?? sourceAnnotation?.positional[0];
  const requiredValue = sourceAnnotation?.named.get("required")?.[0];
  const defaultValue = sourceAnnotation?.named.get("defaultValue")?.[0];
  const validationAnnotations = namesMatching(annotations, validationNames);
  const result: ApiParameter & Omit<ParsedJavaParameter, keyof ApiParameter> = {
    name: explicitName || variableName,
    type,
    source,
    ...(requiredValue === undefined ? {} : { required: requiredValue !== "false" }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    raw: node.text,
    annotations: annotations.map((annotation) => annotation.name),
    validationAnnotations,
    sourceRange: rangeOf(node)
  };
  return result;
}

function parameterSource(annotationName?: string): ApiParameter["source"] {
  switch (annotationName) {
    case "PathVariable": return "path";
    case "RequestParam": return "query";
    case "RequestHeader": return "header";
    case "RequestBody": return "body";
    default: return "request";
  }
}

function combinePaths(basePaths: string[], methodPaths: string[]): string[] {
  const bases = basePaths.length ? basePaths : [""];
  const methods = methodPaths.length ? methodPaths : [""];
  return unique(bases.flatMap((base) => methods.map((method) => joinPaths(base, method))));
}

function joinPaths(basePath: string, methodPath: string): string {
  const combined = `/${basePath}/${methodPath}`.replace(/\/+/g, "/");
  return combined.length > 1 ? combined.replace(/\/$/, "") : combined;
}

function namesMatching(annotations: AnnotationValue[], accepted: Set<string>): string[] {
  return annotations.map((annotation) => annotation.name).filter((name) => accepted.has(name));
}

function rangeOf(node: Parser.SyntaxNode): ParsedSourceRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
    startIndex: node.startIndex,
    endIndex: node.endIndex
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stripQuotes(value: string): string {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function endpointKey(endpoint: ParsedJavaEndpoint): string {
  const path = (`/${endpoint.path || ""}`)
    .replace(/\/+/g, "/")
    .replace(/\{[^}]+\}|:[A-Za-z0-9_]+|\$\{[^}]+\}/g, "{param}")
    .replace(/\/$/, "") || "/";
  return `${endpoint.httpMethod} ${path} ${endpoint.handlerMethod}`;
}
