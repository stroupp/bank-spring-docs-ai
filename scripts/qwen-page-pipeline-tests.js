const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

let networkCalls = 0;
global.fetch = async () => {
  networkCalls += 1;
  throw new Error("Qwen page pipeline test attempted a real network call");
};

const {
  QwenIterativePageDraftGenerator
} = require("../dist/pageanalysis/qwenIterativePageDraftGenerator");
const {
  QwenPageDraftContextChunker
} = require("../dist/pageanalysis/qwenPageDraftContextChunker");

const canonicalSections = [
  "Sayfa Amacı",
  "Route ve Ana Component",
  "Kullanılan Alt Componentler",
  "Kritik Kullanıcı Aksiyonları",
  "Form Alanları ve Parametreler",
  "UI State Yönetimi",
  "UI API Çağrıları",
  "BFF Endpoint Eşleşmesi",
  "BFF Sorumlulukları",
  "Backend Endpoint Eşleşmesi",
  "Backend Servis / Repository / Entity Akışı",
  "DTO ve Model Kullanımı",
  "Validasyon ve Hata Yönetimi",
  "Güvenlik Gözlemleri",
  "Değişiklik Etkisi ve Riskler",
  "Kaynak Referansları",
  "Belirsizlikler"
];

const token = {
  isCancellationRequested: false,
  onCancellationRequested() { return { dispose() {} }; }
};

async function main() {
  await testMultiChunkRawSourceCoverageAndPublishing();
  await testFailureAndAtomicResume();
  await testLowCallCapResumeAfterVolatileMetadataRegeneration();
  await testInvalidOptionalSemanticArtifactIsSkipped();
  await testMaskedRawResponseIsPreservedOnParseFailure();
  await testApprovedBankingAliasAcceptedViaQwen3Family();
  await testRejectsEmbeddedFakeQwen3Identity();
  assert.strictEqual(networkCalls, 0, "mock-only Qwen page tests must never use fetch");
  console.log("Qwen iterative page pipeline tests passed (mock only; network calls: 0).");
}

