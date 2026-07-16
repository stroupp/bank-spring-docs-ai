export interface PageFlowDiagramArtifacts {
  markdown: string;
  svg: string;
  flowCount: number;
}

interface DiagramFlow {
  uiCall?: string;
  bffEndpoint?: string;
  bffClient?: string;
  beEndpoint?: string;
  dataTarget?: string;
  confidence?: string;
}

const maximumDiagramFlows = 8;

/** Builds evidence-bound diagrams locally; it never requires another model call. */
export class PageFlowDiagramBuilder {
  build(pageFlow: Record<string, unknown>, svgFileName = "page-flow-uml.svg"): PageFlowDiagramArtifacts {
    const selectedPage = asRecord(pageFlow.selectedPage);
    const pageName = cleanLabel(String(selectedPage.pageName ?? "Selected page"));
    const route = cleanLabel(String(selectedPage.route ?? ""));
    const flows = collectFlows(pageFlow).slice(0, maximumDiagramFlows);
    const markdown = buildMarkdown(pageName, route, flows, svgFileName);
    return {
      markdown,
      svg: buildSvg(pageName, route, flows),
      flowCount: flows.length
    };
  }
}

function collectFlows(pageFlow: Record<string, unknown>): DiagramFlow[] {
  const bffMatches = asRecords(pageFlow.bffToBeMatches);
  const serviceFlows = asRecords(pageFlow.beServiceFlows);
  const primary = asRecords(pageFlow.pageFlows).map((record) => {
    const bffEndpoint = stringValue(record.bffEndpoint);
    const beEndpoint = stringValue(record.beEndpoint);
    const bffMatch = bffMatches.find((candidate) => sameValue(candidate.bffEndpoint, bffEndpoint));
    const serviceFlow = serviceFlows.find((candidate) => sameValue(candidate.endpoint, beEndpoint));
    return {
      uiCall: stringValue(record.uiApiCall),
      bffEndpoint,
      bffClient: stringValue(bffMatch?.bffClient),
      beEndpoint,
      dataTarget: dataTarget(record, serviceFlow),
      confidence: stringValue(record.confidence ?? bffMatch?.confidence)
    } satisfies DiagramFlow;
  });

  const fallback = primary.length ? [] : bffMatches.map((record) => {
    const beEndpoint = stringValue(record.beEndpoint);
    const serviceFlow = serviceFlows.find((candidate) => sameValue(candidate.endpoint, beEndpoint));
    return {
      bffEndpoint: stringValue(record.bffEndpoint),
      bffClient: stringValue(record.bffClient),
      beEndpoint,
      dataTarget: dataTarget(record, serviceFlow),
      confidence: stringValue(record.confidence)
    } satisfies DiagramFlow;
  });

  const seen = new Set<string>();
  return [...primary, ...fallback]
    .map(normalizeFlow)
    .filter((flow) => flow.uiCall || flow.bffEndpoint || flow.beEndpoint || flow.dataTarget)
    .sort((left, right) => flowKey(left).localeCompare(flowKey(right)))
    .filter((flow) => {
      const key = flowKey(flow);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function normalizeFlow(flow: DiagramFlow): DiagramFlow {
  return Object.fromEntries(
    Object.entries(flow)
      .map(([key, value]) => [key, value ? cleanLabel(value) : undefined])
      .filter(([, value]) => Boolean(value))
  ) as DiagramFlow;
}

function dataTarget(record: Record<string, unknown>, serviceFlow?: Record<string, unknown>): string | undefined {
  const repositories = stringArray(serviceFlow?.repositoryMethods ?? record.repositoryMethods);
  const entities = stringArray(serviceFlow?.entities ?? record.entities);
  const tables = stringArray(record.tables);
  return [...repositories, ...entities, ...tables].slice(0, 3).join(" / ") || undefined;
}

function buildMarkdown(pageName: string, route: string, flows: DiagramFlow[], svgFileName: string): string {
  const diagramLines = [
    "flowchart LR",
    `  UI[\"UI: ${mermaidLabel([pageName, route].filter(Boolean).join(" · "))}\"]`,
    "  BFF[\"BFF\"]",
    "  BE[\"Backend\"]",
    "  DATA[\"Repository / Entity\"]"
  ];
  const sequenceLines = [
    "sequenceDiagram",
    `  participant UI as ${mermaidSequenceLabel(pageName)}`,
    "  participant BFF as BFF",
    "  participant BE as Backend",
    "  participant DATA as Repository / Entity"
  ];

  if (!flows.length) {
    diagramLines.push("  UI -.->|grounded downstream match unavailable| BFF");
    sequenceLines.push("  Note over UI,DATA: page-flow.json içinde eşleşmiş uçtan uca akış bulunamadı");
  }
  for (const flow of flows) {
    const confidence = flow.confidence ? ` [${flow.confidence}]` : "";
    if (flow.uiCall && flow.bffEndpoint) {
      diagramLines.push(`  UI -->|\"${mermaidLabel(flow.uiCall)}\"| BFF`);
      sequenceLines.push(`  UI->>BFF: ${mermaidSequenceLabel(flow.uiCall)}${mermaidSequenceLabel(confidence)}`);
    }
    if (flow.bffEndpoint && flow.beEndpoint) {
      const client = flow.bffClient ? ` via ${flow.bffClient}` : "";
      diagramLines.push(`  BFF -->|\"${mermaidLabel(`${flow.beEndpoint}${client}`)}\"| BE`);
      sequenceLines.push(`  BFF->>BE: ${mermaidSequenceLabel(`${flow.beEndpoint}${client}${confidence}`)}`);
    }
    if (flow.beEndpoint && flow.dataTarget) {
      diagramLines.push(`  BE -->|\"${mermaidLabel(flow.dataTarget)}\"| DATA`);
      sequenceLines.push(`  BE->>DATA: ${mermaidSequenceLabel(`${flow.dataTarget}${confidence}`)}`);
    }
  }

  return [
    "## UML ve Akış Diyagramları",
    "",
    "Bu diyagramlar Qwen tarafından tahmin edilmez; `page-flow.json` içindeki deterministik eşleşmelerden yerel olarak üretilir.",
    "",
    `![UI-BFF-BE UML akışı](./${encodeURI(svgFileName)})`,
    "",
    "### Bileşen Diyagramı",
    "",
    "```mermaid",
    ...diagramLines,
    "```",
    "",
    "### Uçtan Uca Sequence Diyagramı",
    "",
    "```mermaid",
    ...sequenceLines,
    "```"
  ].join("\n");
}

function buildSvg(pageName: string, route: string, flows: DiagramFlow[]): string {
  const rowHeight = 74;
  const headerHeight = 106;
  const rows = Math.max(1, flows.length);
  const height = headerHeight + rows * rowHeight + 36;
  const columns = [20, 315, 610, 905];
  const width = 1180;
  const boxWidth = 255;
  const boxHeight = 46;
  const headers = [
    `UI: ${[pageName, route].filter(Boolean).join(" · ")}`,
    "BFF endpoint / client",
    "Backend endpoint",
    "Repository / entity"
  ];
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 ${width} ${height}">`,
    `<title id="title">UI BFF Backend UML flow for ${xml(pageName)}</title>`,
    `<desc id="desc">Deterministic page flow generated from page-flow.json</desc>`,
    `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#6b7280"/></marker></defs>`,
    `<rect width="100%" height="100%" rx="12" fill="#ffffff" stroke="#d1d5db"/>`,
    `<text x="20" y="28" font-family="Segoe UI,Arial,sans-serif" font-size="19" font-weight="600" fill="#111827">UI → BFF → Backend kanıt akışı</text>`,
    `<text x="20" y="50" font-family="Segoe UI,Arial,sans-serif" font-size="12" fill="#4b5563">Kaynak: page-flow.json · En fazla ${maximumDiagramFlows} eşleşme gösterilir</text>`
  ];
  headers.forEach((header, index) => {
    parts.push(svgBox(columns[index], 64, boxWidth, 34, header, "#e0f2fe", "#0369a1", true));
  });

  if (!flows.length) {
    parts.push(svgBox(columns[0], headerHeight, boxWidth, boxHeight, pageName, "#f8fafc", "#475569"));
    parts.push(`<text x="315" y="${headerHeight + 28}" font-family="Segoe UI,Arial,sans-serif" font-size="13" fill="#92400e">Eşleşmiş downstream akış görünmüyor.</text>`);
  } else {
    flows.forEach((flow, rowIndex) => {
      const y = headerHeight + rowIndex * rowHeight;
      const labels = [
        flow.uiCall ?? "UI call görünmüyor",
        [flow.bffEndpoint, flow.bffClient].filter(Boolean).join(" · ") || "BFF eşleşmesi yok",
        flow.beEndpoint ?? "BE eşleşmesi yok",
        flow.dataTarget ?? "Data flow görünmüyor"
      ];
      const confidenceColor = /low|unmatched/i.test(flow.confidence ?? "") ? "#fef2f2" : "#f8fafc";
      labels.forEach((label, index) => {
        parts.push(svgBox(columns[index], y, boxWidth, boxHeight, label, confidenceColor, "#334155"));
      });
      if (flow.uiCall && flow.bffEndpoint) {
        parts.push(svgArrow(columns[0] + boxWidth, y + 23, columns[1], y + 23));
      }
      if (flow.bffEndpoint && flow.beEndpoint) {
        parts.push(svgArrow(columns[1] + boxWidth, y + 23, columns[2], y + 23));
      }
      if (flow.beEndpoint && flow.dataTarget) {
        parts.push(svgArrow(columns[2] + boxWidth, y + 23, columns[3], y + 23));
      }
      if (flow.confidence) {
        parts.push(`<text x="${columns[0]}" y="${y + 62}" font-family="Segoe UI,Arial,sans-serif" font-size="11" fill="#64748b">confidence: ${xml(flow.confidence)}</text>`);
      }
    });
  }
  parts.push("</svg>");
  return parts.join("\n");
}

function svgBox(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  fill: string,
  textColor: string,
  bold = false
): string {
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" fill="${fill}" stroke="#cbd5e1"/>`,
    `<text x="${x + 10}" y="${y + Math.round(height / 2) + 5}" font-family="Segoe UI,Arial,sans-serif" font-size="12"${bold ? " font-weight=\"600\"" : ""} fill="${textColor}">${xml(shorten(label, 42))}</text>`
  ].join("");
}

function svgArrow(startX: number, startY: number, endX: number, endY: number): string {
  return `<line x1="${startX + 4}" y1="${startY}" x2="${endX - 7}" y2="${endY}" stroke="#6b7280" stroke-width="1.6" marker-end="url(#arrow)"/>`;
}

function flowKey(flow: DiagramFlow): string {
  return [flow.uiCall, flow.bffEndpoint, flow.bffClient, flow.beEndpoint, flow.dataTarget, flow.confidence]
    .map((value) => value ?? "")
    .join("\u0000");
}

function cleanLabel(value: string): string {
  return value
    .replace(/%%\s*\{/g, "% {")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function mermaidLabel(value: string): string {
  return cleanLabel(value)
    .replace(/&/g, "and")
    .replace(/["`<>]/g, "'")
    .replace(/[\[{]/g, "(")
    .replace(/[\]}]/g, ")");
}

function mermaidSequenceLabel(value: string): string {
  return mermaidLabel(value).replace(/:/g, " -").replace(/;/g, ",");
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.trim();
  return cleaned || undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function sameValue(left: unknown, right: string | undefined): boolean {
  return Boolean(right) && stringValue(left)?.toLowerCase() === right?.toLowerCase();
}
