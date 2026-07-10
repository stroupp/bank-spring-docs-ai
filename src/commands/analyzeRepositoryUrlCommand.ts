import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { RepositoryScanner } from "../analyzer/repositoryScanner";
import { SpringComponentExtractor } from "../analyzer/springComponentExtractor";
import { SpringEndpointExtractor } from "../analyzer/springEndpointExtractor";
import { SpringEntityExtractor } from "../analyzer/springEntityExtractor";
import { SpringRepoMapBuilder } from "../analyzer/springRepoMapBuilder";
import { JavaDependencyExtractor } from "../analyzer/javaDependencyExtractor";
import { SpringConfigurationExtractor } from "../analyzer/springConfigurationExtractor";
import { SpringTestExtractor } from "../analyzer/springTestExtractor";
import { SpringModuleDetector } from "../analyzer/springModuleDetector";
import { generateAllLocalDocs } from "../docs/localDocsBatchGenerator";
import { parseBitbucketUrl } from "../git/bitbucketUrlParser";
import { getDefaultBranch, resolveBranch } from "../git/branchResolver";
import { GitService } from "../git/gitService";
import { LocalStorageService } from "../storage/localStorageService";
import { ManifestService } from "../storage/manifestService";
import { AnalysisStateService } from "../storage/analysisStateService";
import { writeJsonl } from "../storage/jsonlWriter";
import { Logger } from "../utils/logger";

export class AnalyzeRepositoryUrlCommand {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly gitService = new GitService(),
    private readonly storage = new LocalStorageService(context),
    private readonly scanner = new RepositoryScanner()
  ) {}

  async run(): Promise<void> {
    const repoUrl = await vscode.window.showInputBox({
      title: "Bank Spring Docs: Analyze Repository URL",
      prompt: "Enter Bitbucket repository URL",
      placeHolder: "ssh://git@bitbucket.bank.local/project/repo.git",
      ignoreFocusOut: true
    });

    if (!repoUrl) {
      return;
    }

    const defaultBranch = getDefaultBranch();
    const branchInput = await vscode.window.showInputBox({
      title: "Bank Spring Docs: Branch",
      prompt: `Enter branch name. Leave empty to use ${defaultBranch}.`,
      value: defaultBranch,
      ignoreFocusOut: true
    });

    const branch = resolveBranch(branchInput, defaultBranch);
    await this.analyzeWithRetry(repoUrl, branch, defaultBranch);
  }

  private async analyzeWithRetry(repoUrl: string, branch: string, defaultBranch: string): Promise<void> {
    try {
      await this.analyzeRepository(repoUrl, branch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (branch === defaultBranch && /branch/i.test(message)) {
        const alternate = await vscode.window.showInputBox({
          title: "Bank Spring Docs: Branch Not Found",
          prompt: `${defaultBranch} was not available. Enter another branch name.`,
          ignoreFocusOut: true
        });
        if (alternate?.trim()) {
      await this.analyzeRepository(repoUrl, alternate.trim());
          return;
        }
      }
      this.logger.error("Analyze repository failed", error);
      vscode.window.showErrorMessage(message);
    }
  }

  async analyzeRepository(repoUrl: string, branch: string): Promise<{ repoRoot: string; aiDocsPath: string; indexedFiles: number }> {
    let result: { repoRoot: string; aiDocsPath: string; indexedFiles: number } | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Bank Spring Docs: Analyzing repository",
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: "Preparing local repository..." });
        const parsed = parseBitbucketUrl(repoUrl, branch);
        const targetDir = path.join(this.storage.getCloneRoot(), parsed.safeFolderName);

        progress.report({ message: `Cloning or updating ${branch}...` });
        await this.gitService.cloneOrUpdate(repoUrl, branch, targetDir);

        progress.report({ message: "Creating .ai-docs folder..." });
        const aiDocsPath = await this.storage.ensureAiDocs(targetDir);

        progress.report({ message: "Scanning Java Spring files..." });
        const files = await this.scanner.scan(targetDir);
        const buildTool = this.scanner.detectBuildTool(files);

        progress.report({ message: "Extracting Spring indexes..." });
        const components = new SpringComponentExtractor().extract(files);
        const endpoints = new SpringEndpointExtractor().extract(files);
        const entities = new SpringEntityExtractor().extract(files);
        const dependencies = new JavaDependencyExtractor().extract(files);
        const configurations = new SpringConfigurationExtractor().extract(files);
        const tests = new SpringTestExtractor().extract(files);
        const modules = new SpringModuleDetector().build(components);

        await writeJsonl(path.join(aiDocsPath, "file-index.jsonl"), files.map((file) => ({
          file: file.file,
          kind: file.kind,
          classification: file.classification,
          extension: file.extension,
          size: file.size
        })));
        await writeJsonl(path.join(aiDocsPath, "spring-components.jsonl"), components);
        await writeJsonl(path.join(aiDocsPath, "api-endpoints.jsonl"), endpoints);
        await writeJsonl(path.join(aiDocsPath, "entity-index.jsonl"), entities);
        await writeJsonl(path.join(aiDocsPath, "dependency-graph.jsonl"), dependencies);
        await writeJsonl(path.join(aiDocsPath, "configuration-index.jsonl"), configurations);
        await writeJsonl(path.join(aiDocsPath, "test-index.jsonl"), tests);
        await new SpringModuleDetector().write(aiDocsPath, modules);

        const repoMap = new SpringRepoMapBuilder().build({
          repositoryName: parsed.repo,
          branch,
          buildTool,
          files,
          components,
          endpoints,
          entities
        });
        await fs.writeFile(path.join(aiDocsPath, "repo-map.md"), repoMap, "utf8");
        await new ManifestService().write(aiDocsPath, {
          repositoryUrl: repoUrl,
          repositoryName: parsed.repo,
          branch,
          buildTool,
          generatedAt: new Date().toISOString()
        });
        await new AnalysisStateService(this.context).setLastAnalysis({
          repoRoot: targetDir,
          aiDocsPath,
          repositoryName: parsed.repo,
          branch,
          updatedAt: new Date().toISOString()
        });

        progress.report({ message: "Generating local documentation..." });
        const localDocs = await generateAllLocalDocs(aiDocsPath);

        this.logger.info(`Analyzed ${repoUrl} branch ${branch}. Indexes and ${localDocs.generatedPaths.length} local docs written to ${aiDocsPath}`);
        result = { repoRoot: targetDir, aiDocsPath, indexedFiles: files.length };
        vscode.window.showInformationMessage(`Bank Spring Docs: Analiz tamamlandı. ${files.length} dosya indekslendi.`);
      }
    );
    if (!result) {
      throw new Error("Analiz tamamlanamadı.");
    }
    return result;
  }
}
