import * as fs from "fs/promises";
import * as path from "path";
import { readRequiredJsonl, writeJsonl } from "../storage/jsonlWriter";
import { sha256 } from "../utils/hash";
import { safeName } from "../utils/pathUtils";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { MultiRepoArtifactIdentityService } from "../multirepo/multiRepoArtifactIdentityService";
import { atomicWriteFile, atomicWriteJson } from "../storage/atomicFile";
import { repositoryUrlForArtifact } from "../utils/repositoryUrl";
import { PipelineArtifactReceiptService } from "../multirepo/pipelineArtifactReceiptService";
import { assertPathContainedForWrite } from "../storage/localStorageService";

export type KnowledgeNodeType =
  | "Repo"
  | "File"
  | "ReactPage"
  | "ReactComponent"
  | "UiInteraction"
  | "ApiCall"
  | "BffEndpoint"
  | "BffClient"
  | "BffDto"
  | "BeEndpoint"
  | "BeDto"
  | "JavaMethodCall"
  | "SpringComponent"
  | "BeServiceFlow"
  | "RepositoryMethod"
  | "Entity"
  | "Validation"
  | "Exception"
  | "PageFlow";

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  layer: "ui" | "bff" | "be" | "traceability" | "system";
  file?: string;
  properties: Record<string, unknown>;
}

export interface KnowledgeEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  confidence: "high" | "medium" | "low" | "unknown";
  properties: Record<string, unknown>;
}

export interface KnowledgeGraphResult {
  graphRoot: string;
  nodes: number;
  edges: number;
  summaryPath: string;
}

export class LocalKnowledgeGraphBuilder {
  async build(multiRepoRoot: string, manifest: MultiRepoManifest): Promise<KnowledgeGraphResult> {
    await new MultiRepoArtifactIdentityService().assertCompatible(multiRepoRoot, manifest);
    const hasTraceability = await new PipelineArtifactReceiptService()
      .assertTraceabilityCompatible(multiRepoRoot, manifest, { allowMissing: true });
    const graphRoot = path.join(multiRepoRoot, "graph");
    await assertPathContainedForWrite(multiRepoRoot, graphRoot);
    await fs.mkdir(graphRoot, { recursive: true });
    await assertPathContainedForWrite(multiRepoRoot, graphRoot);

    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();

    const addNode = (node: KnowledgeNode): string => {
      if (!nodeIds.has(node.id)) {
        nodeIds.add(node.id);
        nodes.push(node);
      }
      return node.id;
    };
    const addEdge = (edge: KnowledgeEdge): void => {
      if (!edgeIds.has(edge.id) && nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
        edgeIds.add(edge.id);
        edges.push(edge);
      }
    };

    const systemId = addNode(node("system", "Repo", manifest.projectName, "system", { branch: manifest.branch }));
    const uiRepoId = addNode(node("repo:ui", "Repo", "UI", "ui", { url: repositoryUrlForArtifact(manifest.repos.ui.url), localPath: manifest.repos.ui.localPath }));
    const bffRepoId = addNode(node("repo:bff", "Repo", "BFF", "bff", { url: repositoryUrlForArtifact(manifest.repos.bff.url), localPath: manifest.repos.bff.localPath }));
    const beRepoId = addNode(node("repo:be", "Repo", "BE", "be", { url: repositoryUrlForArtifact(manifest.repos.be.url), localPath: manifest.repos.be.localPath }));
    addEdge(edge("CONTAINS_REPO", systemId, uiRepoId));
    addEdge(edge("CONTAINS_REPO", systemId, bffRepoId));
    addEdge(edge("CONTAINS_REPO", systemId, beRepoId));

    await this.addUiGraph(multiRepoRoot, addNode, addEdge, uiRepoId);
    await this.addBffGraph(multiRepoRoot, addNode, addEdge, bffRepoId);
    await this.addBeGraph(multiRepoRoot, addNode, addEdge, beRepoId);
    if (hasTraceability) {
      await this.addTraceabilityGraph(multiRepoRoot, addNode, addEdge);
    }

    await writeJsonl(path.join(graphRoot, "nodes.jsonl"), nodes);
    await writeJsonl(path.join(graphRoot, "edges.jsonl"), edges);
    const summaryPath = path.join(graphRoot, "graph-summary.md");
    await atomicWriteFile(summaryPath, this.buildSummary(manifest, nodes, edges));
    await atomicWriteJson(path.join(graphRoot, "graph-summary.json"), {
      projectName: manifest.projectName,
      branch: manifest.branch,
      pipelineIdentity: manifest.pipelineIdentity,
      generatedAt: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodesByType: countBy(nodes, (item) => item.type),
      edgesByType: countBy(edges, (item) => item.type)
    });

    return { graphRoot, nodes: nodes.length, edges: edges.length, summaryPath };
  }

