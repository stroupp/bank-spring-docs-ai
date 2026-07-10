import { BffToBeMatch } from "./bffToBeMatcher";
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

export class PageFlowBuilder {
  build(uiToBff: UiToBffMatch[], bffToBe: BffToBeMatch[], interactions: UiInteractionForTrace[], routes: UiRouteForTrace[]): PageFlowRecord[] {
    return uiToBff.map((match) => {
      const pageContext = this.resolvePageContext(match);
      const page = pageContext.page;
      const interaction = this.findInteraction(page, match.uiApiFile, match.uiClientFunction, interactions);
      const route = routes.find((candidate) => candidate.pageComponent === page || match.uiPage?.includes(candidate.pageComponent))?.route;
      const beMatch = match.bffEndpoint
        ? bffToBe.find((candidate) => candidate.bffEndpoint === match.bffEndpoint)
        : undefined;
      const uncertainties: string[] = [];

      if (!match.bffEndpoint) {
        uncertainties.push("UI API call could not be matched to a BFF endpoint.");
      }
      if (match.bffEndpoint && !beMatch?.beEndpoint) {
        uncertainties.push("BFF endpoint could not be matched to a BE endpoint from available local indexes.");
      }
      if (!interaction && pageContext.flowType !== "session-background") {
        uncertainties.push("UI interaction handler is not visible from extracted indexes.");
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
        beFlow: beMatch?.beController && beMatch.beHandler ? [`${beMatch.beController}.${beMatch.beHandler}`] : [],
        entities: [],
        tables: [],
        confidence: match.confidence === "high" && beMatch?.confidence === "high" ? "high" : uncertainties.length ? "partial" : "medium",
        uncertainties
      };
    });
  }

  private findInteraction(page: string, apiFile: string, clientFunction: string | undefined, interactions: UiInteractionForTrace[]): UiInteractionForTrace | undefined {
    return interactions.find((interaction) => interaction.page === page)
      ?? interactions.find((interaction) => clientFunction && normalizeName(interaction.handler) === normalizeName(clientFunction))
      ?? interactions.find((interaction) => clientFunction && normalizeName(interaction.label) === normalizeName(clientFunction))
      ?? interactions.find((interaction) => interaction.file === apiFile)
      ?? undefined;
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

function normalizeName(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
