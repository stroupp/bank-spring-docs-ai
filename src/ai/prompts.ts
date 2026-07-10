export type DocumentKind =
  | "repository-overview"
  | "spring-architecture"
  | "api"
  | "service-layer"
  | "repository-layer"
  | "entities"
  | "configuration"
  | "external-integrations"
  | "test-analysis"
  | "technical-analysis";

export function buildDocumentationPrompt(title: string, contextPack: string): string {
  return `You are a senior Java Spring Boot architect writing technical documentation for an enterprise banking repository.

Use only the provided context.
Do not invent files, classes, methods, APIs, endpoints, database tables, configurations, or dependencies.
If something is not visible from the context, write: "Not visible from provided context."
Write enterprise-friendly Markdown.
Include assumptions, risks, and source references when possible.

Document title: ${title}

Context:
${contextPack}`;
}

export function buildCopilotDocumentationPrompt(title: string, contextPack: string): string {
  return buildCopilotDocumentationRequest(title, contextPack).userPrompt;
}

export interface CopilotPromptRequest {
  instructions: string;
  userPrompt: string;
  combinedText: string;
  profile: "standard" | "backend-technical-deep-dive";
}

export type CopilotAgenticStep =
  | "plan"
  | "api-analysis"
  | "service-flow-analysis"
  | "data-config-error-analysis"
  | "diagram-drafts"
  | "final-synthesis";

export type CopilotMultiRepoAgenticStep =
  | "cross-layer-plan"
  | "ui-analysis"
  | "bff-analysis"
  | "be-analysis"
  | "traceability-analysis"
  | "cross-layer-diagrams"
  | "final-cross-layer-synthesis";

export interface CopilotAgenticPromptRequest {
  instructions: string;
  userPrompt: string;
  combinedText: string;
  profile: "agentic-backend-documentation" | "agentic-ui-bff-be-documentation";
  step: CopilotAgenticStep | CopilotMultiRepoAgenticStep;
}

export function buildCopilotDocumentationRequest(title: string, contextPack: string): CopilotPromptRequest {
  const profile = title === "Technical Analysis" ? "backend-technical-deep-dive" : "standard";
  const instructions = profile === "backend-technical-deep-dive"
    ? buildBackendTechnicalInstructions()
    : buildStandardCopilotInstructions();
  const userPrompt = profile === "backend-technical-deep-dive"
    ? buildBackendTechnicalUserPrompt(title, contextPack)
    : buildStandardCopilotUserPrompt(title, contextPack);
  return {
    instructions,
    userPrompt,
    combinedText: `${instructions}\n\n${userPrompt}`,
    profile
  };
}

function buildStandardCopilotInstructions(): string {
  return `You are a senior Java Spring Boot architect and enterprise banking documentation engineer.

Strict rules:
- Use only the provided context.
- Do not invent files, classes, APIs, methods, endpoints, database tables, configurations, integrations, tests, or dependencies.
- The word "Copilot" refers only to the documentation generator/model. It is not the target application name. Never call the target repository or application "Copilot" unless that exact name is visible in the provided context.
- Derive the application/repository name only from Manifest or provided source paths.
- If something is missing, write: "Not visible from provided context."
- Prefer concise enterprise documentation over speculation.
- Include source references using file paths when visible.
- Include an Assumptions section.
- Include a Risks section.
- Do not include secrets. If a value appears masked, keep it masked.
- Do not add broad generic statements unless they are supported by endpoint/component/dependency/configuration context.`;
}

function buildStandardCopilotUserPrompt(title: string, contextPack: string): string {
  return `Write a technical Markdown document for the requested document title.

Document title: ${title}

Required Markdown structure:
1. Purpose
2. Executive summary
3. Technical details
4. Source references
5. Assumptions
6. Risks

Provided context:
${contextPack}`;
}

