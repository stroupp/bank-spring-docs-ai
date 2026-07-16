const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");

const settings = { "copilot.maxContextCharacters": 900 };
let networkCalls = 0;
let languageModelSelections = 0;

const vscodeMock = {
  workspace: {
    getConfiguration() {
      return {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
        }
      };
    }
  },
  lm: {
    async selectChatModels() {
      languageModelSelections += 1;
      throw new Error("Qwen gap-repair tests attempted VS Code LM access");
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeMock;
  }
  return originalLoad.apply(this, arguments);
};

global.fetch = async () => {
  networkCalls += 1;
  throw new Error("Qwen gap-repair tests attempted a network call");
};

const { buildRepairContext } = require("../dist/pageanalysis/gapRepair/pageGapEvidenceSelector");
const { buildPageGapRepairPlan } = require("../dist/pageanalysis/gapRepair/pageGapRepairPlanner");
const { PageSectionRegenerator } = require("../dist/pageanalysis/gapRepair/pageSectionRegenerator");
const { FinalPageDocumentBuilder } = require("../dist/pageanalysis/finalPageDocumentBuilder");

const token = {
  isCancellationRequested: false,
  onCancellationRequested() { return { dispose() {} }; }
};

function usage() {
  return {
    inputCharacters: 100,
    outputCharacters: 50,
    estimatedInputTokens: 25,
    estimatedOutputTokens: 13,
    estimatedTotalTokens: 38,
    promptTokens: 25,
    completionTokens: 13,
    totalTokens: 38
  };
}

function model(id, name = id, family = id) {
  return {
    id,
    name,
    vendor: "test",
    family,
    version: "test",
    maxInputTokens: 131072
  };
}

async function writeGroupedRepairFixture(pageRoot, gaps) {
  await fs.mkdir(pageRoot, { recursive: true });
  const sections = [...new Set(gaps.map((gap) => gap.section))];
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), "Grouped repair context", "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), [
    "# Page Evidence Pack",
    ...sections.flatMap((section) => [
      `## ${section}`,
      `${section} evidence src/main/java/example/GroupedRepair.java`
    ])
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "copilot-draft.md"), sections.flatMap((section) => [
    `## ${section}`,
    `Weak ${section} draft src/main/java/example/GroupedRepair.java`
  ]).join("\n\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "detected-gaps.json"), JSON.stringify(gaps), "utf8");
}

