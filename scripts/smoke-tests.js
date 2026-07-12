const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (_key, defaultValue) => defaultValue
        })
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

const { JavaMethodCallExtractor } = require("../dist/analyzer/be/javaMethodCallExtractor");
const { BeServiceFlowExtractor } = require("../dist/analyzer/be/beServiceFlowExtractor");
const { PageContextPackBuilder } = require("../dist/pageanalysis/pageContextPackBuilder");
const { PageDocumentQualityScorer } = require("../dist/pageanalysis/quality/pageDocumentQualityScorer");
const { FinalPageDocumentBuilder } = require("../dist/pageanalysis/finalPageDocumentBuilder");
const { EvidencePackBuilder } = require("../dist/evidence/evidencePackBuilder");
const { sourceContextFromFiles } = require("../dist/docs/focusedSourceContext");
const { selectPageEvidenceFiles } = require("../dist/evidence/pageEvidenceSelector");
const { pageSemanticPromptVersion } = require("../dist/pageanalysis/pageSemanticPrompts");
const { normalizeHttpPath } = require("../dist/analyzer/traceability/pathNormalizer");
const { UiToBffMatcher } = require("../dist/analyzer/traceability/uiToBffMatcher");

async function main() {
  testBeServiceFlowUsesMethodCalls();
  await testFocusedSourceUsesStructuredSnippets();
  testEvidenceSelectionSkipsLowConfidenceEntities();
  await testPageContextIncludesDtoAndValidation();
  await testEvidencePackExactSnippetGroups();
  await testFinalDocumentMergeAndBackup();
  await testQualityScorerUnknownData();
  testQwenPromptVersion();
  testTraceabilityPathNormalizationAndAmbiguity();
  console.log("Smoke tests passed.");
}

function testBeServiceFlowUsesMethodCalls() {
  const files = [
    javaFile("src/main/java/app/UserController.java", "controller", `
      package app;
      public class UserController {
        private final UserService userService;
        public UserController(UserService userService) { this.userService = userService; }
        public LoginResponse login(LoginRequest request) {
          return userService.login(request);
        }
      }
    `),
    javaFile("src/main/java/app/UserService.java", "service", `
      package app;
      public class UserService {
        private final UserRepository userRepository;
        public UserService(UserRepository userRepository) { this.userRepository = userRepository; }
        public LoginResponse login(LoginRequest request) {
          return userRepository.findByUsername(request.getUsername());
        }
      }
    `)
  ];
  const methodCalls = new JavaMethodCallExtractor().extract(files);
  const flows = new BeServiceFlowExtractor().extract(
    [{ httpMethod: "POST", path: "/login", className: "UserController", handlerMethod: "login", parameters: [], pathVariables: [], requestParams: [], file: "src/main/java/app/UserController.java" }],
    [
      { type: "service", className: "UserService", packageName: "app", file: "src/main/java/app/UserService.java", annotations: [], constructorDependencies: [], fieldInjectedDependencies: [], implementedInterfaces: [] },
      { type: "repository", className: "UserRepository", packageName: "app", file: "src/main/java/app/UserRepository.java", annotations: [], constructorDependencies: [], fieldInjectedDependencies: [], implementedInterfaces: [] }
    ],
    [{ entity: "User", table: "users", fields: [], file: "src/main/java/app/User.java" }],
    [{ repository: "UserRepository", method: "findByUsername", entity: "User", file: "src/main/java/app/UserRepository.java", confidence: "medium" }],
    methodCalls
  );

  assert.strictEqual(flows[0].confidence, "high");
  assert.deepStrictEqual(flows[0].candidateServices, ["UserService"]);
  assert.deepStrictEqual(flows[0].candidateRepositories, ["UserRepository"]);
  assert.deepStrictEqual(flows[0].entities, ["User"]);
  assert.deepStrictEqual(flows[0].repositoryMethods, ["UserRepository.findByUsername"]);
}

