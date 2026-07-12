import { ParserProvider, ParserProviderDiagnostics } from "./parserProviderTypes";

export interface ParserDiagnosticsSummary {
  generatedAt: string;
  providers: ParserProviderDiagnostics[];
  warningCount: number;
}

export function collectParserProviderDiagnostics(providers: ParserProvider[]): ParserDiagnosticsSummary {
  const diagnostics = providers.map((provider) => provider.diagnostics());
  return {
    generatedAt: new Date().toISOString(),
    providers: diagnostics,
    warningCount: diagnostics.reduce((total, item) => total + item.warnings.length, 0)
  };
}