function buildBackendTechnicalInstructions(): string {
  return `You are a senior Java Spring Boot architect, backend analyst, and enterprise technical documentation engineer.

Goal:
Create an end-to-end backend technical analysis document from the provided local repository indexes.

Strict grounding rules:
- Use only the provided context. Do not invent missing controllers, services, repositories, entities, DTOs, endpoints, request/response models, integrations, Kafka topics, cache layers, database tables, tests, or errors.
- If a detail is not visible, write: "Not visible from provided context."
- Do not expose secrets. Keep masked values masked.
- Prefer exact class, method, endpoint, table, configuration, and file-path references over generic explanation.
- Separate facts from assumptions.
- The word "Copilot" refers only to the model/generator, not the target application.
- Write the documentation in Turkish, but keep code identifiers, file paths, endpoint paths, JSON keys, HTTP methods, and PlantUML syntax unchanged.
- Produce Markdown only.
- Use fenced plantuml code blocks for diagrams.
- Include useful diagrams only when the context supports them. If a diagram cannot be grounded, include a short "Not visible from provided context." note instead.

Required analysis coverage:
- Controllers and HTTP endpoints.
- Request and response models when visible.
- Service-layer business flow and validations.
- Repository/data access behavior.
- Entity and table relationships.
- External API, Kafka, message queue, cache, batch, and async integrations when visible.
- Security, authentication, authorization, input validation, and exception handling when visible.
- Tests, deployment/configuration notes, risks, TODOs, and technical debt when visible.`;
}

function buildBackendTechnicalUserPrompt(title: string, contextPack: string): string {
  return `Create a comprehensive backend technical documentation package for this repository/module.

Document title: ${title}

Required Markdown structure:
1. Modul Genel Bakis
   - Modulun amaci ve sorumlulugu
   - Kullanim senaryolari
   - Ilgili modullerle iliskisi

2. Mimari Bilesenler
   - Controller layer
   - Service layer
   - Repository layer
   - Entity/DTO layer
   - External integration points
   - Dependency injection map

3. API Endpoint Spesifikasyonlari
   For each visible endpoint include:
   - HTTP method and URL
   - Controller and handler method
   - Request headers if visible
   - Request body model and JSON example if visible
   - Response body model and JSON example if visible
   - HTTP status codes if visible
   - Authorization requirements if visible
   - Example curl command when enough endpoint data is visible

4. Veritabani Tasarimi
   - Entity classes and fields
   - Table names
   - Primary key and relationship details
   - Indexes and constraints if visible
   - Example SQL only if grounded by visible entity/table fields

5. Is Mantigi Akislari
   - Major operation flow
   - Validation rules
   - Business rules
   - Edge cases
   - Error handling behavior

6. Entegrasyon Noktalari
   - External APIs
   - Kafka topics
   - Cache usage
   - Message queues
   - Batch or async processing

7. Guvenlik
   - Authentication and authorization
   - Digital signature checks if visible
   - Rate limiting if visible
   - Input validation

8. Hata Yonetimi
   - Custom exceptions
   - Global exception handling
   - Error response format
   - Logging strategy

9. Performans Optimizasyonlari
   - Caching
   - Batch processing
   - Async operations
   - Query or repository-level risks

10. Test Senaryolari
   - Unit test coverage
   - Integration test scenarios
   - Mocking strategy

11. Deployment Notlari
   - Environment-specific configuration
   - Required environment variables
   - Dependencies

12. Akis Diyagramlari
   Include PlantUML diagrams when supported:
   - Sequence diagram for major endpoints
   - Component diagram
   - Activity diagram for complex business flow
   - Error handling flow
   - State machine only if status transitions are visible

13. Kalite Kontrol Checklist
   - Endpoints documented
   - Request/response examples completed or explicitly marked not visible
   - Entity relationships documented
   - External integrations documented
   - Error scenarios documented
   - PlantUML blocks included where possible

14. Sonuc Raporu
   - Documented endpoint count
   - Diagram count
   - Analyzed source/index references
   - Additional improvement suggestions

Provided context:
${contextPack}`;
}

export function buildCopilotAgenticPrompt(
  step: CopilotAgenticStep,
  contextPack: string,
  previousArtifacts = ""
): CopilotAgenticPromptRequest {
  const instructions = buildAgenticBackendInstructions();
  const userPrompt = buildAgenticBackendUserPrompt(step, contextPack, previousArtifacts);
  return {
    instructions,
    userPrompt,
    combinedText: `${instructions}\n\n${userPrompt}`,
    profile: "agentic-backend-documentation",
    step
  };
}