async function testMultiChunkRawSourceCoverageAndPublishing() {
  const fixture = await createFixture("qwen-page-multi", true);
  const pageFlowPath = path.join(fixture.pageRoot, "page-flow.json");
  const pageFlow = JSON.parse(await fs.readFile(pageFlowPath, "utf8"));
  pageFlow.selectedPage.pageName = "ComplexRelease api_key=boundary-page-name-secret";
  pageFlow.selectedPage.route = "/releases/:id?api_key=boundary-route-secret";
  pageFlow.pageFlows[0].uncertainties = ["api_key=boundary-warning-secret"];
  await fs.writeFile(pageFlowPath, JSON.stringify(pageFlow, null, 2), "utf8");
  await fs.writeFile(path.join(fixture.pageRoot, "copilot-draft.md"), "# previous Copilot draft\n", "utf8");
  const prompts = [];
  const mock = createMockClient({ prompts });
  const generator = new QwenIterativePageDraftGenerator(mock, options("multi-run"));
  const result = await generator.generate({
    multiRepoRoot: fixture.root,
    pageRoot: fixture.pageRoot,
    manifest: fixture.manifest,
    token
  });

  assert.ok(result.chunkCount > 4, "small chunk budget must create multiple semantic/source chunks");
  assert.ok(result.newModelCallCount > 4, "iterative pipeline must use multiple bounded model calls");
  assert.ok(result.reduceLevels >= 1, "large evidence ledger must use hierarchical reduction");
  assert.ok(result.includedSourceFiles.some((file) => file === "ui:src/pages/LateUi.tsx"));
  assert.ok(result.includedSourceFiles.some((file) => file === "bff:src/main/java/app/LateBff.java"));
  assert.ok(result.includedSourceFiles.some((file) => file === "be:src/main/java/app/LateBe.java"));

  const sentText = prompts.map((prompt) => prompt.combinedText).join("\n");
  assert.match(sentText, /LATE_UI_SOURCE_SENTINEL/, "late UI source file must reach a bounded request");
  assert.match(sentText, /LATE_BFF_SOURCE_SENTINEL/, "late BFF source file must not be starved by UI evidence");
  assert.match(sentText, /LATE_BE_SOURCE_SENTINEL/, "late BE source file must not be starved by UI/BFF evidence");
  assert.doesNotMatch(sentText, /boundary-qwen-page-secret/);
  assert.doesNotMatch(sentText, /boundary-qwen-json-secret/);
  assert.doesNotMatch(sentText, /boundary-page-name-secret|boundary-route-secret|boundary-warning-secret/);
  assert.match(sentText, /\[MASKED_SECRET\]/);
  assert.ok(prompts.every((prompt) => prompt.combinedText.length <= 12000), "every request must respect the configured full prompt budget");

  const qwenDraft = await fs.readFile(result.qwenDraftPath, "utf8");
  const compatibilityDraft = await fs.readFile(result.draftPath, "utf8");
  assert.strictEqual(qwenDraft, compatibilityDraft, "qwen-draft and canonical compatibility draft must be identical");
  assert.match(qwenDraft, /bank-spring-docs-generation/);
  assert.match(qwenDraft, /"provider":"qwen"/);
  assert.doesNotMatch(qwenDraft, /<think>/i, "Qwen3 reasoning must not leak into the published Markdown");
  assert.doesNotMatch(qwenDraft, /```markdown/i, "an outer Qwen3 Markdown fence must not wrap the published document");
  assert.match(qwenDraft, /Pipeline Kapsam Uyarilari/);
  assert.match(qwenDraft, /\[MASKED_SECRET\]/, "masked coverage warnings must be disclosed in Belirsizlikler");
  assert.doesNotMatch(qwenDraft, /boundary-warning-secret/);
  assert.ok(result.warnings.some((warning) => warning.includes("[MASKED_SECRET]")));
  assert.ok(result.warnings.every((warning) => !warning.includes("boundary-warning-secret")));
  let previousHeadingOffset = -1;
  for (const heading of canonicalSections) {
    assert.match(qwenDraft, new RegExp(`^## ${escapeRegex(heading)}$`, "m"));
    const headingOffset = qwenDraft.indexOf(`## ${heading}`);
    assert.ok(headingOffset > previousHeadingOffset, `${heading} must follow the canonical section order`);
    previousHeadingOffset = headingOffset;
  }
  const pageEntries = await fs.readdir(fixture.pageRoot);
  assert.ok(pageEntries.some((entry) => entry.startsWith("copilot-draft.md.bak-")), "pre-existing Copilot compatibility draft must be backed up");

  const runManifest = JSON.parse(await fs.readFile(result.runManifestPath, "utf8"));
  assert.strictEqual(runManifest.status, "completed");
  assert.strictEqual(runManifest.pipeline, "qwen3-iterative-page-draft");
  assert.ok(runManifest.modelIds.includes("mock-qwen3-32b"));
  assert.ok(runManifest.chunks.some((chunk) => chunk.role === "ui"));
  assert.ok(runManifest.chunks.some((chunk) => chunk.role === "bff"));
  assert.ok(runManifest.chunks.some((chunk) => chunk.role === "be"));

  const stepFiles = await fs.readdir(path.join(result.runRoot, "steps"));
  for (const file of stepFiles.filter((entry) => /-(?:context|prompt)\.md$/.test(entry))) {
    const content = await fs.readFile(path.join(result.runRoot, "steps", file), "utf8");
    assert.doesNotMatch(content, /boundary-qwen-page-secret/, `${file} must not persist a raw secret`);
    assert.doesNotMatch(content, /boundary-qwen-json-secret/, `${file} must not persist a JSON-shaped secret`);
  }
}

async function testMaskedRawResponseIsPreservedOnParseFailure() {
  const fixture = await createFixture("qwen-page-parse-debug", false);
  const mock = {
    provider: "qwen",
    async send(prompt) {
      const text = "<think>discard me</think>\nnot-json api_key=boundary-parse-secret";
      return {
        text,
        usage: {
          inputCharacters: prompt.combinedText.length,
          outputCharacters: text.length,
          estimatedInputTokens: 100,
          estimatedOutputTokens: 20,
          estimatedTotalTokens: 120
        },
        model: { id: "mock-qwen3-32b", name: "Mock Qwen3", vendor: "qwen", family: "qwen3", version: "test", maxInputTokens: 131072 },
        provider: "qwen"
      };
    }
  };
  const generator = new QwenIterativePageDraftGenerator(mock, options("parse-debug-run"));
  await assert.rejects(
    generator.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token }),
    /parse edilemedi/i
  );
  const latest = JSON.parse(await fs.readFile(path.join(fixture.pageRoot, ".qwen3-page-draft", "latest-run.json"), "utf8"));
  const manifestPath = path.resolve(path.join(fixture.pageRoot, ".qwen3-page-draft"), latest.runManifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const failedStep = Object.values(manifest.steps).find((step) => step.status === "failed");
  assert.ok(failedStep?.rawOutputPath, "parse failure must record the masked raw response path");
  const rawPath = path.resolve(path.dirname(manifestPath), failedStep.rawOutputPath);
  const raw = await fs.readFile(rawPath, "utf8");
  assert.doesNotMatch(raw, /boundary-parse-secret/);
  assert.match(raw, /\[MASKED_SECRET\]/);
}

