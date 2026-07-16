import * as vscode from "vscode";
import { generateAnalysisQualityReportCommand } from "./commands/analysisQualityReportCommand";
import { AnalyzeRepositoryUrlCommand } from "./commands/analyzeRepositoryUrlCommand";
import { clearLocalCacheCommand } from "./commands/clearLocalCacheCommand";
import { runCopilotDiagnosticsCommand } from "./commands/copilotDiagnosticsCommand";
import { generateAgenticCopilotBackendDocsCommand, generateAllCopilotDocsCommand, generateAllLocalDocsCommand, openCopilotAuditLogCommand, openLastCopilotContextCommand, openLastCopilotContextSelectionCommand, openLastCopilotPromptCommand } from "./commands/generateAllDocsCommands";
import { generateApiDocumentationCommand } from "./commands/generateApiDocumentationCommand";
import { generateConfigurationDocumentationCommand } from "./commands/generateConfigurationDocumentationCommand";
import { generateCopilotDocCommand } from "./commands/generateCopilotDocCommand";
import { generateEntityDocumentationCommand } from "./commands/generateEntityDocumentationCommand";
import { generateExternalIntegrationsDocCommand } from "./commands/generateExternalIntegrationsDocCommand";
import { generateRepositoryLayerDocCommand } from "./commands/generateRepositoryLayerDocCommand";
import { generateRepositoryOverviewCommand } from "./commands/generateRepositoryOverviewCommand";
import { generateServiceLayerDocCommand } from "./commands/generateServiceLayerDocCommand";
import { generateSpringArchitectureDocCommand } from "./commands/generateSpringArchitectureDocCommand";
import { generateTechnicalAnalysisCommand } from "./commands/generateTechnicalAnalysisCommand";
import { generateTestAnalysisCommand } from "./commands/generateTestAnalysisCommand";
import { indexCurrentRepositoryCommand } from "./commands/indexCurrentRepositoryCommand";
import {
  analyzeMultiReposLocallyCommand,
  cloneOrUpdateMultiReposCommand,
  generateEndToEndFlowMapCommand,
  generateLocalKnowledgeGraphCommand,
  generateMultiRepoAgenticCopilotDocsCommand,
  generateMultiRepoQualityReportCommand,
  generateQwenPageSemanticsCommand,
  generateReactUiAnalysisCommand,
  multiRepoPhaseNotImplementedCommand,
  openMultiRepoOutputFolderCommand,
  openUnresolvedMultiRepoMatchesCommand,
  openUiBffBeAnalysisPanelCommand,
  saveMultiRepoManifestCommand
} from "./commands/multiRepoCommands";
import { openGeneratedDocsCommand } from "./commands/openGeneratedDocsCommand";
import { openDevAuditsCommand } from "./commands/openDevAuditsCommand";
import { openRepoMapCommand } from "./commands/openRepoMapCommand";
import { analyzeSelectedPageCommand, buildFinalSelectedPageDocumentCommand, buildPageListCommand, detectSelectedPageDocumentGapsCommand, generateSelectedPageCopilotDraftCommand, generateSelectedPageQwenSemanticsCommand, getSelectedPageCommand, openFinalSelectedPageDocumentCommand, openSelectedPageContextPackCommand, openSelectedPageEvidencePackCommand, repairSelectedPageDocumentGapsCommand, runFullSelectedPageAnalysisCommand, scoreSelectedPageDocumentCommand } from "./commands/pageAnalysisCommands";
import { saveQwenSettingsCommand, testQwenConnectionCommand } from "./commands/qwenCommands";
import { generateEnrichedRepoMapCommand, generateQwenSemanticAnalysisCommand } from "./commands/qwenSemanticCommands";
import { Logger } from "./utils/logger";
import { BankSpringDocsPanel } from "./views/bankSpringDocsPanel";
import { BankSpringDocsViewProvider } from "./views/bankSpringDocsViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  const analyzeCommand = new AnalyzeRepositoryUrlCommand(context, logger);
  const dashboardProvider = new BankSpringDocsViewProvider(context, analyzeCommand);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BankSpringDocsViewProvider.viewType, dashboardProvider),
    vscode.commands.registerCommand("bankSpringDocs.openDashboard", () => BankSpringDocsPanel.open(context, analyzeCommand)),
    vscode.commands.registerCommand("bankSpringDocs.openRepoMap", () => openRepoMapCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openGeneratedDocs", () => openGeneratedDocsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.analyzeRepositoryUrl", () => analyzeCommand.run()),
    vscode.commands.registerCommand("bankSpringDocs.indexCurrentRepository", () => indexCurrentRepositoryCommand()),
    vscode.commands.registerCommand("bankSpringDocs.generateRepositoryOverview", () => generateRepositoryOverviewCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateSpringArchitectureDocumentation", () => generateSpringArchitectureDocCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateApiDocumentation", () => generateApiDocumentationCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateServiceLayerDocumentation", () => generateServiceLayerDocCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateRepositoryLayerDocumentation", () => generateRepositoryLayerDocCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateEntityDocumentation", () => generateEntityDocumentationCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateConfigurationDocumentation", () => generateConfigurationDocumentationCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateExternalIntegrationsDocumentation", () => generateExternalIntegrationsDocCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateTestAnalysis", () => generateTestAnalysisCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateTechnicalAnalysis", () => generateTechnicalAnalysisCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotRepositoryOverview", () => generateCopilotDocCommand(context, "repository-overview")),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotSpringArchitecture", () => generateCopilotDocCommand(context, "spring-architecture")),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotApiDocumentation", () => generateCopilotDocCommand(context, "api-endpoints")),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotServiceLayer", () => generateCopilotDocCommand(context, "service-layer")),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotConfiguration", () => generateCopilotDocCommand(context, "configuration")),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotTestAnalysis", () => generateCopilotDocCommand(context, "test-analysis")),
    vscode.commands.registerCommand("bankSpringDocs.generateCopilotTechnicalAnalysis", () => generateCopilotDocCommand(context, "technical-analysis")),
    vscode.commands.registerCommand("bankSpringDocs.testQwenConnection", (settings) => testQwenConnectionCommand(context, settings)),
    vscode.commands.registerCommand("bankSpringDocs.saveQwenSettings", (settings) => saveQwenSettingsCommand(context, settings)),
    vscode.commands.registerCommand("bankSpringDocs.generateQwenSemanticAnalysis", () => generateQwenSemanticAnalysisCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateEnrichedRepoMap", () => generateEnrichedRepoMapCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateAnalysisQualityReport", () => generateAnalysisQualityReportCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateAllLocalDocs", () => generateAllLocalDocsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateAllCopilotDocs", () => generateAllCopilotDocsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateAgenticCopilotBackendDocs", () => generateAgenticCopilotBackendDocsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openLastCopilotContext", () => openLastCopilotContextCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openLastCopilotContextSelection", () => openLastCopilotContextSelectionCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openLastCopilotPrompt", () => openLastCopilotPromptCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openCopilotAuditLog", () => openCopilotAuditLogCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.runCopilotDiagnostics", () => runCopilotDiagnosticsCommand()),
    vscode.commands.registerCommand("bankSpringDocs.openUiBffBeAnalysisPanel", () => openUiBffBeAnalysisPanelCommand()),
    vscode.commands.registerCommand("bankSpringDocs.saveMultiRepoManifest", (input) => saveMultiRepoManifestCommand(context, input)),
    vscode.commands.registerCommand("bankSpringDocs.cloneOrUpdateMultiRepos", (input) => cloneOrUpdateMultiReposCommand(context, input)),
    vscode.commands.registerCommand("bankSpringDocs.analyzeMultiReposLocally", () => analyzeMultiReposLocallyCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateReactUiAnalysis", () => generateReactUiAnalysisCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateEndToEndFlowMap", () => generateEndToEndFlowMapCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateQwenPageSemantics", () => generateQwenPageSemanticsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateLocalKnowledgeGraph", () => generateLocalKnowledgeGraphCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateMultiRepoQualityReport", () => generateMultiRepoQualityReportCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateMultiRepoAgenticCopilotDocs", () => generateMultiRepoAgenticCopilotDocsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.buildPageList", () => buildPageListCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.getSelectedPage", () => getSelectedPageCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.analyzeSelectedPage", () => analyzeSelectedPageCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openSelectedPageContextPack", () => openSelectedPageContextPackCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openSelectedPageEvidencePack", () => openSelectedPageEvidencePackCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateSelectedPageQwenSemantics", () => generateSelectedPageQwenSemanticsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.generateSelectedPageCopilotDraft", () => generateSelectedPageCopilotDraftCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.detectSelectedPageDocumentGaps", () => detectSelectedPageDocumentGapsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.repairSelectedPageDocumentGaps", () => repairSelectedPageDocumentGapsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.buildFinalSelectedPageDocument", () => buildFinalSelectedPageDocumentCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openFinalSelectedPageDocument", () => openFinalSelectedPageDocumentCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.scoreSelectedPageDocument", () => scoreSelectedPageDocumentCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.runFullSelectedPageAnalysis", (options) => runFullSelectedPageAnalysisCommand(context, options)),
    vscode.commands.registerCommand("bankSpringDocs.generatePageTechnicalAnalysis", () => analyzeSelectedPageCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openUnresolvedMultiRepoMatches", () => openUnresolvedMultiRepoMatchesCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openMultiRepoOutputFolder", () => openMultiRepoOutputFolderCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.openDevAudits", () => openDevAuditsCommand(context)),
    vscode.commands.registerCommand("bankSpringDocs.clearLocalCache", () => clearLocalCacheCommand(context))
  );

  logger.info("Bank Spring Docs AI activated.");
}

export function deactivate(): void {
  // No background resources to dispose.
}