function buildAgenticBackendInstructions(): string {
  return `You are the reasoning engine inside a VS Code extension that orchestrates multi-step Java Spring Boot documentation.

Important operating rules:
- The extension is the agent. You are one step in a controlled pipeline.
- Use only the provided local repository context and previous step artifacts.
- Do not invent files, endpoints, tables, DTOs, integrations, tests, or business rules.
- If a detail is missing, write: "Not visible from provided context."
- Keep all code identifiers, paths, HTTP methods, JSON fields, and PlantUML syntax exact.
- Write Turkish documentation text, but keep technical identifiers unchanged.
- Prefer source-grounded bullets and tables over generic architecture advice.
- Include confidence notes when a conclusion is inferred from indexes instead of source bodies.
- When "Focused Source Evidence" is present, inspect it before marking params, request/response fields, service calls, validations, repository behavior, or exceptions as missing.
- If an index is thin but focused source code shows the detail, use the source code and cite that file path.
- Do not expose secrets. Keep masked values masked.`;
}

function buildAgenticBackendUserPrompt(step: CopilotAgenticStep, contextPack: string, previousArtifacts: string): string {
  const previous = previousArtifacts.trim()
    ? `\n\nPrevious pipeline artifacts:\n${previousArtifacts}`
    : "";
  return `${agenticStepTask(step)}

Return Markdown only.
Step id: ${step}

Current repository context:
${contextPack}${previous}`;
}

function agenticStepTask(step: CopilotAgenticStep): string {
  switch (step) {
    case "plan":
      return `Create a documentation execution plan.
Include:
1. Visible modules/domains.
2. Endpoint groups to document.
3. Service/data/config/error areas to analyze.
4. Missing context risks.
5. Proposed final document sections.
Do not write the final documentation yet.`;
    case "api-analysis":
      return `Analyze API endpoints only.
For every visible endpoint include:
- HTTP method and path
- Controller and handler
- Request model/body if visible
- Response model/body if visible
- Auth/security hints if visible
- Error/status hints if visible
- Source file reference
- Confidence and missing details`;
    case "service-flow-analysis":
      return `Analyze service and business flows only.
Include:
- Controller to service flow
- Service dependencies
- Validation and business rules
- External calls/events if visible
- Edge cases and risks
- Source file references
- Confidence and missing details`;
    case "data-config-error-analysis":
      return `Analyze data, configuration, security, and error handling only.
Include:
- Entities, tables, fields, relationships
- Repository/data-access behavior
- Configuration keys and deployment notes
- Security/authentication/authorization hints
- Custom exceptions/global error handling
- Test coverage hints
- Source file references
- Confidence and missing details`;
    case "diagram-drafts":
      return `Create PlantUML diagram drafts from the previous artifacts and current context.
Include only grounded diagrams:
- Component diagram
- Sequence diagrams for major visible endpoints
- Activity diagram for visible complex flows
- Error handling flow when visible
- State machine only if status transitions are visible
Use fenced plantuml code blocks.`;
    case "final-synthesis":
      return `Synthesize the final end-to-end backend technical documentation from current context and previous artifacts.
Required sections:
1. Modul Genel Bakis
2. Mimari Bilesenler
3. API Endpoint Spesifikasyonlari
4. Veritabani Tasarimi
5. Is Mantigi Akislari
6. Entegrasyon Noktalari
7. Guvenlik
8. Hata Yonetimi
9. Performans Optimizasyonlari
10. Test Senaryolari
11. Deployment Notlari
12. Akis Diyagramlari
13. Kalite Kontrol Checklist
14. Sonuc Raporu
Mark missing details explicitly as "Not visible from provided context."`;
  }
}

export function buildCopilotMultiRepoAgenticPrompt(
  step: CopilotMultiRepoAgenticStep,
  contextPack: string,
  previousArtifacts = ""
): CopilotAgenticPromptRequest {
  const instructions = buildMultiRepoAgenticInstructions();
  const userPrompt = buildMultiRepoAgenticUserPrompt(step, contextPack, previousArtifacts);
  return {
    instructions,
    userPrompt,
    combinedText: `${instructions}\n\n${userPrompt}`,
    profile: "agentic-ui-bff-be-documentation",
    step
  };
}