async function testApprovedBankingAliasAcceptedViaQwen3Family() {
  const fixture = await createFixture("qwen-page-banking-family", false);
  const prompts = [];
  const base = createMockClient({ prompts });
  const bankingClient = {
    provider: "qwen",
    async send(prompt) {
      const response = await base.send(prompt);
      return {
        ...response,
        model: {
          ...response.model,
          id: "ONIKS",
          name: "ONIKS",
          family: "qwen3",
          version: "ONIKS"
        }
      };
    }
  };
  const generator = new QwenIterativePageDraftGenerator(bankingClient, {
    ...options("banking-family-run"),
    modelIdentity: "ONIKS/qwen3@approved-banking-fingerprint"
  });
  const result = await generator.generate({
    multiRepoRoot: fixture.root,
    pageRoot: fixture.pageRoot,
    manifest: fixture.manifest,
    token
  });
  const manifest = JSON.parse(await fs.readFile(result.runManifestPath, "utf8"));
  assert.ok(prompts.length > 0);
  assert.ok(manifest.modelIds.includes("ONIKS"));
  assert.strictEqual(manifest.status, "completed");
}

async function testFailureAndAtomicResume() {
  const fixture = await createFixture("qwen-page-resume", false);
  const firstPrompts = [];
  const failing = createMockClient({ prompts: firstPrompts, failAt: 2 });
  const first = new QwenIterativePageDraftGenerator(failing, options("resume-run"));
  await assert.rejects(
    first.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token }),
    /deterministic Qwen3 interruption/
  );

  const latest = JSON.parse(await fs.readFile(path.join(fixture.pageRoot, ".qwen3-page-draft", "latest-run.json"), "utf8"));
  const manifestPath = path.resolve(path.join(fixture.pageRoot, ".qwen3-page-draft"), latest.runManifestPath);
  const failedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.strictEqual(failedManifest.status, "failed");
  assert.strictEqual(Object.values(failedManifest.steps).filter((step) => step.status === "completed").length, 1);
  assert.strictEqual(await exists(path.join(fixture.pageRoot, "qwen-draft.md")), false, "failed run must not publish a partial draft");

  const resumePrompts = [];
  const resumedClient = createMockClient({ prompts: resumePrompts });
  const resumed = new QwenIterativePageDraftGenerator(resumedClient, options("resume-run"));
  const result = await resumed.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token });
  assert.ok(result.reusedStepCount >= 1, "completed work item must be reused after failure");
  assert.ok(result.newModelCallCount < result.modelCallCount, "resume must avoid repeating every prior request");
  const completedManifest = JSON.parse(await fs.readFile(result.runManifestPath, "utf8"));
  assert.strictEqual(completedManifest.status, "completed");
  assert.ok(Object.values(completedManifest.steps).every((step) => step.status === "completed"));
}

