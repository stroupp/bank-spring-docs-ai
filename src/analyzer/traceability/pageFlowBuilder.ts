import { BffToBeMatch } from "./bffToBeMatcher";
import { normalizeHttpPath, normalizeMethod } from "./pathNormalizer";
import { UiToBffMatch } from "./uiToBffMatcher";

export interface PageFlowRecord {
  page: string;
  flowType?: "page" | "layout" | "session-background";
  route?: string;
  interaction?: string;
  uiHandler?: string;
  uiApiCall: string;
  bffEndpoint?: string;
  bffFlow: string[];
  beEndpoint?: string;
  beFlow: string[];
  entities: string[];
  tables: string[];
  confidence: "high" | "medium" | "low" | "partial";
  uncertainties: string[];
}

export interface UiInteractionForTrace {
  page?: string;
  component: string;
  label: string;
  handler: string;
  file: string;
}

export interface UiRouteForTrace {
  route: string;
  pageComponent: string;
}

export interface BeServiceFlowForTrace {
  endpoint: string;
  controller: string;
  handler: string;
  candidateServices: string[];
  candidateRepositories: string[];
  entities: string[];
  repositoryMethods: string[];
  methodCalls?: string[];
  confidence: "high" | "medium" | "low";
}

export interface BeEntityForTrace {
  entity: string;
  table?: string;
}

export class PageFlowBuilder {
  build(
    uiToBff: UiToBffMatch[],
    bffToBe: BffToBeMatch[],
    interactions: UiInteractionForTrace[],
    routes: UiRouteForTrace[],
    beServiceFlows?: BeServiceFlowForTrace[],
    beEntities?: BeEntityForTrace[]
  ): PageFlowRecord[] {
    return uiToBff.map((match) => {
      const pageContext = this.resolvePageContext(match);
      const page = pageContext.page;
      const interaction = this.findInteraction(page, match.uiClientFunction, interactions);
      const route = routes.find((candidate) => candidate.pageComponent === page || match.uiPage?.includes(candidate.pageComponent))?.route;
      const beMatch = match.bffEndpoint
        ? bffToBe.find((candidate) => candidate.bffEndpoint === match.bffEndpoint)
        : undefined;
      const uncertainties: string[] = [];
      const serviceFlowResolution = beMatch?.beEndpoint && beServiceFlows
        ? resolveServiceFlow(beMatch, beServiceFlows)
        : undefined;
      const serviceFlow = serviceFlowResolution?.flow;
      const methodEvidence = serviceFlow ? reachableMethodEvidence(serviceFlow) : [];
      const entityResolution = serviceFlow && beEntities
        ? resolveEntities(serviceFlow.entities, beEntities)
        : { entities: serviceFlow?.entities ?? [], tables: [], unmapped: [] };

      if (!match.bffEndpoint) {
        uncertainties.push("UI API call could not be matched to a BFF endpoint.");
      }
      if (match.bffEndpoint && !beMatch?.beEndpoint) {
        uncertainties.push("BFF endpoint could not be matched to a BE endpoint from available local indexes.");
      }
      if (!interaction && pageContext.flowType !== "session-background" && requiresExplicitInteraction(match.uiApiCall)) {
        uncertainties.push("UI interaction handler is not visible from extracted indexes.");
      }
      if (match.confidence === "low") {
        uncertainties.push("UI to BFF match is ambiguous or low confidence.");
      }
      if (beMatch?.confidence === "low") {
        uncertainties.push("BFF to BE match is ambiguous or low confidence.");
      }
      if (beMatch?.beEndpoint && beServiceFlows) {
        if (serviceFlowResolution?.ambiguous) {
          uncertainties.push("Multiple BE service-flow records match the normalized BE endpoint.");
        } else if (!serviceFlow) {
          uncertainties.push("BE service-flow evidence is missing for the matched endpoint.");
        } else {
          if (serviceFlow.confidence === "low") {
            uncertainties.push("BE service-flow evidence is low confidence.");
          }
          if (!methodEvidence.length) {
            uncertainties.push("Handler-reachable BE service or repository method evidence is missing.");
          }
          if (entityResolution.unmapped.length) {
            uncertainties.push(`Table mapping is missing for BE entities: ${entityResolution.unmapped.join(", ")}.`);
          }
        }
      }

      return {
        page,
        flowType: pageContext.flowType,
        route,
        interaction: interaction?.label,
        uiHandler: interaction?.handler,
        uiApiCall: match.uiApiCall,
        bffEndpoint: match.bffEndpoint,
        bffFlow: match.bffController && match.bffHandler ? [`${match.bffController}.${match.bffHandler}`] : [],
        beEndpoint: beMatch?.beEndpoint,
        beFlow: unique([
          ...(beMatch?.beController && beMatch.beHandler ? [`${beMatch.beController}.${beMatch.beHandler}`] : []),
          ...methodEvidence
        ]),
        entities: entityResolution.entities,
        tables: entityResolution.tables,
        confidence: uncertainties.length
          ? "partial"
          : match.confidence === "high" && beMatch?.confidence === "high" && (!serviceFlow || serviceFlow.confidence === "high")
            ? "high"
            : "medium",
        uncertainties
      };
    });
  }