async function testFocusedSourceUsesStructuredSnippets() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bank-focused-source-"));
  const sourceFile = "src/main/java/app/UserService.java";
  await fs.mkdir(path.dirname(path.join(repo, sourceFile)), { recursive: true });
  await fs.writeFile(path.join(repo, sourceFile), `
    package app;
    ${"// unrelated filler\n".repeat(200)}
    public class UserService {
      public LoginResponse login(LoginRequest request) {
        return new LoginResponse(request.getUsername());
      }
    }
  `, "utf8");

  const result = await sourceContextFromFiles(repo, [sourceFile], 900, 1200);
  assert.match(result.content, /Focused method\/component snippets/);
  assert.match(result.content, /login\(LoginRequest request\)/);
  assert.doesNotMatch(result.content, /unrelated filler\n\s*\/\/ unrelated filler\n\s*\/\/ unrelated filler/);
}

function testEvidenceSelectionSkipsLowConfidenceEntities() {
  const manifest = {
    repos: {
      ui: { localPath: "ui" },
      bff: { localPath: "bff" },
      be: { localPath: "be" }
    }
  };
  const lowConfidence = selectPageEvidenceFiles(manifest, {
    selectedPage: { file: "src/pages/Login.tsx" },
    beServiceFlows: [{ confidence: "low", entities: ["User"], repositoryMethods: ["UserRepository.findByUsername"] }],
    entities: [{ entity: "User", file: "src/main/java/app/User.java" }],
    repositories: [{ repository: "UserRepository", method: "findByUsername", entity: "User", file: "src/main/java/app/UserRepository.java" }]
  });
  const lowBeFiles = lowConfidence.find((selection) => selection.role === "be")?.files ?? [];
  assert.deepStrictEqual(lowBeFiles, []);

  const trusted = selectPageEvidenceFiles(manifest, {
    selectedPage: { file: "src/pages/Login.tsx" },
    beServiceFlows: [{ confidence: "high", entities: ["User"], repositoryMethods: ["UserRepository.findByUsername"] }],
    entities: [{ entity: "User", file: "src/main/java/app/User.java" }],
    repositories: [{ repository: "UserRepository", method: "findByUsername", entity: "User", file: "src/main/java/app/UserRepository.java" }]
  });
  const trustedBeFiles = trusted.find((selection) => selection.role === "be")?.files ?? [];
  assert.ok(trustedBeFiles.includes("src/main/java/app/User.java"));
  assert.ok(trustedBeFiles.includes("src/main/java/app/UserRepository.java"));
}