async function testLowCallCapResumeAfterVolatileMetadataRegeneration() {
  const fixture = await createFixture("qwen-page-volatile-resume", false);
  await regenerateVolatileArtifactMetadata(fixture.pageRoot, "first");

  const firstPrompts = [];
  const lowCapOptions = {
    ...options("volatile-resume-run"),
    maxModelCalls: 1,
    maxReduceLevels: 1
  };
  const first = new QwenIterativePageDraftGenerator(createMockClient({ prompts: firstPrompts }), lowCapOptions);
  await assert.rejects(
    first.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token }),
    /1 yeni model cagrisi sinirina ulasti/i
  );
  assert.strictEqual(firstPrompts.length, 1, "low model-call cap must stop after preserving one completed request");

  const statusRoot = path.join(fixture.pageRoot, ".qwen3-page-draft");
  const firstLatest = JSON.parse(await fs.readFile(path.join(statusRoot, "latest-run.json"), "utf8"));
  const firstManifestPath = path.resolve(statusRoot, firstLatest.runManifestPath);
  const firstManifest = JSON.parse(await fs.readFile(firstManifestPath, "utf8"));
  const completedEntries = Object.entries(firstManifest.steps).filter(([, step]) => step.status === "completed");
  assert.strictEqual(completedEntries.length, 1);
  const [preservedStepId, preservedStep] = completedEntries[0];
  const firstRunRoot = path.dirname(firstManifestPath);

  // Simulate the full page command rebuilding its artifacts before retrying.
  // Only operational timestamps/input hashes change; evidence stays identical.
  await regenerateVolatileArtifactMetadata(fixture.pageRoot, "second");

  const resumePrompts = [];
  const resumed = new QwenIterativePageDraftGenerator(createMockClient({ prompts: resumePrompts }), {
    ...options("a-new-run-id-must-not-be-used"),
    maxModelCalls: 100,
    maxReduceLevels: 5
  });
  const result = await resumed.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token });
  assert.strictEqual(result.runRoot, firstRunRoot, "volatile metadata and raised operational ceilings must preserve the run root");
  assert.ok(result.reusedStepCount >= 1, "the completed pre-failure model step must be reused");
  assert.ok(!resumePrompts.some((prompt) => prompt.combinedText === firstPrompts[0].combinedText), "resume must not resend the first completed prompt");
  assert.ok(result.newModelCallCount < result.modelCallCount, "cumulative request count must include reused work from the earlier invocation");

  const resumedManifest = JSON.parse(await fs.readFile(result.runManifestPath, "utf8"));
  assert.strictEqual(resumedManifest.runId, firstManifest.runId, "resume must retain the original run id");
  assert.strictEqual(resumedManifest.steps[preservedStepId].attempt, preservedStep.attempt, "reused step attempt must not increment");
  assert.strictEqual(resumedManifest.steps[preservedStepId].outputHash, preservedStep.outputHash, "reused output must remain byte-verified");

  // Derived semantic output may legitimately change between full-command
  // iterations. It must invalidate only its own step (and downstream reduce /
  // synthesis work), not relocate the core page/source run.
  const semanticsPath = path.join(fixture.pageRoot, "qwen-page-semantics.json");
  const semantics = JSON.parse(await fs.readFile(semanticsPath, "utf8"));
  semantics.purpose = "A meaningfully updated semantic fact.";
  await fs.writeFile(semanticsPath, `${JSON.stringify(semantics, null, 2)}\n`, "utf8");
  const semanticRefreshPrompts = [];
  const semanticRefresh = new QwenIterativePageDraftGenerator(createMockClient({ prompts: semanticRefreshPrompts }), {
    ...options("semantic-refresh-must-use-existing-run"),
    maxModelCalls: 100
  });
  const semanticResult = await semanticRefresh.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token });
  assert.strictEqual(semanticResult.runRoot, firstRunRoot, "derived semantic changes must retain the core run root");
  assert.ok(semanticResult.newModelCallCount >= 1, "changed semantic chunk must be analyzed under a new per-step hash");
  assert.ok(semanticResult.reusedStepCount >= 1, "unchanged core chunks must still be reused during semantic refresh");
}

async function testRejectsEmbeddedFakeQwen3Identity() {
  assert.throws(
    () => new QwenIterativePageDraftGenerator(createMockClient({ prompts: [] }), {
      ...options("fake-constructor-identity"),
      modelIdentity: "notqwen3fake"
    }),
    /expected marker/i,
    "Qwen3 must be a delimited model-identity segment, not an arbitrary substring"
  );

  const fixture = await createFixture("qwen-page-fake-response-identity", false);
  const fakeResponseClient = {
    provider: "qwen",
    async send(prompt) {
      const text = JSON.stringify({ sections: [] });
      return {
        text,
        usage: {
          inputCharacters: prompt.combinedText.length,
          outputCharacters: text.length,
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
          estimatedTotalTokens: 2
        },
        model: {
          id: "notqwen3fake",
          name: "notqwen3fake",
          vendor: "qwen",
          family: "notqwen3fake",
          version: "test",
          maxInputTokens: 131072
        },
        provider: "qwen"
      };
    }
  };
  const generator = new QwenIterativePageDraftGenerator(fakeResponseClient, options("fake-response-identity"));
  await assert.rejects(
    generator.generate({ multiRepoRoot: fixture.root, pageRoot: fixture.pageRoot, token }),
    /beklenmeyen model yaniti/i
  );
}

