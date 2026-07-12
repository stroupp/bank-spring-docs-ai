import { JavaMethodCallExtractor } from "../../analyzer/be/javaMethodCallExtractor";
import { RepositoryMethodExtractor } from "../../analyzer/be/repositoryMethodExtractor";
import { BffDtoExtractor } from "../../analyzer/bff/bffDtoExtractor";
import { classifyJavaFile } from "../../analyzer/javaFileClassifier";
import { ScannedFile } from "../../analyzer/repositoryScanner";
import { SpringEndpointExtractor } from "../../analyzer/springEndpointExtractor";
import { SpringEntityExtractor } from "../../analyzer/springEntityExtractor";
import { ParserProviderDiagnostics, ParserProviderIdentity } from "../parserProviderTypes";
import { JavaParserProvider, ParsedJavaEndpoint, ParsedJavaModel, ParsedJavaRepositoryMethod, ParsedJavaServiceMethod } from "./javaParserProviderTypes";

export class RegexJavaParserProvider implements JavaParserProvider {
  readonly identity: ParserProviderIdentity = {
    name: "regex-java",
    version: "1.0.0",
    language: "java",
    strategy: "regex"
  };

  parseControllerEndpoints(filePath: string, source: string): ParsedJavaEndpoint[] {
    return new SpringEndpointExtractor().extract([javaFile(filePath, source)]);
  }

  parseDtoOrEntity(filePath: string, source: string): ParsedJavaModel[] {
    const file = javaFile(filePath, source);
    return [...new SpringEntityExtractor().extract([file]), ...new BffDtoExtractor().extract([file])];
  }

  parseServiceMethods(filePath: string, source: string): ParsedJavaServiceMethod[] {
    return new JavaMethodCallExtractor().extract([javaFile(filePath, source)]);
  }

  parseRepositoryMethods(filePath: string, source: string): ParsedJavaRepositoryMethod[] {
    return new RepositoryMethodExtractor().extract([javaFile(filePath, source)]);
  }

  diagnostics(): ParserProviderDiagnostics {
    return {
      ...this.identity,
      capabilities: ["controller-endpoints", "dto-entity-models", "service-method-calls", "repository-methods"],
      confidence: "medium",
      warnings: [
        { code: "REGEX_NESTING", capability: "all", message: "Deeply nested Java syntax and generated/Lombok members can be incomplete." },
        { code: "SERVICE_CALL_VIEW", capability: "service-method-calls", message: "Service output represents detected outbound method calls, not a full method AST." },
        { code: "MODEL_ROLE_OVERLAP", capability: "dto-entity-models", message: "Path/name conventions can classify one source as both an entity and a DTO projection." }
      ]
    };
  }
}

function javaFile(filePath: string, source: string): ScannedFile {
  return {
    file: filePath.replace(/\\/g, "/"),
    absolutePath: filePath,
    extension: ".java",
    kind: "java",
    classification: classifyJavaFile(filePath.replace(/\\/g, "/"), source),
    size: Buffer.byteLength(source, "utf8"),
    content: source
  };
}
