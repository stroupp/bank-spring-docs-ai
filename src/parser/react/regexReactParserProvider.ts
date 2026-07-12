import { ReactApiCallExtractor } from "../../analyzer/ui/reactApiCallExtractor";
import { ReactComponentExtractor } from "../../analyzer/ui/reactComponentExtractor";
import { classifyReactFile } from "../../analyzer/ui/reactFileClassifier";
import { ReactFormFieldExtractor } from "../../analyzer/ui/reactFormFieldExtractor";
import { ReactInteractionExtractor } from "../../analyzer/ui/reactInteractionExtractor";
import { ReactScannedFile } from "../../analyzer/ui/reactRepositoryScanner";
import { ReactRouteExtractor } from "../../analyzer/ui/reactRouteExtractor";
import { ReactStateExtractor } from "../../analyzer/ui/reactStateExtractor";
import { ParserProviderDiagnostics, ParserProviderIdentity } from "../parserProviderTypes";
import { ParsedReactApiCall, ParsedReactComponent, ParsedReactFormField, ParsedReactInteraction, ParsedReactRoute, ParsedReactStateUsage, ReactParserProvider } from "./reactParserProviderTypes";

export class RegexReactParserProvider implements ReactParserProvider {
  readonly identity: ParserProviderIdentity = {
    name: "regex-react",
    version: "1.0.0",
    language: "react",
    strategy: "regex"
  };

  parseRoutes(filePath: string, source: string): ParsedReactRoute[] {
    return new ReactRouteExtractor().extract([reactFile(filePath, source)]);
  }

  parseComponents(filePath: string, source: string): ParsedReactComponent[] {
    const file = reactFile(filePath, source);
    const routes = new ReactRouteExtractor().extract([file]);
    return new ReactComponentExtractor().extract([file], routes);
  }

  parseInteractions(filePath: string, source: string): ParsedReactInteraction[] {
    const file = reactFile(filePath, source);
    const components = componentsFor(file);
    return new ReactInteractionExtractor().extract([file], components);
  }

  parseApiCalls(filePath: string, source: string): ParsedReactApiCall[] {
    const file = reactFile(filePath, source);
    return new ReactApiCallExtractor().extract([file], componentsFor(file));
  }

  parseFormFields(filePath: string, source: string): ParsedReactFormField[] {
    const file = reactFile(filePath, source);
    return new ReactFormFieldExtractor().extract([file], componentsFor(file));
  }

  parseStateUsage(filePath: string, source: string): ParsedReactStateUsage[] {
    const file = reactFile(filePath, source);
    return new ReactStateExtractor().extract([file], componentsFor(file));
  }

  diagnostics(): ParserProviderDiagnostics {
    return {
      ...this.identity,
      capabilities: ["routes", "components", "interactions", "api-calls", "form-fields", "state-usage"],
      confidence: "medium",
      warnings: [
        { code: "REGEX_JSX", capability: "interactions", message: "Nested JSX and inline closures may only be partially represented." },
        { code: "SINGLE_FILE_CONTEXT", capability: "all", message: "Provider calls operate on one file; cross-file ownership is resolved by the production pipeline." },
        { code: "FORM_FIELD_DUPLICATES", capability: "form-fields", message: "Controller name attributes can appear in both generic and react-hook-form matches." }
      ]
    };
  }
}

function reactFile(filePath: string, source: string): ReactScannedFile {
  const normalized = filePath.replace(/\\/g, "/");
  return {
    file: normalized,
    absolutePath: filePath,
    extension: normalized.match(/\.[^.]+$/)?.[0] ?? ".tsx",
    classification: classifyReactFile(normalized, source),
    size: Buffer.byteLength(source, "utf8"),
    content: source
  };
}

function componentsFor(file: ReactScannedFile): ParsedReactComponent[] {
  const routes = new ReactRouteExtractor().extract([file]);
  return new ReactComponentExtractor().extract([file], routes);
}
