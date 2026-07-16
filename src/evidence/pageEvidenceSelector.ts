import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";

export type EvidenceRole = "ui" | "bff" | "be";

export interface EvidenceFileSelection {
  role: EvidenceRole;
  repoRoot: string;
  files: string[];
  uncertaintyNotes: string[];
}

type JsonRecord = Record<string, unknown>;

export function selectPageEvidenceFiles(manifest: MultiRepoManifest, pageFlow: Record<string, unknown>): EvidenceFileSelection[] {
  const selectedPage = asRecord(pageFlow.selectedPage);
  const bffToBeMatches = asRecords(pageFlow.bffToBeMatches);
  const beServiceFlows = asRecords(pageFlow.beServiceFlows);
  const trustedBeServiceFlows = beServiceFlows.filter((flow) => String(flow.confidence ?? "") !== "low");
  const referencedEntities = new Set(trustedBeServiceFlows.flatMap((flow) => asStringArray(flow.entities)).map(normalizeName));
  const referencedRepositoryMethods = new Set(trustedBeServiceFlows.flatMap((flow) => asStringArray(flow.repositoryMethods)).map(normalizeName));
  const matchedEntities = asRecords(pageFlow.entities).filter((entity) => referencedEntities.has(normalizeName(entity.entity)));
  const matchedRepositories = asRecords(pageFlow.repositories).filter((repository) => {
    const methodKey = normalizeName(`${repository.repository ?? ""}.${repository.method ?? ""}`);
    const entityKey = normalizeName(repository.entity);
    return referencedRepositoryMethods.has(methodKey) || referencedEntities.has(entityKey);
  });
  const uncertaintyNotes = buildUncertaintyNotes(pageFlow);
  const selections: EvidenceFileSelection[] = [
    {
      role: "ui",
      repoRoot: manifest.repos.ui.localPath,
      files: unique([
        ...collectFiles(selectedPage),
        ...collectFiles(pageFlow.routes),
        ...collectFiles(pageFlow.components),
        ...collectFiles(pageFlow.interactions),
        ...collectFiles(pageFlow.formFields),
        ...collectFiles(pageFlow.states),
        ...collectFiles(pageFlow.uiApiCalls)
      ]),
      uncertaintyNotes: uncertaintyNotes.ui
    },
    {
      role: "bff",
      repoRoot: manifest.repos.bff.localPath,
      files: unique([
        ...collectTraceFiles(bffToBeMatches, "bff"),
        ...collectFiles(pageFlow.bffEndpoints),
        ...collectFiles(pageFlow.bffComponents),
        ...collectFiles(pageFlow.bffDtos),
        ...collectFiles(pageFlow.bffServiceFlows),
        ...collectFiles(pageFlow.uiToBffMatches)
      ]),
      uncertaintyNotes: uncertaintyNotes.bff
    },
    {
      role: "be",
      repoRoot: manifest.repos.be.localPath,
      files: unique([
        ...collectTraceFiles(bffToBeMatches, "be"),
        ...collectFiles(pageFlow.beEndpoints),
        ...collectFiles(pageFlow.beComponents),
        ...collectFiles(pageFlow.beDtos),
        ...collectFiles(pageFlow.beValidations),
        ...collectFiles(pageFlow.beServiceFlows),
        ...collectFiles(matchedRepositories.slice(0, 8)),
        ...collectFiles(matchedEntities.slice(0, 8))
      ]),
      uncertaintyNotes: uncertaintyNotes.be
    }
  ];
  return selections.filter((selection) => selection.files.length > 0);
}

function collectTraceFiles(matches: JsonRecord[], role: "bff" | "be"): string[] {
  const keys = role === "bff"
    ? ["bffFile", "bffSourceFile", "clientFile", "outboundFile"]
    : ["beFile", "beTargetFile", "targetFile", "endpointFile"];
  return matches.flatMap((match) => keys.flatMap((key) => collectFiles(match[key])));
}

function buildUncertaintyNotes(pageFlow: Record<string, unknown>): Record<EvidenceRole, string[]> {
  const notes: Record<EvidenceRole, string[]> = { ui: [], bff: [], be: [] };
  for (const flow of asRecords(pageFlow.pageFlows)) {
    const confidence = String(flow.confidence ?? "");
    const uncertainties = asStringArray(flow.uncertainties);
    if (confidence && confidence !== "high") {
      notes.ui.push(`Page flow confidence is ${confidence}.`);
    }
    notes.ui.push(...uncertainties);
  }
  for (const match of asRecords(pageFlow.uiToBffMatches)) {
    if (String(match.confidence ?? "") !== "high") {
      notes.bff.push(`UI -> BFF match confidence is ${match.confidence ?? "unknown"} for ${match.uiApiCall ?? "unknown call"}.`);
    }
  }
  for (const match of asRecords(pageFlow.bffToBeMatches)) {
    if (String(match.confidence ?? "") !== "high") {
      notes.be.push(`BFF -> BE match confidence is ${match.confidence ?? "unknown"} for ${match.bffEndpoint ?? "unknown endpoint"}.`);
    }
  }
  for (const flow of asRecords(pageFlow.beServiceFlows)) {
    if (String(flow.confidence ?? "") !== "high") {
      notes.be.push(`BE service-flow confidence is ${flow.confidence ?? "unknown"} for ${flow.endpoint ?? "unknown endpoint"}.`);
    }
  }
  return {
    ui: unique(notes.ui),
    bff: unique(notes.bff),
    be: unique(notes.be)
  };
}

function collectFiles(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    return looksLikeSourceFile(value) ? [normalizeFile(value)] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectFiles);
  }
  if (typeof value === "object") {
    const record = value as JsonRecord;
    const direct = [
      "file",
      "sourceFile",
      "targetFile",
      "callerFile",
      "calleeFile",
      "componentFile",
      "pageFile",
      "routeFile"
    ].flatMap((key) => collectFiles(record[key]));
    const nested = Object.entries(record)
      .filter(([key]) => /file|source|target|component|route|page/i.test(key))
      .flatMap(([, item]) => collectFiles(item));
    return [...direct, ...nested];
  }
  return [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  return value ? [String(value)] : [];
}

function normalizeName(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function looksLikeSourceFile(value: string): boolean {
  return /\.(java|kt|ts|tsx|js|jsx|properties|ya?ml|xml|json)$/i.test(value);
}

function normalizeFile(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^["'`(]+|["'`),.:;]+$/g, "").replace(/^\/+/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
