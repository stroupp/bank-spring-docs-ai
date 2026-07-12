export type ParserLanguage = "java" | "react";

export interface ParserProviderIdentity {
  name: string;
  version: string;
  language: ParserLanguage;
  strategy: "regex" | "ast";
}

export interface ParserProviderWarning {
  code: string;
  message: string;
  capability?: string;
}

export interface ParserProviderDiagnostics extends ParserProviderIdentity {
  capabilities: string[];
  confidence: "high" | "medium" | "low";
  warnings: ParserProviderWarning[];
}

export interface ParserProvider {
  readonly identity: ParserProviderIdentity;
  diagnostics(): ParserProviderDiagnostics;
}