async function testEvidencePackExactSnippetGroups() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bank-evidence-pack-"));
  const uiRoot = path.join(root, "ui-repo");
  const bffRoot = path.join(root, "bff-repo");
  const beRoot = path.join(root, "be-repo");
  await writeFile(uiRoot, "src/pages/Login.tsx", `
    import { login } from "../api/client";
    export default function Login() {
      const [username, setUsername] = useState("");
      async function handleSubmit(event) {
        event.preventDefault();
        await login({ username });
      }
      return <form onSubmit={handleSubmit}><button type="submit">Login</button></form>;
    }
  `);
  await writeFile(uiRoot, "src/api/client.ts", `
    import apiClient from "./apiClient";
    export const login = (body) => apiClient.post("/api/login", body);
  `);
  await writeFile(bffRoot, "src/main/java/app/BffAuthController.java", `
    import org.springframework.web.bind.annotation.PostMapping;
    public class BffAuthController {
      @PostMapping("/api/login")
      public LoginResponse login(@RequestBody LoginRequest request) { return authClient.login(request); }
    }
  `);
  await writeFile(bffRoot, "src/main/java/app/AuthClient.java", `
    import org.springframework.web.bind.annotation.PostMapping;
    public interface AuthClient {
      @PostMapping(
        value = "/login"
      )
      LoginResponse login(@RequestBody LoginRequest request);
    }
  `);
  await writeFile(beRoot, "src/main/java/app/UserController.java", `
    import org.springframework.web.bind.annotation.PostMapping;
    import jakarta.validation.Valid;
    public class UserController {
      @PostMapping("/login")
      public LoginResponse login(@Valid @RequestBody LoginRequest request) { return userService.login(request); }
    }
  `);
  await writeFile(beRoot, "src/main/java/app/UserService.java", `
    public class UserService {
      public LoginResponse login(LoginRequest request) { return userRepository.findByUsername(request.username()); }
    }
  `);
  await writeFile(beRoot, "src/main/java/app/UserRepository.java", `
    public interface UserRepository {
      User findByUsername(String username);
    }
  `);
  await writeFile(beRoot, "src/main/java/app/LoginRequest.java", `
    public record LoginRequest(String username) {}
  `);

  const pageRoot = path.join(root, "page");
  await fs.mkdir(pageRoot, { recursive: true });
  await fs.writeFile(path.join(pageRoot, "page-flow.json"), JSON.stringify({
    selectedPage: { pageName: "Login", file: "src/pages/Login.tsx" },
    components: [{ component: "Login", file: "src/pages/Login.tsx" }],
    interactions: [{ event: "onSubmit", handler: "handleSubmit", file: "src/pages/Login.tsx", confidence: "high" }],
    uiApiCalls: [{ clientFunction: "login", httpMethod: "POST", path: "/api/login", file: "src/api/client.ts", confidence: "high" }],
    bffEndpoints: [{ className: "BffAuthController", handlerMethod: "login", httpMethod: "POST", path: "/api/login", file: "src/main/java/app/BffAuthController.java", confidence: "high" }],
    bffComponents: [{ className: "AuthClient", type: "client", file: "src/main/java/app/AuthClient.java" }],
    bffServiceFlows: [{ endpoint: "POST /api/login", handler: "login", candidateClients: ["AuthClient"], outboundCalls: ["POST /login via AuthClient.login"], confidence: "high" }],
    beEndpoints: [{ className: "UserController", handlerMethod: "login", httpMethod: "POST", path: "/login", file: "src/main/java/app/UserController.java", confidence: "high" }],
    beComponents: [{ className: "UserService", type: "service", file: "src/main/java/app/UserService.java" }],
    beServiceFlows: [{ endpoint: "POST /login", handler: "login", candidateServices: ["UserService"], candidateRepositories: ["UserRepository"], repositoryMethods: ["UserRepository.findByUsername"], entities: ["User"], methodCalls: ["UserController.login -> UserService.login", "UserService.login -> UserRepository.findByUsername"], confidence: "high" }],
    repositories: [{ repository: "UserRepository", method: "findByUsername", entity: "User", file: "src/main/java/app/UserRepository.java", confidence: "medium" }],
    beDtos: [{ className: "LoginRequest", file: "src/main/java/app/LoginRequest.java", fields: ["username: String"] }]
  }), "utf8");

  const manifest = {
    repos: {
      ui: { localPath: uiRoot },
      bff: { localPath: bffRoot },
      be: { localPath: beRoot }
    }
  };
  const result = await new EvidencePackBuilder().build(pageRoot, manifest);
  const evidence = await fs.readFile(result.evidencePackPath, "utf8");
  assert.match(evidence, /## React Page Evidence/);
  assert.match(evidence, /## React Interaction Evidence/);
  assert.match(evidence, /## React API Client Evidence/);
  assert.match(evidence, /## BFF Endpoint Evidence/);
  assert.match(evidence, /## BFF Service Evidence/);
  assert.match(evidence, /## BFF Outbound Client Evidence/);
  assert.match(evidence, /## Backend Endpoint Evidence/);
  assert.match(evidence, /## Backend Service Evidence/);
  assert.match(evidence, /## Repository Evidence/);
  assert.match(evidence, /## Entity \/ DTO \/ Validation Evidence/);
  assert.match(evidence, /handleSubmit/);
  assert.match(evidence, /export const login = \(body\) => apiClient\.post/);
  assert.match(evidence, /apiClient\.post/);
  assert.match(evidence, /@PostMapping\("\/login"\)/);
  assert.match(evidence, /AuthClient\.login/);
  assert.match(evidence, /findByUsername/);
  assert.match(evidence, /## Broad Fallback Evidence/);
  assert.match(evidence, /## Uncertainties/);
}

async function testPageContextIncludesDtoAndValidation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bank-page-context-"));
  await writeJsonl(root, "ui/route-index.jsonl", [{ page: "Login", route: "/login", file: "src/pages/Login.tsx" }]);
  await writeJsonl(root, "ui/component-index.jsonl", [{ component: "Login", page: "Login", file: "src/pages/Login.tsx" }]);
  await writeJsonl(root, "ui/interaction-index.jsonl", []);
  await writeJsonl(root, "ui/form-field-index.jsonl", []);
  await writeJsonl(root, "ui/state-index.jsonl", []);
  await writeJsonl(root, "ui/api-call-index.jsonl", [{ httpMethod: "POST", path: "/api/login", page: "Login", file: "src/api/client.ts" }]);
  await writeJsonl(root, "traceability/page-flows.jsonl", [{ page: "Login", uiApiCall: "POST /api/login", bffEndpoint: "POST /api/login", beEndpoint: "POST /login" }]);
  await writeJsonl(root, "traceability/ui-to-bff.jsonl", [{ uiApiCall: "POST /api/login", bffEndpoint: "POST /api/login", confidence: "high" }]);
  await writeJsonl(root, "traceability/bff-to-be.jsonl", [{ bffEndpoint: "POST /api/login", beEndpoint: "POST /login", confidence: "high" }]);
  await writeJsonl(root, "traceability/semantic/page-flow-semantics.jsonl", []);
  await writeJsonl(root, "bff/api-endpoints.jsonl", [{ httpMethod: "POST", path: "/api/login", className: "BffAuthController", handlerMethod: "login", requestBody: "LoginRequest", responseType: "LoginResponse", parameters: [], file: "src/main/java/app/BffAuthController.java" }]);
  await writeJsonl(root, "bff/spring-components.jsonl", [{ className: "BffAuthController", type: "controller", file: "src/main/java/app/BffAuthController.java" }]);
  await writeJsonl(root, "bff/bff-flow-index.jsonl", []);
  await writeJsonl(root, "bff/dto-index.jsonl", [{ className: "LoginRequest", fields: ["username: String"], file: "src/main/java/app/LoginRequest.java" }]);
  await writeJsonl(root, "be/api-endpoints.jsonl", [{ httpMethod: "POST", path: "/login", className: "UserController", handlerMethod: "login", requestBody: "LoginRequest", responseType: "LoginResponse", parameters: [], file: "src/main/java/app/UserController.java" }]);
  await writeJsonl(root, "be/spring-components.jsonl", [{ className: "UserController", type: "controller", file: "src/main/java/app/UserController.java" }]);
  await writeJsonl(root, "be/service-flow-index.jsonl", [{ endpoint: "POST /login", controller: "UserController", handler: "login", candidateServices: [], candidateRepositories: [], entities: [], repositoryMethods: [], confidence: "medium" }]);
  await writeJsonl(root, "be/dto-index.jsonl", [{ className: "LoginRequest", fields: ["username: String"], file: "src/main/java/app/LoginRequest.java" }]);
  await writeJsonl(root, "be/entity-index.jsonl", []);
  await writeJsonl(root, "be/repository-method-index.jsonl", []);
  await writeJsonl(root, "be/validation-index.jsonl", [{ className: "LoginRequest", fieldOrParameter: "username", annotation: "NotBlank", file: "src/main/java/app/LoginRequest.java" }]);

  const manifest = {
    projectName: "Smoke",
    branch: "main",
    repos: {
      ui: { url: "", localPath: path.join(root, "repo-ui"), status: "analyzed" },
      bff: { url: "", localPath: path.join(root, "repo-bff"), status: "analyzed" },
      be: { url: "", localPath: path.join(root, "repo-be"), status: "analyzed" }
    }
  };
  const selectedPage = { pageName: "Login", route: "/login", file: "src/pages/Login.tsx", apiCallCount: 1, bffMatchStatus: "matched", beMatchStatus: "matched", confidence: "high" };
  const result = await new PageContextPackBuilder().build(root, manifest, selectedPage);
  const context = await fs.readFile(result.contextPackPath, "utf8");
  assert.match(context, /Ilgili BFF DTO Kayitlari/);
  assert.match(context, /Ilgili BE DTO Kayitlari/);
  assert.match(context, /LoginRequest/);
  assert.match(context, /Ilgili BE Validasyon Kayitlari/);
  assert.match(context, /NotBlank/);
}

async function testFinalDocumentMergeAndBackup() {
  const pageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-final-doc-"));
  await fs.writeFile(path.join(pageRoot, "page-flow.json"), JSON.stringify({ selectedPage: { pageName: "Login", route: "/login" } }), "utf8");
  await fs.writeFile(path.join(pageRoot, "page-context-pack.md"), "context", "utf8");
  await fs.writeFile(path.join(pageRoot, "page-evidence-pack.md"), "evidence", "utf8");
  await fs.writeFile(path.join(pageRoot, "detected-gaps.json"), "[]", "utf8");
  await fs.writeFile(path.join(pageRoot, "copilot-draft.md"), [
    "## Validasyon ve Hata Yönetimi",
    "old validation text",
    "",
    "## Kaynak Referanslari",
    "src/main/java/app/LoginRequest.java"
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "repaired-sections.md"), [
    "## Validasyon ve Hata Yonetimi",
    "new validation text",
    "",
    "## Ek Bolum",
    "extra repair"
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(pageRoot, "final-page-technical-analysis.md"), "previous final", "utf8");

  const result = await new FinalPageDocumentBuilder().build(pageRoot);
  const finalDoc = await fs.readFile(result.finalDocumentPath, "utf8");
  const entries = await fs.readdir(pageRoot);
  assert.match(finalDoc, /new validation text/);
  assert.doesNotMatch(finalDoc, /old validation text/);
  assert.match(finalDoc, /Ek Onarim Notlari/);
  assert.match(finalDoc, /extra repair/);
  assert.ok(entries.some((entry) => entry.startsWith("final-page-technical-analysis.md.bak-")));
}

async function testQualityScorerUnknownData() {
  const multiRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bank-quality-"));
  const pageRoot = path.join(multiRepoRoot, "page-analysis", "pages", "Login");
  await fs.mkdir(pageRoot, { recursive: true });
  await fs.writeFile(path.join(pageRoot, "final-page-technical-analysis.md"), "# Short\n", "utf8");

  const score = await new PageDocumentQualityScorer().score(multiRepoRoot, pageRoot);
  assert.ok(score.metricsWithUnknownData.includes("page-flow"));
  assert.ok(score.metricsWithUnknownData.includes("context-pack"));
  assert.ok(score.metricsWithUnknownData.includes("evidence-pack"));
  assert.ok(score.metricsWithUnknownData.includes("gap-report"));
  assert.strictEqual(score.finalDocumentLength, 8);
  assert.strictEqual(score.bffMatchCoverage, null);
  assert.ok(score.metricsWithUnknownData.includes("bff-match-coverage"));
  assert.ok(score.metricExplanations.some((metric) => metric.metric === "bff-match-coverage" && metric.status === "unknown"));
}

function testQwenPromptVersion() {
  assert.strictEqual(pageSemanticPromptVersion, "page-analysis-semantic-v2");
}

function testTraceabilityPathNormalizationAndAmbiguity() {
  const paths = [
    "/customers/:id",
    "/customers/{id}",
    "/customers/${id}",
    "/customers/{customerId}"
  ];
  assert.deepStrictEqual([...new Set(paths.map(normalizeHttpPath))], ["/customers/{param}"]);
  assert.strictEqual(normalizeHttpPath("api/customers/search"), "/api/customers/search");

  const matches = new UiToBffMatcher().match(
    [{ httpMethod: "GET", path: "/customers/:id", file: "src/api/customer.ts" }],
    [
      { httpMethod: "GET", path: "/customers/{id}", className: "CustomerController", handlerMethod: "get", file: "CustomerController.java" },
      { httpMethod: "GET", path: "/customers/{customerId}", className: "LegacyCustomerController", handlerMethod: "get", file: "LegacyCustomerController.java" }
    ]
  );
  assert.strictEqual(matches[0].confidence, "low");
  assert.match(matches[0].matchReason, /Ambiguous exact match/);
}

function javaFile(file, classification, content) {
  return { file, absolutePath: file, extension: ".java", kind: "java", classification, size: content.length, content };
}

async function writeJsonl(root, relativePath, records) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
