const fs = require("fs/promises");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const aiDocsRoot = path.join(projectRoot, ".ai-docs");
const reportPath = path.join(aiDocsRoot, "dev-audits", "document-quality-assessment-report.md");

const expectedPageSections = [
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

async function main() {
  const markdownFiles = await listMarkdown(aiDocsRoot);
  const markdownFileSet = new Set(markdownFiles.map(normalize));
  const generatedDocs = markdownFiles.filter((file) => {
    if (!isGeneratedDocument(file)) {
      return false;
    }
    if (path.basename(file).toLowerCase() !== "copilot-draft.md") {
      return true;
    }
    return !markdownFileSet.has(normalize(path.join(path.dirname(file), "final-page-technical-analysis.md")));
  });
  const assessments = [];
  for (const file of generatedDocs) {
    const markdown = await fs.readFile(file, "utf8");
    assessments.push(await assess(file, markdown));
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, render(assessments), "utf8");
  if (!assessments.length) {
    console.warn(`Document quality check warning: no generated Markdown documents found. Report: ${reportPath}`);
    return;
  }
  console.log(`Document quality check completed for ${assessments.length} documents. Report: ${reportPath}`);
}

function isGeneratedDocument(file) {
  const normalized = normalize(file);
  if (normalized.includes("/dev-audits/") || normalized.endsWith("/repo-map.md")) {
    return false;
  }
  const baseName = path.basename(file).toLowerCase();
  return normalized.includes("/generated-docs/")
    || baseName === "final-page-technical-analysis.md"
    || baseName === "copilot-draft.md";
}

async function assess(file, markdown) {
  const sections = parseSections(markdown);
  const normalizedHeadings = sections.map((section) => fold(section.heading));
  const duplicates = normalizedHeadings.filter((heading, index) => normalizedHeadings.indexOf(heading) !== index);
  const isPageDocument = /^(?:final-page-technical-analysis|copilot-draft)\.md$/i.test(path.basename(file))
    || /final sayfa teknik analiz|sayfa teknik analiz/i.test(markdown.slice(0, 500));
  const requiredPresent = isPageDocument
    ? expectedPageSections.filter((heading) => normalizedHeadings.includes(fold(heading)))
    : [];
  const scorePath = path.join(path.dirname(file), "quality-score.json");
  const qualityScore = await readJsonOptional(scorePath);
  const sourceReferences = markdown.match(/src[\\/][^\s)`]+?\.(?:java|kt|ts|tsx|js|jsx|properties|ya?ml|json)/g) ?? [];
  const unresolvedPhrases = markdown.match(
    /Not visible(?: from provided context)?|Provided context[^\n]*(?:net\s+)?g(?:\u00f6|o)r(?:\u00fc|u)nm(?:\u00fc|u)yor|(?:net\s+)?g(?:\u00f6|o)r(?:\u00fc|u)nm(?:\u00fc|u)yor|belirsiz|unclear/gi
  ) ?? [];
  const apiEndpointMentions = markdown.match(
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_{}:/.${}?=&-]+|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/gi
  ) ?? [];
  return {
    file: path.relative(projectRoot, file),
    headings: sections.length,
    emptySections: sections.filter((section) => !sectionContent(section.body)).map((section) => section.heading),
    duplicateSections: [...new Set(duplicates)],
    sourceReferenceCount: sourceReferences.length,
    uniqueSourceReferenceCount: new Set(sourceReferences).size,
    unresolvedPhraseCount: unresolvedPhrases.length,
    apiEndpointMentions: apiEndpointMentions.length,
    bffMentions: (markdown.match(/\bBFF\b/gi) ?? []).length,
    backendMentions: (markdown.match(/\b(?:BE|Backend)\b/gi) ?? []).length,
    flowMentions: (markdown.match(/(?:UI\s*(?:->|\u2192|to|-)\s*BFF|BFF\s*(?:->|\u2192|to|-)\s*(?:BE|Backend)|(?:servis|service)\s*(?:->|\u2192|to|-)\s*(?:repository|repozitory))/gi) ?? []).length,
    repositoryMentions: (markdown.match(/\b(?:Repository|repozitory)\b/gi) ?? []).length,
    entityMentions: (markdown.match(/\b(?:Entity|table|tablo)\b/gi) ?? []).length,
    diagramPresent: /```[ \t]*(?:plantuml|mermaid)|@startuml/i.test(markdown),
    requiredPageSections: isPageDocument ? `${requiredPresent.length}/${expectedPageSections.length}` : "not-applicable",
    missingRequiredPageSections: isPageDocument
      ? expectedPageSections.filter((heading) => !normalizedHeadings.includes(fold(heading)))
      : [],
    qualityScoreConsistency: qualityScore.status === "valid"
      ? compareQualityScore(qualityScore.value, sourceReferences.length, markdown.length)
      : qualityScore.status === "invalid"
        ? "quality-score.json is invalid JSON"
        : "quality-score.json not present"
  };
}

function compareQualityScore(score, sourceReferences, documentLength) {
  const differences = [];
  if (!Object.prototype.hasOwnProperty.call(score, "sourceReferenceCount")) {
    differences.push("sourceReferenceCount missing from score");
  } else if (Number(score.sourceReferenceCount) !== sourceReferences) {
    differences.push(`source references file=${sourceReferences}, score=${score.sourceReferenceCount}`);
  }
  if (!Object.prototype.hasOwnProperty.call(score, "finalDocumentLength")) {
    differences.push("finalDocumentLength missing from score");
  } else if (Number(score.finalDocumentLength) !== documentLength) {
    differences.push(`length file=${documentLength}, score=${score.finalDocumentLength}`);
  }
  return differences.length ? `mismatch: ${differences.join("; ")}` : "consistent";
}

function parseSections(markdown) {
  const headings = [];
  const fencedRanges = findFencedRanges(markdown);
  for (const match of markdown.matchAll(/^(#{2,3})\s+(.+)$/gm)) {
    const start = match.index ?? 0;
    if (!fencedRanges.some((range) => start >= range.start && start < range.end)) {
      headings.push({
        start,
        end: start + match[0].length,
        level: match[1].length,
        heading: match[2].trim()
      });
    }
  }
  return headings.map((current, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= current.level);
    return {
      heading: current.heading,
      body: markdown.slice(current.end, next?.start ?? markdown.length)
    };
  });
}

function findFencedRanges(markdown) {
  const ranges = [];
  let open;
  for (const match of markdown.matchAll(/^\s*(```+|~~~+)/gm)) {
    const marker = match[1][0];
    if (!open) {
      open = { marker, start: match.index ?? 0 };
    } else if (open.marker === marker) {
      ranges.push({ start: open.start, end: (match.index ?? 0) + match[0].length });
      open = undefined;
    }
  }
  if (open) {
    ranges.push({ start: open.start, end: markdown.length });
  }
  return ranges;
}

function sectionContent(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{2,6}\s+.+$/gm, "")
    .trim();
}

function render(assessments) {
  const lines = [
    "# Document Quality Assessment Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Documents assessed: ${assessments.length}`,
    ""
  ];
  if (!assessments.length) {
    lines.push(
      "## Result",
      "",
      "No generated Markdown documents were found under `.ai-docs` outside `dev-audits`. This is a warning, not a failure.",
      "",
      "Run a local or selected-page documentation pipeline, then run this check again.",
      ""
    );
    return lines.join("\n");
  }
  for (const item of assessments) {
    lines.push(
      `## ${normalize(item.file)}`,
      "",
      `- Headings: ${item.headings}`,
      `- Required page sections: ${item.requiredPageSections}`,
      `- Missing required page sections: ${item.missingRequiredPageSections.length ? item.missingRequiredPageSections.join(", ") : "none"}`,
      `- Source references: ${item.sourceReferenceCount} (${item.uniqueSourceReferenceCount} unique)`,
      `- Unresolved phrases: ${item.unresolvedPhraseCount}`,
      `- Empty sections: ${item.emptySections.length ? item.emptySections.join(", ") : "none"}`,
      `- Duplicate sections: ${item.duplicateSections.length ? item.duplicateSections.join(", ") : "none"}`,
      `- API endpoint mentions: ${item.apiEndpointMentions}`,
      `- BFF mentions: ${item.bffMentions}`,
      `- Backend mentions: ${item.backendMentions}`,
      `- Flow mentions: ${item.flowMentions}`,
      `- Repository mentions: ${item.repositoryMentions}`,
      `- Entity/table mentions: ${item.entityMentions}`,
      `- Diagram present: ${item.diagramPresent ? "yes" : "no"}`,
      `- Quality score consistency: ${item.qualityScoreConsistency}`,
      ""
    );
  }
  lines.push(
    "## Limitations",
    "",
    "This harness checks document structure and source-grounding signals. It does not use AI and does not prove semantic correctness.",
    ""
  );
  return lines.join("\n");
}

async function listMarkdown(root) {
  const result = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        result.push(full);
      }
    }
  }
  await walk(root);
  return result;
}

async function readJsonOptional(file) {
  try {
    return { status: "valid", value: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "invalid" };
  }
}

function normalize(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function fold(value) {
  return value.toLowerCase()
    .replace(/\u0131/g, "i").replace(/\u011f/g, "g").replace(/\u00fc/g, "u")
    .replace(/\u015f/g, "s").replace(/\u00f6/g, "o").replace(/\u00e7/g, "c")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
