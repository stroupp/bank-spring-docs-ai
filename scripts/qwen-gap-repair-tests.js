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
  assert.ok(repaired.startsWith("## Backend Endpoint Eslesmesi"));
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
  console.log("Qwen3 gap-repair tests passed (legacy default, target-first budget, sanitation, model boundary; offline). ");
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
