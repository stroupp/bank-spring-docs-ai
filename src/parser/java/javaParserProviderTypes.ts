import { JavaMethodCallRecord } from "../../analyzer/be/javaMethodCallExtractor";
import { RepositoryMethodRecord } from "../../analyzer/be/repositoryMethodExtractor";
import { BffDtoRecord } from "../../analyzer/bff/bffDtoExtractor";
import { ApiEndpoint, ApiParameter } from "../../analyzer/springEndpointExtractor";
import { EntityIndex } from "../../analyzer/springEntityExtractor";
import { ParserProvider } from "../parserProviderTypes";

export interface ParsedSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startIndex: number;
  endIndex: number;
}

export type ParsedJavaParameter = ApiParameter & {
  annotations?: string[];
  validationAnnotations?: string[];
  sourceRange?: ParsedSourceRange;
};

/**
 * Optional fields enrich AST-backed results without changing the JSONL shape
 * consumed by the existing regex pipeline.
 */
export type ParsedJavaEndpoint = Omit<ApiEndpoint, "parameters"> & {
  parameters: ParsedJavaParameter[];
  parser?: string;
  parserVersion?: string;
  confidence?: "high" | "medium" | "low";
  annotations?: string[];
  validationAnnotations?: string[];
  securityAnnotations?: string[];
  mappingPaths?: string[];
  sourceRange?: ParsedSourceRange;
  fallbackReason?: string;
};
export type ParsedJavaModel = EntityIndex | BffDtoRecord;
export type ParsedJavaServiceMethod = JavaMethodCallRecord;
export type ParsedJavaRepositoryMethod = RepositoryMethodRecord;

export interface JavaParserProvider extends ParserProvider {
  parseControllerEndpoints(filePath: string, source: string): ParsedJavaEndpoint[];
  parseDtoOrEntity(filePath: string, source: string): ParsedJavaModel[];
  parseServiceMethods(filePath: string, source: string): ParsedJavaServiceMethod[];
  parseRepositoryMethods(filePath: string, source: string): ParsedJavaRepositoryMethod[];
}