  private async addUiGraph(
    root: string,
    addNode: (node: KnowledgeNode) => string,
    addEdge: (edge: KnowledgeEdge) => void,
    repoId: string
  ): Promise<void> {
    const files = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "ui", "file-index.jsonl"));
    const pages = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "ui", "page-index.jsonl"));
    const components = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "ui", "component-index.jsonl"));
    const interactions = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "ui", "interaction-index.jsonl"));
    const apiCalls = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "ui", "api-call-index.jsonl"));

    for (const file of files) {
      const fileId = addNode(fileNode("ui", String(file.file), file));
      addEdge(edge("HAS_FILE", repoId, fileId));
    }
    for (const page of pages) {
      const pageId = addNode(node(`ui:page:${page.page}`, "ReactPage", String(page.page), "ui", page));
      if (page.file) {
        addEdge(edge("DEFINED_IN", pageId, fileNodeId("ui", String(page.file))));
      }
    }
    for (const component of components) {
      const componentId = addNode(node(`ui:component:${component.component}`, "ReactComponent", String(component.component), "ui", component));
      if (component.file) {
        addEdge(edge("DEFINED_IN", componentId, fileNodeId("ui", String(component.file))));
      }
      if (component.route) {
        const pageId = `ui:page:${component.component}`;
        addEdge(edge("ROUTE_TO", pageId, componentId, "medium", { route: component.route }));
      }
    }
    for (const interaction of interactions) {
      const interactionId = addNode(node(`ui:interaction:${hashLabel(interaction)}`, "UiInteraction", `${interaction.label ?? "interaction"} -> ${interaction.handler ?? ""}`, "ui", interaction));
      const owner = interaction.page ? `ui:page:${interaction.page}` : interaction.component ? `ui:component:${interaction.component}` : undefined;
      if (owner) {
        addEdge(edge("HANDLES", owner, interactionId, "medium"));
      }
    }
    for (const call of apiCalls) {
      const callId = addNode(node(`ui:api:${hashLabel(call)}`, "ApiCall", `${call.httpMethod ?? "GET"} ${call.path ?? ""}`, "ui", call));
      if (call.file) {
        addEdge(edge("DEFINED_IN", callId, fileNodeId("ui", String(call.file))));
      }
      for (const usedBy of asArray(call.usedBy)) {
        const pageId = String(usedBy).includes("/") ? undefined : `ui:page:${usedBy}`;
        if (pageId) {
          addEdge(edge("CALLS_API", pageId, callId, "medium"));
        }
      }
    }
  }

  private async addBffGraph(root: string, addNode: (node: KnowledgeNode) => string, addEdge: (edge: KnowledgeEdge) => void, repoId: string): Promise<void> {
    await this.addSpringCommon(root, "bff", addNode, addEdge, repoId, "BffEndpoint");
    const outbound = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "bff", "outbound-calls.jsonl"));
    const dtos = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "bff", "dto-index.jsonl"));
    for (const call of outbound) {
      const id = addNode(node(`bff:client-call:${hashLabel(call)}`, "BffClient", `${call.client ?? "client"}.${call.method ?? "method"}`, "bff", call));
      addEdge(edge("HAS_OUTBOUND_CALL", repoId, id, confidenceOf(call.confidence)));
    }
    for (const dto of dtos) {
      const id = addNode(node(`bff:dto:${dto.className}`, "BffDto", String(dto.className), "bff", dto));
      if (dto.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId("bff", String(dto.file))));
      }
    }
  }

  private async addBeGraph(root: string, addNode: (node: KnowledgeNode) => string, addEdge: (edge: KnowledgeEdge) => void, repoId: string): Promise<void> {
    await this.addSpringCommon(root, "be", addNode, addEdge, repoId, "BeEndpoint");
    const repositoryMethods = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "be", "repository-method-index.jsonl"));
    const validations = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "be", "validation-index.jsonl"));
    const exceptions = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "be", "exception-flow-index.jsonl"));
    const serviceFlows = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "be", "service-flow-index.jsonl"));
    const dtos = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "be", "dto-index.jsonl"));
    const methodCalls = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "be", "java-method-call-index.jsonl"));
    for (const item of repositoryMethods) {
      const id = addNode(node(`be:repo-method:${item.repository}.${item.method}`, "RepositoryMethod", `${item.repository}.${item.method}`, "be", item));
      if (item.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId("be", String(item.file))));
      }
    }
    for (const item of validations) {
      addNode(node(`be:validation:${hashLabel(item)}`, "Validation", `${item.annotation} ${item.fieldOrParameter}`, "be", item));
    }
    for (const item of exceptions) {
      addNode(node(`be:exception:${hashLabel(item)}`, "Exception", `${item.type}: ${item.detail}`, "be", item));
    }
    for (const item of serviceFlows) {
      addNode(node(`be:service-flow:${hashLabel(item)}`, "BeServiceFlow", String(item.endpoint), "be", item));
    }
    for (const dto of dtos) {
      const id = addNode(node(`be:dto:${dto.className}`, "BeDto", String(dto.className), "be", dto));
      if (dto.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId("be", String(dto.file))));
      }
    }
    for (const call of methodCalls) {
      const id = addNode(node(`be:method-call:${hashLabel(call)}`, "JavaMethodCall", `${call.className}.${call.methodName} -> ${call.targetType ?? call.targetVariable}.${call.targetMethod}`, "be", call));
      if (call.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId("be", String(call.file))));
      }
      if (call.targetType) {
        addEdge(edge("CALLS_CLASS", id, `be:component:${call.targetType}`, confidenceOf(call.confidence)));
      }
    }
  }

  private async addSpringCommon(
    root: string,
    layer: "bff" | "be",
    addNode: (node: KnowledgeNode) => string,
    addEdge: (edge: KnowledgeEdge) => void,
    repoId: string,
    endpointType: "BffEndpoint" | "BeEndpoint"
  ): Promise<void> {
    const files = await readRequiredJsonl<Record<string, unknown>>(path.join(root, layer, "file-index.jsonl"));
    const endpoints = await readRequiredJsonl<Record<string, unknown>>(path.join(root, layer, "api-endpoints.jsonl"));
    const entities = await readRequiredJsonl<Record<string, unknown>>(path.join(root, layer, "entity-index.jsonl"));
    for (const file of files) {
      const fileId = addNode(fileNode(layer, String(file.file), file));
      addEdge(edge("HAS_FILE", repoId, fileId));
    }
    for (const endpoint of endpoints) {
      const id = addNode(node(`${layer}:endpoint:${endpoint.httpMethod}:${endpoint.path}`, endpointType, `${endpoint.httpMethod} ${endpoint.path}`, layer, endpoint));
      if (endpoint.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId(layer, String(endpoint.file))));
      }
    }
    const components = await readRequiredJsonl<Record<string, unknown>>(path.join(root, layer, "spring-components.jsonl"));
    for (const component of components) {
      const id = addNode(node(`${layer}:component:${component.className}`, "SpringComponent", String(component.className), layer, component));
      if (component.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId(layer, String(component.file))));
      }
    }
    for (const entity of entities) {
      const id = addNode(node(`${layer}:entity:${entity.entity}`, "Entity", String(entity.entity), layer, entity));
      if (entity.file) {
        addEdge(edge("DEFINED_IN", id, fileNodeId(layer, String(entity.file))));
      }
    }
  }

  private async addTraceabilityGraph(root: string, addNode: (node: KnowledgeNode) => string, addEdge: (edge: KnowledgeEdge) => void): Promise<void> {
    const uiToBff = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "traceability", "ui-to-bff.jsonl"));
    const bffToBe = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "traceability", "bff-to-be.jsonl"));
    const pageFlows = await readRequiredJsonl<Record<string, unknown>>(path.join(root, "traceability", "page-flows.jsonl"));
    for (const match of uiToBff) {
      const apiId = addNode(node(`trace:ui-api:${hashValue(match.uiApiCall)}`, "ApiCall", String(match.uiApiCall), "traceability", match));
      if (match.bffEndpoint) {
        const endpointId = addNode(node(`trace:bff-endpoint:${hashValue(match.bffEndpoint)}`, "BffEndpoint", String(match.bffEndpoint), "traceability", match));
        addEdge(edge("MATCHES_ENDPOINT", apiId, endpointId, confidenceOf(match.confidence), { reason: match.matchReason }));
      }
    }
    for (const match of bffToBe) {
      const bffId = addNode(node(`trace:bff-out:${hashValue(match.bffEndpoint)}`, "BffEndpoint", String(match.bffEndpoint), "traceability", match));
      if (match.beEndpoint) {
        const beId = addNode(node(`trace:be-endpoint:${hashValue(match.beEndpoint)}`, "BeEndpoint", String(match.beEndpoint), "traceability", match));
        addEdge(edge("CALLS_ENDPOINT", bffId, beId, confidenceOf(match.confidence), { reason: match.matchReason }));
      }
    }
    for (const flow of pageFlows) {
      addNode(node(`trace:page-flow:${hashLabel(flow)}`, "PageFlow", `${flow.page ?? "Page"} ${flow.uiApiCall ?? ""}`, "traceability", flow));
    }
  }

  private buildSummary(manifest: MultiRepoManifest, nodes: KnowledgeNode[], edges: KnowledgeEdge[]): string {
    const nodesByType = countBy(nodes, (item) => item.type);
    const edgesByType = countBy(edges, (item) => item.type);
    return [
      "# Lokal Bilgi Grafiği Özeti",
      "",
      `Proje: ${manifest.projectName}`,
      `Branch: ${manifest.branch}`,
      `Oluşturulma zamanı: ${new Date().toISOString()}`,
      "",
      "## Özet",
      `- Node sayısı: ${nodes.length}`,
      `- Edge sayısı: ${edges.length}`,
      "",
      "## Node Tipleri",
      ...Object.entries(nodesByType).map(([type, count]) => `- ${type}: ${count}`),
      "",
      "## Edge Tipleri",
      ...Object.entries(edgesByType).map(([type, count]) => `- ${type}: ${count}`),
      "",
      "## Notlar",
      "- Bu grafik tamamen lokal JSONL dosyalarından üretilir.",
      "- Harici database veya vector store kullanılmaz.",
      "- Sonraki adımda Copilot/Qwen context seçimi bu graf üzerinden yapılabilir."
    ].join("\n");
  }
}

function node(id: string, type: KnowledgeNodeType, label: string, layer: KnowledgeNode["layer"], properties: Record<string, unknown>, file?: string): KnowledgeNode {
  return { id, type, label, layer, file, properties };
}

function fileNode(layer: KnowledgeNode["layer"], file: string, properties: Record<string, unknown>): KnowledgeNode {
  return node(fileNodeId(layer, file), "File", file, layer, properties, file);
}

function fileNodeId(layer: string, file: string): string {
  return safeId(`${layer}:file:${file}`);
}

function edge(type: string, from: string, to: string, confidence: KnowledgeEdge["confidence"] = "unknown", properties: Record<string, unknown> = {}): KnowledgeEdge {
  return {
    id: safeId(`${type}:${from}:${to}:${hashLabel(properties)}`),
    type,
    from,
    to,
    confidence,
    properties
  };
}

function confidenceOf(value: unknown): KnowledgeEdge["confidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : "unknown";
}

function hashLabel(value: unknown): string {
  return sha256(JSON.stringify(value)).slice(0, 16);
}

function hashValue(value: unknown): string {
  return sha256(String(value)).slice(0, 16);
}

function safeId(value: string): string {
  return safeName(value).slice(0, 160);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFor(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}