async function testGroupedQwenRepair(multiRepoRoot) {
  const pageRoot = path.join(multiRepoRoot, "page-analysis", "pages", "grouped-repair");
  const sectionNames = [
    "Guvenlik Gozlemleri",
    "Backend Endpoint Eslesmesi",
    "Belirsizlikler",
    "BFF Endpoint Eslesmesi",
    "Validasyon ve Hata Yonetimi"
  ];
  const gaps = sectionNames.map((section, index) => ({
    id: `group-gap-${index + 1}`,
    pageName: "GroupedRepair",
    section,
    gapType: "not-visible",
    description: `${section} needs bounded repair.`,
    suggestedEvidence: ["page-evidence-pack.md"],
    severity: "medium"
  }));
  await writeGroupedRepairFixture(pageRoot, gaps);

  const calls = [];
  const client = {
    provider: "qwen",
    async send(prompt) {
      const targetBlock = prompt.userPrompt.match(/<TARGET_SECTIONS>\n([\s\S]*?)\n<\/TARGET_SECTIONS>/)?.[1] ?? "";
      const targets = [...targetBlock.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]);
      calls.push({ prompt, targets });
      return {
        text: [
          ...targets.slice().reverse().flatMap((section) => [
            `## ${section}`,
            `Repaired ${section} with src/main/java/example/GroupedRepair.java.`
          ]),
          "## Untargeted Model Section",
          "This section must not enter the canonical repair artifact."
        ].join("\n\n"),
        usage: usage(),
        model: model("local/qwen3-32b", "Qwen3 32B", "qwen3"),
        provider: "qwen"
      };
    }
  };

  settings["qwen.generationMaxTokens"] = 4000;
  try {
    await new PageSectionRegenerator(client, {
      mode: "qwen3",
      maxInputCharacters: 9000,
      expectedModelMarker: "qwen3"
    }).repair(multiRepoRoot, pageRoot, token);
  } finally {
    delete settings["qwen.generationMaxTokens"];
  }

  assert.strictEqual(calls.length, 5, "quality-sensitive Qwen repair must isolate every target section");
  assert.ok(calls.every((call) => call.targets.length === 1));
  assert.ok(calls.every((call) => call.prompt.combinedText.length <= 9000));
  assert.deepStrictEqual(
    calls.map((call) => call.prompt.maxOutputTokens),
    [4000, 4000, 4000, 4000, 4000],
    "each isolated section must receive the complete configured synthesis ceiling"
  );
  const repaired = await fs.readFile(path.join(pageRoot, "repaired-sections.md"), "utf8");
  const expectedHeadings = [
    "BFF Endpoint E\u015fle\u015fmesi",
    "Backend Endpoint E\u015fle\u015fmesi",
    "Validasyon ve Hata Y\u00f6netimi",
    "G\u00fcvenlik G\u00f6zlemleri",
    "Belirsizlikler"
  ];
  const actualHeadings = [...repaired.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]);
  assert.deepStrictEqual(actualHeadings, expectedHeadings, "group outputs must be assembled in canonical page-section order");
  assert.doesNotMatch(repaired, /Untargeted Model Section/);

  const audits = (await fs.readFile(path.join(multiRepoRoot, "gap-repair", "repair-audit.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const audit = audits.at(-1);
  assert.strictEqual(audit.status, "success");
  assert.strictEqual(audit.groupCount, 5);
  assert.strictEqual(audit.completedGroupCount, 5);
  assert.strictEqual(audit.requestCount, 5);
  assert.strictEqual(audit.maxOutputTokens, 4000);
  assert.deepStrictEqual(audit.requestOutputTokenBudgets, [4000, 4000, 4000, 4000, 4000]);
  assert.strictEqual(audit.estimatedTotalTokens, 190);
  assert.strictEqual(audit.canonicalOutputPaths.length, 5);
  for (const relativePath of [...audit.rawOutputPaths, ...audit.canonicalOutputPaths]) {
    await fs.access(path.join(multiRepoRoot, relativePath));
  }
}

async function testGroupedQwenCancellation(multiRepoRoot) {
  const pageRoot = path.join(multiRepoRoot, "page-analysis", "pages", "cancelled-grouped-repair");
  const gaps = ["BFF Endpoint Eslesmesi", "Backend Endpoint Eslesmesi", "Guvenlik Gozlemleri"].map((section, index) => ({
    id: `cancel-gap-${index + 1}`,
    pageName: "CancelledGroupedRepair",
    section,
    gapType: "not-visible",
    description: `${section} needs repair.`,
    suggestedEvidence: ["page-evidence-pack.md"],
    severity: "medium"
  }));
  await writeGroupedRepairFixture(pageRoot, gaps);
  const cancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested() { return { dispose() {} }; }
  };
  let calls = 0;
  const client = {
    provider: "qwen",
    async send(prompt) {
      calls += 1;
      const target = prompt.userPrompt.match(/<TARGET_SECTIONS>\n##\s+(.+)\n<\/TARGET_SECTIONS>/)?.[1] ?? "Belirsizlikler";
      cancellationToken.isCancellationRequested = true;
      return {
        text: `## ${target}\nUseful completed output before cancellation.`,
        usage: usage(),
        model: model("local/qwen3-32b", "Qwen3 32B", "qwen3"),
        provider: "qwen"
      };
    }
  };

  await assert.rejects(
    () => new PageSectionRegenerator(client, {
      mode: "qwen3",
      maxInputCharacters: 9000,
      maxOutputTokens: 2000
    }).repair(multiRepoRoot, pageRoot, cancellationToken),
    /cancelled by the user/i
  );
  assert.strictEqual(calls, 1, "cancellation after a completed response must prevent the next group request");
  const audits = (await fs.readFile(path.join(multiRepoRoot, "gap-repair", "repair-audit.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const audit = audits.at(-1);
  assert.strictEqual(audit.status, "cancelled");
  assert.strictEqual(audit.completedGroupCount, 1);
  assert.strictEqual(audit.requestCount, 1);
  assert.strictEqual(audit.rawOutputPaths.length, 1);
  assert.strictEqual(audit.canonicalOutputPaths.length, 1);
  await fs.access(path.join(multiRepoRoot, audit.rawOutputPaths[0]));
  await fs.access(path.join(multiRepoRoot, audit.canonicalOutputPaths[0]));
}

async function testMissingQwenRepairPreservesOriginalDraft(multiRepoRoot) {
  const pageRoot = path.join(multiRepoRoot, "page-analysis", "pages", "missing-group-heading");
  const gaps = ["BFF Endpoint Eslesmesi", "Backend Endpoint Eslesmesi"].map((section, index) => ({
    id: `missing-heading-gap-${index + 1}`,
    pageName: "MissingHeading",
    section,
    gapType: "not-visible",
    description: `${section} needs repair.`,
    suggestedEvidence: ["page-evidence-pack.md"],
    severity: "medium"
  }));
  await writeGroupedRepairFixture(pageRoot, gaps);

  let calls = 0;
  const client = {
    provider: "qwen",
    async send(prompt) {
      calls += 1;
      const target = prompt.userPrompt.match(/<TARGET_SECTIONS>\n##\s+(.+)\n<\/TARGET_SECTIONS>/)?.[1];
      const text = calls === 1
        ? `## ${target}\nRepaired first section src/main/java/example/GroupedRepair.java.`
        : "## Untargeted Model Heading\nThis must not replace the original backend section.";
      return {
        text,
        usage: usage(),
        model: model("local/qwen3-32b", "Qwen3 32B", "qwen3"),
        provider: "qwen"
      };
    }
  };

  const result = await new PageSectionRegenerator(client, {
    mode: "qwen3",
    maxInputCharacters: 9000,
    maxOutputTokens: 4000
  }).repair(multiRepoRoot, pageRoot, token);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(result.missingSections, ["Backend Endpoint Eşleşmesi"]);
  const repaired = await fs.readFile(result.repairedSectionsPath, "utf8");
  assert.match(repaired, /^## BFF Endpoint Eşleşmesi$/m);
  assert.doesNotMatch(repaired, /^## Backend Endpoint Eşleşmesi$/m, "missing model headings must be omitted from the merge artifact");
  assert.doesNotMatch(repaired, /Untargeted Model Heading/);

  const finalResult = await new FinalPageDocumentBuilder().build(pageRoot);
  const finalDocument = await fs.readFile(finalResult.finalDocumentPath, "utf8");
  assert.match(finalDocument, /Repaired first section/);
  assert.match(
    finalDocument,
    /Weak Backend Endpoint Eslesmesi draft/,
    "a missing repair must preserve the useful original draft section"
  );
}

async function main() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-spring-qwen-gap-"));
  const pageRoot = path.join(multiRepoRoot, "page-analysis", "pages", "complex-page");
  await fs.mkdir(pageRoot, { recursive: true });

  const gaps = [{
    id: "gap-backend",
    pageName: "ComplexPage",
    section: "Backend Endpoint Eslesmesi",
    gapType: "not-visible",
    description: "Backend endpoint evidence is incomplete.",
    suggestedEvidence: ["page-evidence-pack.md", "be/service-flow-index.jsonl"],
    severity: "high"
  }];
  const plan = buildPageGapRepairPlan(gaps);
  const pageContext = `CONTEXT_HEAD_SENTINEL\n${"C".repeat(7000)}\nCONTEXT_TAIL_SENTINEL`;
  const pageEvidence = [
    "# Page Evidence Pack",
    "## Backend Endpoint Evidence",
    "EVIDENCE_RELEVANT_SENTINEL src/backend/ComplexController.java",
    "E".repeat(5000),
    "## React Route Evidence",
    "ROUTE_IRRELEVANT_SENTINEL",
    "R".repeat(3000)
  ].join("\n");
  const pageSemantics = JSON.stringify({ backend: "SEMANTICS_SENTINEL", payload: "S".repeat(3000) });
  const interactionSemantics = JSON.stringify({ interaction: "INTERACTION_SENTINEL", payload: "I".repeat(2000) });
  const draft = [
    "## Sayfa Amaci",
    "DRAFT_IRRELEVANT_SENTINEL",
    "X".repeat(6000),
    "## Backend Endpoint Eslesmesi",
    "TARGET_DRAFT_SENTINEL src/backend/ComplexController.java",
    "T".repeat(3000)
  ].join("\n");

  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), pageContext, "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), pageEvidence, "utf8");
  await fs.writeFile(path.join(pageRoot, "qwen-page-semantics.json"), pageSemantics, "utf8");
  await fs.writeFile(path.join(pageRoot, "qwen-interaction-semantics.jsonl"), interactionSemantics, "utf8");
  await fs.writeFile(path.join(pageRoot, "copilot-draft.md"), draft, "utf8");
  await fs.writeFile(path.join(pageRoot, "detected-gaps.json"), JSON.stringify(gaps), "utf8");

  const legacyFull = [
    ["Detected Gaps", JSON.stringify(plan.gaps, null, 2)],
    ["Target Sections", plan.targetSections.map((section) => `- ${section}`).join("\n")],
    ["Suggested Evidence", plan.evidenceFiles.map((file) => `- ${file}`).join("\n")],
    ["Page Context Pack", pageContext],
    ["Page Evidence Pack", pageEvidence],
    ["Qwen Page Semantics", pageSemantics],
    ["Qwen Interaction Semantics", interactionSemantics],
    ["Copilot Draft", draft]
  ]
    .filter(([, content]) => Boolean(content))
    .map(([title, content]) => `## ${title}\n${content}`)
    .join("\n\n---\n\n");
  settings["copilot.maxContextCharacters"] = 100000;
  assert.ok(
    (await buildRepairContext(pageRoot, plan)).includes("## Copilot Draft"),
    "the optionless context must preserve the established Copilot Draft heading"
  );
  settings["copilot.maxContextCharacters"] = 900;
  const expectedLegacy = `${legacyFull.slice(0, settings["copilot.maxContextCharacters"])}\n[REPAIR_CONTEXT_TRUNCATED_FOR_TOKEN_LIMIT]`;
  assert.strictEqual(
    await buildRepairContext(pageRoot, plan),
    expectedLegacy,
    "the optionless path must retain the exact legacy ordering and head truncation"
  );

  const qwenContext = await buildRepairContext(pageRoot, plan, {
    mode: "qwen3-target-first",
    maxCharacters: 8000
  });
  assert.ok(qwenContext.length <= 8000, "Qwen repair context must obey its exact character ceiling");
  assert.ok(qwenContext.includes("TARGET_DRAFT_SENTINEL"), "target draft evidence must survive a large unrelated draft");
  assert.ok(!qwenContext.includes("DRAFT_IRRELEVANT_SENTINEL"), "unrelated draft sections should not consume target repair budget");
  assert.ok(qwenContext.includes("EVIDENCE_RELEVANT_SENTINEL"), "relevant page evidence must receive a protected budget share");
  assert.ok(qwenContext.indexOf("Current AI Draft - Target Sections") < qwenContext.indexOf("Relevant Page Evidence"));
  assert.ok(qwenContext.indexOf("Relevant Page Evidence") < qwenContext.indexOf("Page Context Pack"));

  const legacyRaw = "```markdown\n## Legacy Raw\npassword=legacy-secret\n```";
  let legacyPrompt;
  const legacyClient = {
    provider: "copilot",
    async send(prompt) {
      legacyPrompt = prompt;
      return { text: legacyRaw, usage: usage(), model: model("copilot-test"), provider: "copilot" };
    }
  };
  await new PageSectionRegenerator(legacyClient).repair(multiRepoRoot, pageRoot, token);
  assert.strictEqual(legacyPrompt.instructions, [
    "You are a senior enterprise software documentation repair agent.",
    "",
    "Use only the provided repair context.",
    "Regenerate only the target weak/missing sections.",
    "Write Turkish Markdown.",
    "Do not invent unsupported behavior.",
    'If evidence is still insufficient, write "Provided context içinde net görünmüyor."',
    "Include source references when visible."
  ].join("\n"), "the optionless Copilot system prompt must remain byte-compatible");
  assert.strictEqual(
    await fs.readFile(path.join(pageRoot, "repaired-sections.md"), "utf8"),
    legacyRaw,
    "default Copilot repair output must not acquire Qwen-only sanitation behavior"
  );

  let capturedPrompt;
  const qwenClient = {
    provider: "qwen",
    async send(prompt) {
      capturedPrompt = prompt;
      return {
        text: [
          "<think>token=private-reasoning-secret</think>",
          "```markdown",
          "## Backend Endpoint Eslesmesi",
          "Endpoint: POST /api/complex",
          "api_key=raw-output-secret",
          '{"client_secret":"raw-json-output-secret"}',
          'password: "two word output secret"',
          "```"
        ].join("\n"),
        usage: usage(),
        model: model("local/qwen3-32b", "Qwen3 32B", "qwen3"),
        provider: "qwen"
      };
    }
  };
  const qwenBudget = 9000;
  await new PageSectionRegenerator(qwenClient, {
    mode: "qwen3",
    maxInputCharacters: qwenBudget,
    expectedModelMarker: "qwen3"
  }).repair(multiRepoRoot, pageRoot, token);
  assert.ok(capturedPrompt.combinedText.length <= qwenBudget, "repair request must fit the provider-derived input budget");
  assert.ok(capturedPrompt.combinedText.includes("TARGET_DRAFT_SENTINEL"), "sanitized request must retain target-first evidence");
  const repaired = await fs.readFile(path.join(pageRoot, "repaired-sections.md"), "utf8");
  assert.ok(repaired.startsWith("## Backend Endpoint E\u015fle\u015fmesi"));
  assert.ok(!repaired.includes("<think>"), "leading Qwen reasoning blocks must not reach the final document");
  assert.ok(!repaired.includes("```"), "an outer Markdown fence must be unwrapped");
  assert.ok(!repaired.includes("raw-output-secret"), "secret-shaped response text must not be persisted");
  assert.ok(!repaired.includes("raw-json-output-secret"), "JSON-shaped response secrets must not be persisted");
  assert.ok(!repaired.includes("two word output secret"), "quoted multi-word response secrets must not be persisted");
  assert.ok(repaired.includes("api_key=[MASKED_SECRET]"), "masked response placeholders must remain auditable");
  assert.ok(repaired.includes('{"client_secret":"[MASKED_SECRET]"}'), "JSON syntax must remain valid after masking");
  assert.ok(repaired.includes('password: "[MASKED_SECRET]"'));
  const audits = (await fs.readFile(path.join(multiRepoRoot, "gap-repair", "repair-audit.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.strictEqual(audits.at(-1).maskedResponseSecrets, 3);

  await testGroupedQwenRepair(multiRepoRoot);
  await testGroupedQwenCancellation(multiRepoRoot);
  await testMissingQwenRepairPreservesOriginalDraft(multiRepoRoot);

  let wrongClientCalls = 0;
  await assert.rejects(
    () => new PageSectionRegenerator({
      provider: "copilot",
      async send() { wrongClientCalls += 1; throw new Error("must not send"); }
    }, { mode: "qwen3", maxInputCharacters: 9000 }).repair(multiRepoRoot, pageRoot, token),
    /provider=qwen/i
  );
  assert.strictEqual(wrongClientCalls, 0, "a non-Qwen client must be rejected before a model request");

  await assert.rejects(
    () => new PageSectionRegenerator({
      provider: "qwen",
      async send() {
        return { text: "## Repair\ntext", usage: usage(), model: model("qwen3-32b"), provider: "copilot" };
      }
    }, { mode: "qwen3", maxInputCharacters: 9000 }).repair(multiRepoRoot, pageRoot, token),
    /rejected provider 'copilot'/i
  );

  await assert.rejects(
    () => new PageSectionRegenerator({
      provider: "qwen",
      async send() {
        return { text: "## Repair\ntext", usage: usage(), model: model("notqwen3fake"), provider: "qwen" };
      }
    }, { mode: "qwen3", maxInputCharacters: 9000 }).repair(multiRepoRoot, pageRoot, token),
    /unexpected model 'notqwen3fake'/i
  );

  assert.strictEqual(languageModelSelections, 0);
  assert.strictEqual(networkCalls, 0);
  console.log("Qwen3 gap-repair tests passed (legacy default, bounded groups, canonical assembly, cancellation, sanitation, model boundary; offline). ");
  await fs.rm(multiRepoRoot, { recursive: true, force: true });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