async function testInvalidOptionalSemanticArtifactIsSkipped() {
  const fixture = await createFixture("qwen-page-invalid-optional-semantic", false);
  await fs.writeFile(path.join(fixture.pageRoot, "qwen-page-semantics.json"), "{ definitely-not-json", "utf8");
  const result = await new QwenPageDraftContextChunker({
    maxChunkCharacters: 2800,
    maxSourceFileCharacters: 9000,
    maxTotalSourceCharacters: 27000
  }).build(fixture.pageRoot);
  assert.ok(result.chunks.some((chunk) => chunk.kind === "page-flow"));
  assert.ok(result.chunks.some((chunk) => chunk.kind === "context-pack"));
  assert.ok(result.warnings.some((warning) => /qwen-page-semantics\.json.*gecersiz/i.test(warning)));
  assert.ok(!result.chunks.some((chunk) => chunk.sourceLabel === "qwen-page-semantics.json"));
}

function createMockClient({ prompts, failAt }) {
  let calls = 0;
  return {
    provider: "qwen",
    async send(prompt) {
      calls += 1;
      prompts.push(prompt);
      if (calls === failAt) {
        throw new Error("deterministic Qwen3 interruption");
      }
      let text;
      if (prompt.profile === "qwen3-page-final-synthesis") {
        text = `<think>private chain of thought must be removed</think>\n\`\`\`markdown\n${[
          ...[...canonicalSections].reverse().map((heading) => `## ${heading}\n\nMocked evidence-bound content for ${heading}.`)
        ].join("\n\n")}\n\`\`\``;
      } else if (prompt.profile === "qwen3-page-ledger-reduce") {
        text = JSON.stringify({
          sections: [{
            heading: "Sayfa Amacı",
            findings: ["Reduced evidence ledger."],
            sourceReferences: ["src/pages/LateUi.tsx", "src/main/java/app/LateBff.java", "src/main/java/app/LateBe.java"],
            uncertainties: []
          }]
        });
      } else {
        const sentinels = ["LATE_UI_SOURCE_SENTINEL", "LATE_BFF_SOURCE_SENTINEL", "LATE_BE_SOURCE_SENTINEL"]
          .filter((sentinel) => prompt.combinedText.includes(sentinel));
        text = `<think>bounded analysis reasoning</think>\n\`\`\`json\n${JSON.stringify({
          sections: [{
            heading: "Sayfa Amacı",
            findings: [
              ...(sentinels.length ? sentinels : ["Bounded chunk inspected."]),
              `Detailed bounded observation ${calls}: ${"z".repeat(calls === 1 ? 8000 : 900)}`
            ],
            sourceReferences: extractSourcePaths(prompt.combinedText),
            uncertainties: []
          }]
        })}\n\`\`\``;
      }
      return {
        text,
        usage: {
          inputCharacters: prompt.combinedText.length,
          outputCharacters: text.length,
          estimatedInputTokens: Math.ceil(prompt.combinedText.length / 4),
          estimatedOutputTokens: Math.ceil(text.length / 4),
          estimatedTotalTokens: Math.ceil((prompt.combinedText.length + text.length) / 4)
        },
        model: {
          id: "mock-qwen3-32b",
          name: "Mock Qwen3 32B",
          vendor: "qwen",
          family: "qwen3",
          version: "test",
          maxInputTokens: 131072
        },
        provider: "qwen",
        finishReason: "stop"
      };
    }
  };
}

function options(runId) {
  return {
    maxInputCharacters: 12000,
    maxChunkCharacters: 2800,
    maxSourceFileCharacters: 9000,
    maxTotalSourceCharacters: 27000,
    maxModelCalls: 100,
    maxReduceLevels: 5,
    modelIdentity: "qwen3-test",
    expectedModelMarker: "qwen3",
    now: () => new Date("2026-07-16T10:00:00.000Z"),
    runIdFactory: () => runId
  };
}