function buildMultiRepoAgenticInstructions(): string {
  return `You are the reasoning engine inside a VS Code extension that orchestrates multi-step UI-BFF-BE technical documentation.

Important operating rules:
- The extension is the agent. You are one step in a controlled pipeline.
- Use only the provided local multi-repo artifacts and previous step artifacts.
- Do not invent pages, components, API calls, BFF endpoints, BE endpoints, tables, DTOs, integrations, tests, or business rules.
- If a detail is missing, write: "Not visible from provided context."
- Keep code identifiers, file paths, HTTP methods, endpoint paths, JSON fields, and PlantUML syntax exact.
- Write Turkish documentation text, but keep technical identifiers unchanged.
- Explain confidence and gaps when a flow is inferred from indexes rather than source bodies.
- Prioritize end-to-end traceability: UI interaction -> UI API client -> BFF endpoint -> BFF outbound call -> BE endpoint -> service/data/error behavior.
- When "Focused Source Evidence" is present for UI, BFF, or BE, inspect it before marking params, payloads, service calls, validations, repository behavior, exceptions, or UI state/form behavior as missing.
- If an index is thin but focused source code shows the detail, use the source code and cite that file path.
- Do not expose secrets. Keep masked values masked.`;
}

function buildMultiRepoAgenticUserPrompt(step: CopilotMultiRepoAgenticStep, contextPack: string, previousArtifacts: string): string {
  const previous = previousArtifacts.trim()
    ? `\n\nPrevious pipeline artifacts:\n${previousArtifacts}`
    : "";
  return `${multiRepoAgenticStepTask(step)}

Return Markdown only.
Step id: ${step}

Current multi-repo context:
${contextPack}${previous}`;
}

function multiRepoAgenticStepTask(step: CopilotMultiRepoAgenticStep): string {
  switch (step) {
    case "cross-layer-plan":
      return `Create a UI-BFF-BE documentation execution plan.
Include:
1. Visible application/page domains.
2. UI interaction and route groups.
3. BFF endpoint and outbound-call groups.
4. BE endpoint/service/data/error groups.
5. Traceability and quality risks.
6. Proposed final cross-layer document sections.
Do not write the final documentation yet.`;
    case "ui-analysis":
      return `Analyze the React UI layer only.
Include:
- Routes and pages
- Components and interactions
- API client calls
- Form/state observations
- Source references
- Missing details and confidence notes`;
    case "bff-analysis":
      return `Analyze the Spring BFF layer only.
Include:
- BFF controllers and endpoints
- BFF outbound calls to BE
- DTOs and request/response bridge behavior when visible
- Session/auth/header/cookie behavior when visible
- Source references
- Missing details and confidence notes`;
    case "be-analysis":
      return `Analyze the Spring BE layer only.
Include:
- BE controllers/endpoints
- Service flows
- Repository/data access
- Entities/tables/relationships
- Validations, exceptions, security/configuration/test hints
- Source references
- Missing details and confidence notes`;
    case "traceability-analysis":
      return `Analyze end-to-end traceability only.
Include:
- UI interaction -> BFF -> BE flow table
- Page/session/background flow classification
- Matched and unresolved calls
- Qwen page semantics if visible
- Knowledge graph and quality report findings if visible
- Risks and improvement actions`;
    case "cross-layer-diagrams":
      return `Create grounded PlantUML diagram drafts for the UI-BFF-BE system.
Include:
- Component diagram for UI, BFF, BE, database, external services
- Sequence diagrams for major visible end-to-end flows
- Activity diagram for login/session/background flows when visible
- Error handling flow when visible
- Data-flow diagram when visible
Use fenced plantuml code blocks.`;
    case "final-cross-layer-synthesis":
      return `Synthesize the final UI-BFF-BE end-to-end technical documentation.
Required sections:
1. Sistem Genel Bakis
2. UI Mimarisi
3. BFF Mimarisi
4. BE Mimarisi
5. Uctan Uca Akislar
6. API Endpoint Spesifikasyonlari
7. Veri Modeli ve Repository Katmani
8. Guvenlik, Session ve Header/Cookie Akislari
9. Hata Yonetimi
10. Performans ve Operasyonel Notlar
11. Test ve Kalite Durumu
12. PlantUML Akis Diyagramlari
13. Bilinen Eksikler ve Teknik Borc
14. Sonuc Raporu
Mark missing details explicitly as "Not visible from provided context."`;
  }
}