  private findInteraction(page: string, clientFunction: string | undefined, interactions: UiInteractionForTrace[]): UiInteractionForTrace | undefined {
    if (!clientFunction) {
      return undefined;
    }
    const normalizedFunction = normalizeName(clientFunction);
    const action = actionName(clientFunction);
    const ranked = interactions
      .map((interaction) => ({ interaction, score: interactionScore(interaction, page, normalizedFunction, action) }))
      .filter((candidate) => candidate.score >= 60)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) {
      return undefined;
    }
    return ranked[0].interaction;
  }

  private cleanPage(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    return value.split("/").pop()?.replace(/\.(tsx|ts|jsx|js)$/i, "");
  }

  private resolvePageContext(match: UiToBffMatch): { page: string; flowType: PageFlowRecord["flowType"] } {
    const cleaned = this.cleanPage(match.uiPage);
    if (cleaned) {
      return {
        page: cleaned,
        flowType: cleaned.toLowerCase() === "layout" ? "layout" : "page"
      };
    }

    const apiCall = `${match.uiApiCall} ${match.uiClientFunction ?? ""}`.toLowerCase();
    if (apiCall.includes("refresh") || apiCall.includes("session") || apiCall.includes("token")) {
      return { page: "SessionBackground", flowType: "session-background" };
    }

    return { page: "UnknownPage", flowType: "page" };
  }
}

function interactionScore(
  interaction: UiInteractionForTrace,
  page: string,
  normalizedFunction: string,
  action: string
): number {
  if (interaction.page && interaction.page !== page) {
    return 0;
  }
  const handler = normalizeName(interaction.handler);
  const label = normalizeName(interaction.label);
  let score = 0;
  if (normalizedFunction.length >= 4 && handler.includes(normalizedFunction)) {
    score = 100;
  }
  if (action.length >= 4) {
    if (label === action) {
      score = Math.max(score, 95);
    } else if (label.includes(action) || action.includes(label)) {
      score = Math.max(score, 85);
    }
    if (handler.includes(action)) {
      score = Math.max(score, 80);
    }
  }
  if (action === "create" && /save.*draft|create/.test(label)) {
    score = Math.max(score, 85);
  }
  if (score > 0 && interaction.page === page) {
    score += 5;
  }
  return score;
}

function actionName(clientFunction: string): string {
  return normalizeName(clientFunction).replace(/(?:releases?|requests?|api|client|fetch|call)$/i, "");
}

function requiresExplicitInteraction(uiApiCall: string): boolean {
  return !/^\s*(?:GET|HEAD)\b/i.test(uiApiCall);
}

function resolveServiceFlow(
  beMatch: BffToBeMatch,
  serviceFlows: BeServiceFlowForTrace[]
): { flow?: BeServiceFlowForTrace; ambiguous: boolean } {
  const endpointKey = normalizeEndpointKey(beMatch.beEndpoint);
  if (!endpointKey) {
    return { ambiguous: false };
  }
  const endpointMatches = serviceFlows.filter((flow) => normalizeEndpointKey(flow.endpoint) === endpointKey);
  if (endpointMatches.length <= 1) {
    return { flow: endpointMatches[0], ambiguous: false };
  }

  const handlerMatches = endpointMatches.filter((flow) =>
    normalizeName(flow.controller) === normalizeName(beMatch.beController) &&
    normalizeName(flow.handler) === normalizeName(beMatch.beHandler));
  return handlerMatches.length === 1
    ? { flow: handlerMatches[0], ambiguous: false }
    : { ambiguous: true };
}

function reachableMethodEvidence(flow: BeServiceFlowForTrace): string[] {
  const reachableTypes = new Set([...flow.candidateServices, ...flow.candidateRepositories].map(normalizeTypeName));
  const evidence: string[] = [];
  for (const call of flow.methodCalls ?? []) {
    for (const node of call.split(/\s*->\s*/)) {
      const className = node.trim().split(".")[0];
      if (reachableTypes.has(normalizeTypeName(className))) {
        evidence.push(node.trim());
      }
    }
  }
  evidence.push(...flow.repositoryMethods);
  return unique(evidence.filter(Boolean));
}

function resolveEntities(
  names: string[],
  entityIndex: BeEntityForTrace[]
): { entities: string[]; tables: string[]; unmapped: string[] } {
  const entities = unique(names.filter(Boolean));
  const tables: string[] = [];
  const unmapped: string[] = [];
  for (const name of entities) {
    const matches = entityIndex.filter((entity) => normalizeTypeName(entity.entity) === normalizeTypeName(name));
    const candidateTables = unique(matches.map((entity) => entity.table).filter((table): table is string => Boolean(table)));
    if (candidateTables.length === 1) {
      tables.push(candidateTables[0]);
    } else {
      unmapped.push(name);
    }
  }
  return { entities, tables: unique(tables), unmapped };
}

function normalizeEndpointKey(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^([A-Za-z]+)\s+(.+)$/);
  return match ? `${normalizeMethod(match[1])} ${normalizeHttpPath(match[2])}` : undefined;
}

function normalizeTypeName(value: string | undefined): string {
  return (value ?? "").split(/[.$]/).pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeName(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