async function createFixture(prefix, withRawSources) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const pageRoot = path.join(root, "page-analysis", "pages", "ComplexRelease");
  const uiRoot = path.join(root, "repo-ui");
  const bffRoot = path.join(root, "repo-bff");
  const beRoot = path.join(root, "repo-be");
  await Promise.all([pageRoot, uiRoot, bffRoot, beRoot].map((dir) => fs.mkdir(dir, { recursive: true })));

  const pageFlow = {
    projectName: "Qwen Page Test",
    branch: "main",
    selectedPage: { pageName: "ComplexRelease", route: "/releases/:id", file: "src/pages/ComplexRelease.tsx" },
    routes: [{ file: "src/routes.tsx" }],
    components: [{ file: "src/pages/LateUi.tsx" }],
    interactions: [{ page: "ComplexRelease", handler: "submit", file: "src/pages/LateUi.tsx" }],
    formFields: [{ page: "ComplexRelease", field: "amount", file: "src/pages/LateUi.tsx" }],
    states: [{ page: "ComplexRelease", state: "draft", file: "src/pages/LateUi.tsx" }],
    uiApiCalls: [{ httpMethod: "POST", path: "/api/releases", file: "src/api/release.ts" }],
    uiToBffMatches: [{ bffEndpoint: "POST /api/releases", bffFile: "src/main/java/app/LateBff.java", confidence: "high" }],
    bffEndpoints: [{ endpoint: "POST /api/releases", file: "src/main/java/app/LateBff.java" }],
    bffComponents: [{ className: "LateBff", file: "src/main/java/app/LateBff.java" }],
    bffDtos: [{ className: "ReleaseRequest", file: "src/main/java/app/ReleaseRequest.java" }],
    bffServiceFlows: [{ endpoint: "POST /api/releases", file: "src/main/java/app/LateBff.java" }],
    bffToBeMatches: [{ bffEndpoint: "POST /api/releases", beEndpoint: "POST /releases", beFile: "src/main/java/app/LateBe.java", confidence: "high" }],
    beEndpoints: [{ endpoint: "POST /releases", file: "src/main/java/app/LateBe.java" }],
    beComponents: [{ className: "LateBe", file: "src/main/java/app/LateBe.java" }],
    beDtos: [{ className: "ReleaseCommand", file: "src/main/java/app/ReleaseCommand.java" }],
    beValidations: [{ annotation: "NotNull", file: "src/main/java/app/ReleaseCommand.java" }],
    beServiceFlows: [{ endpoint: "POST /releases", confidence: "high", entities: ["Release"], repositoryMethods: ["ReleaseRepository.save"], file: "src/main/java/app/LateBe.java" }],
    repositories: [{ repository: "ReleaseRepository", method: "save", entity: "Release", file: "src/main/java/app/ReleaseRepository.java" }],
    entities: [{ entity: "Release", file: "src/main/java/app/Release.java" }],
    pageFlows: [{ page: "ComplexRelease", route: "/releases/:id", uiApiCall: "POST /api/releases", bffEndpoint: "POST /api/releases", beEndpoint: "POST /releases", confidence: "high" }]
  };
  await fs.writeFile(path.join(pageRoot, "page-flow.json"), JSON.stringify(pageFlow, null, 2), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), [
    "# Complex Release Page",
    "## UI Context",
    "password=boundary-qwen-page-secret",
    '{"api_key":"boundary-qwen-json-secret"}',
    "x".repeat(6500),
    "## BFF and BE Context",
    "POST /api/releases -> POST /releases"
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), [
    "# Page Evidence",
    "## React Page Evidence",
    "src/pages/ComplexRelease.tsx",
    "y".repeat(5000),
    "## Backend Endpoint Evidence",
    "src/main/java/app/LateBe.java"
  ].join("\n"), "utf8");

  const manifest = {
    projectName: "Qwen Page Test",
    branch: "main",
    repos: {
      ui: { url: "", localPath: uiRoot, status: "analyzed" },
      bff: { url: "", localPath: bffRoot, status: "analyzed" },
      be: { url: "", localPath: beRoot, status: "analyzed" }
    }
  };

  if (withRawSources) {
    await writeSource(uiRoot, "src/pages/ComplexRelease.tsx", "export const ComplexRelease = () => null;");
    await writeSource(uiRoot, "src/routes.tsx", "export const route = '/releases/:id';");
    await writeSource(uiRoot, "src/api/release.ts", "export const createRelease = () => fetch('/api/releases');");
    await writeSource(uiRoot, "src/pages/LateUi.tsx", `${"u".repeat(12000)}\nLATE_UI_SOURCE_SENTINEL\napi_key=boundary-qwen-page-secret`);
    await writeSource(bffRoot, "src/main/java/app/LateBff.java", `${"b".repeat(12000)}\nLATE_BFF_SOURCE_SENTINEL`);
    await writeSource(bffRoot, "src/main/java/app/ReleaseRequest.java", "record ReleaseRequest(String id) {}");
    await writeSource(beRoot, "src/main/java/app/LateBe.java", `${"e".repeat(12000)}\nLATE_BE_SOURCE_SENTINEL`);
    await writeSource(beRoot, "src/main/java/app/ReleaseCommand.java", "record ReleaseCommand(String id) {}");
    await writeSource(beRoot, "src/main/java/app/ReleaseRepository.java", "interface ReleaseRepository {}");
    await writeSource(beRoot, "src/main/java/app/Release.java", "class Release {}");
  }
  return { root, pageRoot, manifest };
}

