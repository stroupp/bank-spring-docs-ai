import * as fs from "fs/promises";
import * as path from "path";

export interface FinalPageDocumentResult {
  finalDocumentPath: string;
}

export class FinalPageDocumentBuilder {
  async build(pageRoot: string): Promise<FinalPageDocumentResult> {
    const pageFlow = await readJson(path.join(pageRoot, "page-flow.json"));
    const selectedPage = pageFlow.selectedPage as Record<string, unknown> | undefined;
    const draftStale = await staleDependenciesFor(pageRoot, "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"]);
    const repairStale = await staleDependenciesFor(pageRoot, "repaired-sections.md", ["detected-gaps.json", "page-context-pack.md", "page-evidence-pack.md", "copilot-draft.md"]);
    const draft = draftStale.length ? "" : await readOptional(path.join(pageRoot, "copilot-draft.md"));
    const repaired = repairStale.length ? "" : await readOptional(path.join(pageRoot, "repaired-sections.md"));
    const mergedBody = mergeRepairedSections(draft, repaired);
    const qwenAvailable = Boolean(await readOptional(path.join(pageRoot, "qwen-page-semantics.json")));
    const finalDocumentPath = path.join(pageRoot, "final-page-technical-analysis.md");
    const content = [
      "# Final Sayfa Teknik Analiz Dokumani",
      "",
      `Sayfa: ${selectedPage?.pageName ?? path.basename(pageRoot)}`,
      `Route: ${selectedPage?.route ?? "Not visible from provided context."}`,
      `Olusturulma zamani: ${new Date().toISOString()}`,
      `Qwen semantik mevcut: ${qwenAvailable ? "evet" : "hayir"}`,
      draftStale.length ? `Copilot draft atlandi: ${draftStale.join(", ")} dosyalarindan eski.` : "",
      repairStale.length ? `Repaired sections atlandi: ${repairStale.join(", ")} dosyalarindan eski.` : "",
      `Evidence pack: ${path.join(pageRoot, "page-evidence-pack.md")}`,
      `Quality score: ${path.join(pageRoot, "quality-score.json")}`,
      "",
      "---",
      "",
      mergedBody || "Provided context icinde net gorunmuyor.",
      "",
      "## Final Not",
      "- Bu final dokuman taslak ve varsa repaired sections ciktilarindan olusturuldu.",
      "- Desteklenmeyen bilgilerin eklenmemesi icin kaynak/context referanslari korunmalidir."
    ].filter(Boolean).join("\n");
    await backupExisting(finalDocumentPath);
    await fs.writeFile(finalDocumentPath, content, "utf8");
    return { finalDocumentPath };
  }
}

function mergeRepairedSections(draft: string, repaired: string): string {
  if (!draft || !repaired) {
    return draft || repaired;
  }

  let merged = draft;
  const unmatched: string[] = [];
  const replaced = new Set<string>();
  for (const section of splitSections(repaired)) {
    if (replaced.has(section.normalizedHeading)) {
      continue;
    }
    const draftSection = findSection(merged, section.normalizedHeading);
    if (draftSection) {
      merged = `${merged.slice(0, draftSection.start)}${section.text.trim()}\n\n${merged.slice(draftSection.end).trimStart()}`;
      replaced.add(section.normalizedHeading);
    } else {
      unmatched.push(section.text.trim());
    }
  }

  if (unmatched.length) {
    merged = `${merged.trimEnd()}\n\n---\n\n## Ek Onarim Notlari\n\n${unmatched.join("\n\n")}\n`;
  }
  return merged;
}

function splitSections(markdown: string): Array<{ normalizedHeading: string; text: string }> {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((current, index) => {
    const next = matches[index + 1];
    return {
      normalizedHeading: normalizeHeading(current[1]),
      text: markdown.slice(current.index ?? 0, next?.index ?? markdown.length).trim()
    };
  }).filter((section) => section.normalizedHeading);
}

function findSection(markdown: string, normalizedHeading: string): { start: number; end: number } | undefined {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    if (normalizeHeading(current[1]) === normalizedHeading) {
      return {
        start: current.index ?? 0,
        end: matches[index + 1]?.index ?? markdown.length
      };
    }
  }
  return undefined;
}

function normalizeHeading(value: string): string {
  return foldToAscii(value)
    .replace(/^\s*\d+[\).\-\s]+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function foldToAscii(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u011f/g, "g")
    .replace(/\u00fc/g, "u")
    .replace(/\u015f/g, "s")
    .replace(/\u00f6/g, "o")
    .replace(/\u00e7/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function backupExisting(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  } catch {
    // No previous final document exists yet.
  }
}

async function staleDependenciesFor(pageRoot: string, fileName: string, dependencies: string[]): Promise<string[]> {
  const target = await statOptional(path.join(pageRoot, fileName));
  if (!target) {
    return [];
  }
  const stale: string[] = [];
  for (const dependency of dependencies) {
    const dependencyStat = await statOptional(path.join(pageRoot, dependency));
    if (dependencyStat && target.mtimeMs < dependencyStat.mtimeMs) {
      stale.push(dependency);
    }
  }
  return stale;
}

async function statOptional(filePath: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
