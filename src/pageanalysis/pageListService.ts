import * as path from "path";
import { readJsonl } from "../storage/jsonlWriter";

export type PageMatchStatus = "matched" | "partial" | "none" | "unknown";
export type PageConfidence = "high" | "medium" | "low" | "unknown";

export type PageCandidate = {
  pageName: string;
  route?: string;
  file?: string;
  apiCallCount: number;
  bffMatchStatus: PageMatchStatus;
  beMatchStatus: PageMatchStatus;
  confidence: PageConfidence;
};

type RouteIndex = {
  route?: string;
  path?: string;
  pageComponent?: string;
  component?: string;
  file?: string;
};

type PageIndex = {
  page?: string;
  pageName?: string;
  component?: string;
  file?: string;
  route?: string;
};

type ComponentIndex = {
  component?: string;
  name?: string;
  classification?: string;
  file?: string;
  route?: string;
};

type ApiCallIndex = {
  usedBy?: unknown;
  page?: string;
  component?: string;
  file?: string;
};

type PageFlowIndex = {
  page?: string;
  route?: string;
  bffEndpoint?: string;
  beEndpoint?: string;
  confidence?: string;
};

export class PageListService {
  async list(multiRepoRoot: string): Promise<PageCandidate[]> {
    const routes = await readJsonl<RouteIndex>(path.join(multiRepoRoot, "ui", "route-index.jsonl"));
    const pages = await readJsonl<PageIndex>(path.join(multiRepoRoot, "ui", "page-index.jsonl"));
    const components = await readJsonl<ComponentIndex>(path.join(multiRepoRoot, "ui", "component-index.jsonl"));
    const apiCalls = await readJsonl<ApiCallIndex>(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"));
    const pageFlows = await readJsonl<PageFlowIndex>(path.join(multiRepoRoot, "traceability", "page-flows.jsonl"));

    const byName = new Map<string, PageCandidate>();
    const upsert = (candidate: Partial<PageCandidate> & { pageName: string }): PageCandidate => {
      const key = normalize(candidate.pageName);
      const existing = byName.get(key);
      const next: PageCandidate = {
        pageName: candidate.pageName,
        route: candidate.route ?? existing?.route,
        file: candidate.file ?? existing?.file,
        apiCallCount: existing?.apiCallCount ?? 0,
        bffMatchStatus: existing?.bffMatchStatus ?? "unknown",
        beMatchStatus: existing?.beMatchStatus ?? "unknown",
        confidence: existing?.confidence ?? "unknown"
      };
      byName.set(key, next);
      return next;
    };

    for (const page of pages) {
      const pageName = page.page ?? page.pageName ?? page.component;
      if (pageName) {
        upsert({ pageName, route: page.route, file: page.file });
      }
    }

    for (const route of routes) {
      const pageName = route.pageComponent ?? route.component;
      if (pageName) {
        upsert({ pageName, route: route.route ?? route.path, file: route.file });
      }
    }

    for (const component of components) {
      const pageName = component.component ?? component.name;
      if (pageName && (component.classification === "page" || component.route)) {
        upsert({ pageName, route: component.route, file: component.file });
      }
    }

    for (const flow of pageFlows) {
      if (flow.page) {
        upsert({ pageName: flow.page, route: flow.route });
      }
    }

    for (const candidate of byName.values()) {
      candidate.apiCallCount = apiCalls.filter((call) => isApiCallOwnedBy(call, candidate)).length;
      const relatedFlows = pageFlows.filter((flow) => flowMatchesCandidate(flow, candidate));
      candidate.bffMatchStatus = statusFrom(relatedFlows, "bffEndpoint");
      candidate.beMatchStatus = statusFrom(relatedFlows, "beEndpoint");
      candidate.confidence = confidenceFrom(relatedFlows);
    }

    return [...byName.values()].sort((a, b) => `${a.route ?? ""}${a.pageName}`.localeCompare(`${b.route ?? ""}${b.pageName}`));
  }
}

function isApiCallOwnedBy(call: ApiCallIndex, candidate: PageCandidate): boolean {
  const owners = [
    ...asStringArray(call.usedBy),
    call.page,
    call.component,
    call.file
  ].filter(Boolean).map((value) => normalize(String(value)));
  const names = [candidate.pageName, candidate.file, candidate.route].filter(Boolean).map((value) => normalize(String(value)));
  return owners.some((owner) => names.some((name) => owner === name || owner.includes(name) || name.includes(owner)));
}

function flowMatchesCandidate(flow: PageFlowIndex, candidate: PageCandidate): boolean {
  const flowPage = normalize(flow.page);
  const flowRoute = normalize(flow.route);
  return Boolean(
    (flowPage && flowPage === normalize(candidate.pageName)) ||
    (flowRoute && candidate.route && flowRoute === normalize(candidate.route))
  );
}

function statusFrom(flows: PageFlowIndex[], endpointKey: "bffEndpoint" | "beEndpoint"): PageMatchStatus {
  if (flows.length === 0) {
    return "none";
  }
  const matched = flows.filter((flow) => Boolean(flow[endpointKey])).length;
  if (matched === flows.length) {
    return "matched";
  }
  if (matched > 0) {
    return "partial";
  }
  return "none";
}

function confidenceFrom(flows: PageFlowIndex[]): PageConfidence {
  if (flows.length === 0) {
    return "unknown";
  }
  if (flows.some((flow) => flow.confidence === "high")) {
    return "high";
  }
  if (flows.some((flow) => flow.confidence === "medium")) {
    return "medium";
  }
  if (flows.some((flow) => flow.confidence === "low" || flow.confidence === "partial")) {
    return "low";
  }
  return "unknown";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return value ? [String(value)] : [];
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\.(tsx|ts|jsx|js)$/i, "").replace(/[^a-z0-9]/g, "");
}