async function regenerateVolatileArtifactMetadata(pageRoot, marker) {
  const timestamp = marker === "first"
    ? "2026-07-16T10:00:00.000Z"
    : "2026-07-16T11:22:33.444Z";
  const metadata = {
    generatedAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    inputHash: `volatile-input-${marker}`,
    pipelineVersion: "page-analysis-v3",
    sourceArtifacts: { "ui/page-index.jsonl": "stable-source-receipt" }
  };

  const pageFlowPath = path.join(pageRoot, "page-flow.json");
  const pageFlow = JSON.parse(await fs.readFile(pageFlowPath, "utf8"));
  Object.assign(pageFlow, metadata);
  pageFlow._metadata = { ...metadata };
  await fs.writeFile(pageFlowPath, JSON.stringify(pageFlow, null, 2), "utf8");

  await fs.writeFile(path.join(pageRoot, "qwen-page-semantics.json"), `${JSON.stringify({
    purpose: "Stable semantic fact across regenerated metadata.",
    _metadata: metadata
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(pageRoot, "qwen-interaction-semantics.jsonl"), `${JSON.stringify({
    interaction: "submit",
    effect: "Stable interaction semantic fact.",
    _metadata: metadata
  })}\n`, "utf8");

  const contextPath = path.join(pageRoot, "page-context-pack.md");
  const evidencePath = path.join(pageRoot, "page-evidence-pack.md");
  await fs.writeFile(
    contextPath,
    rewriteMarkdownOperationalMetadata(await fs.readFile(contextPath, "utf8"), "Artifact Metadata", metadata),
    "utf8"
  );
  await fs.writeFile(
    evidencePath,
    rewriteMarkdownOperationalMetadata(await fs.readFile(evidencePath, "utf8"), "Metadata", metadata),
    "utf8"
  );
}

function rewriteMarkdownOperationalMetadata(content, metadataHeading, metadata) {
  const normalized = content.replace(/\r\n/g, "\n")
    .replace(/^Olusturulma zamani:.*\n?/gim, "")
    .replace(/^Input hash:.*\n?/gim, "");
  const metadataPattern = new RegExp(
    "\\n?##\\s+" + escapeRegex(metadataHeading) + "\\s*\\n+\\s*```json\\s*\\n[\\s\\S]*?\\n```\\s*\\n?",
    "i"
  );
  const withoutMetadata = normalized.replace(metadataPattern, "\n").trim();
  const firstBreak = withoutMetadata.indexOf("\n");
  const title = firstBreak >= 0 ? withoutMetadata.slice(0, firstBreak).trim() : withoutMetadata;
  const rest = firstBreak >= 0 ? withoutMetadata.slice(firstBreak + 1).trim() : "";
  return [
    title,
    `Olusturulma zamani: ${metadata.generatedAt}`,
    `Input hash: ${metadata.inputHash}`,
    "",
    `## ${metadataHeading}`,
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    rest,
    ""
  ].join("\n");
}

async function writeSource(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function extractSourcePaths(text) {
  return [...new Set(text.match(/src[\\/][^\s)`]+?\.(?:java|ts|tsx|js|jsx)/g) || [])];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
