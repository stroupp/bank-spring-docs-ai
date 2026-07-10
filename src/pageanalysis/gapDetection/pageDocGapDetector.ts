import * as fs from "fs/promises";
import * as path from "path";
import { writeJsonl } from "../../storage/jsonlWriter";
import { sha256 } from "../../utils/hash";

export type PageDocGap = {
  id: string;
  pageName: string;
  section: string;
  gapType:
    | "not-visible"
    | "missing-parameter"
    | "missing-validation"
    | "missing-bff-match"
    | "missing-be-match"
    | "missing-service-flow"
    | "missing-repository-entity"
    | "missing-source-reference"
    | "generic-statement"
    | "empty-section";
  description: string;
  suggestedEvidence: string[];
  severity: "high" | "medium" | "low";
};

const requiredSections = [
  "Sayfa Amaci",
  "Route ve Ana Component",
  "Kullanilan Alt Componentler",
  "Kritik Kullanici Aksiyonlari",
  "Form Alanlari ve Parametreler",
  "UI State Yonetimi",
  "UI API Cagrilari",
  "BFF Endpoint Eslesmesi",
  "BFF Sorumluluklari",
  "Backend Endpoint Eslesmesi",
  "Backend Servis / Repository / Entity Akisi",
  "DTO ve Model Kullanimi",
  "Validasyon ve Hata Yonetimi",
  "Guvenlik Gozlemleri",
  "Degisiklik Etkisi ve Riskler",
  "Kaynak Referanslari",
  "Belirsizlikler"
];

export class PageDocGapDetector {
  async detect(pageRoot: string, multiRepoRoot: string): Promise<PageDocGap[]> {
    const draftPath = path.join(pageRoot, "copilot-draft.md");
    const draft = await fs.readFile(draftPath, "utf8");
    const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
    const pageName = String((pageFlow.selectedPage as Record<string, unknown> | undefined)?.pageName ?? path.basename(pageRoot));
    const sections = splitSections(draft);
    const gaps: PageDocGap[] = [];

    for (const section of requiredSections) {
      const body = sections.get(normalizeHeading(section)) ?? "";
      if (!body.trim()) {
        gaps.push(gap(pageName, section, "empty-section", `${section} bolumu bos veya bulunamadi.`, ["page-context-pack.md", "page-evidence-pack.md"], "high"));
      }
    }

    for (const [section, body] of sections.entries()) {
      if (/Not visible|Provided context|unclear|belirsiz|gorunmuyor|görünmüyor/i.test(body)) {
        gaps.push(gap(pageName, section, "not-visible", "Bolumde gorunmeyen veya belirsiz bilgi var.", evidenceForSection(section), "medium"));
      }
      if (/parametre|parameter|formalan/i.test(section) && !/src[\\/].+\.(tsx|ts|jsx|js|java)/i.test(body)) {
        gaps.push(gap(pageName, section, "missing-source-reference", "Parametre/form bolumu kaynak referansi icermiyor.", ["page-evidence-pack.md"], "medium"));
      }
    }

    if (sourceReferenceCount(draft) < 3) {
      gaps.push(gap(pageName, "Kaynak Referanslari", "missing-source-reference", "Dokumanda yeterli kaynak referansi yok.", ["page-evidence-pack.md"], "high"));
    }

    await fs.writeFile(path.join(pageRoot, "detected-gaps.json"), `${JSON.stringify(gaps, null, 2)}\n`, "utf8");
    await appendGapAudit(multiRepoRoot, gaps);
    return gaps;
  }
}

function gap(pageName: string, section: string, gapType: PageDocGap["gapType"], description: string, suggestedEvidence: string[], severity: PageDocGap["severity"]): PageDocGap {
  return {
    id: sha256(`${pageName}:${section}:${gapType}:${description}`).slice(0, 12),
    pageName,
    section,
    gapType,
    description,
    suggestedEvidence,
    severity
  };
}

function splitSections(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    result.set(normalizeHeading(current[1]), markdown.slice((current.index ?? 0) + current[0].length, next?.index ?? markdown.length).trim());
  }
  return result;
}

function evidenceForSection(section: string): string[] {
  if (/bff/i.test(section)) {
    return ["page-context-pack.md", "page-evidence-pack.md", "bff/api-endpoints.jsonl", "bff/outbound-calls.jsonl"];
  }
  if (/backend|repository|entity|servis/i.test(section)) {
    return ["page-context-pack.md", "page-evidence-pack.md", "be/service-flow-index.jsonl", "be/entity-index.jsonl"];
  }
  if (/validasyon|parametre|form/i.test(section)) {
    return ["page-evidence-pack.md", "ui/form-field-index.jsonl", "be/validation-index.jsonl"];
  }
  return ["page-context-pack.md", "page-evidence-pack.md"];
}

function sourceReferenceCount(markdown: string): number {
  return (markdown.match(/src[\\/][^\s)`]+?\.(?:java|ts|tsx|js|jsx|properties|ya?ml|json)/g) ?? []).length;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function appendGapAudit(multiRepoRoot: string, gaps: PageDocGap[]): Promise<void> {
  const target = path.join(multiRepoRoot, "gap-repair", "detected-gaps.jsonl");
  const existing = await readExistingJsonl(target);
  await writeJsonl(target, [...existing, ...gaps.map((item) => ({ ...item, timestamp: new Date().toISOString() }))]);
}

async function readExistingJsonl(filePath: string): Promise<unknown[]> {
  try {
    return (await fs.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizeHeading(value: string): string {
  return foldToAscii(value)
    .replace(/^\s*\d+[\).\-\s]+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function foldToAscii(value: string): string {
  return value
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
