import * as fs from "fs/promises";
import * as path from "path";
import { ReactApiCallExtractor } from "../analyzer/ui/reactApiCallExtractor";
import { ReactComponentExtractor } from "../analyzer/ui/reactComponentExtractor";
import { ReactFormFieldExtractor } from "../analyzer/ui/reactFormFieldExtractor";
import { ReactInteractionExtractor } from "../analyzer/ui/reactInteractionExtractor";
import { ReactRepoMapBuilder } from "../analyzer/ui/reactRepoMapBuilder";
import { ReactRepositoryScanner } from "../analyzer/ui/reactRepositoryScanner";
import { ReactRouteExtractor } from "../analyzer/ui/reactRouteExtractor";
import { ReactStateExtractor } from "../analyzer/ui/reactStateExtractor";
import { parseBitbucketUrl } from "../git/bitbucketUrlParser";
import { writeJsonl } from "../storage/jsonlWriter";

export interface MultiRepoReactAnalysisInput {
  repoUrl: string;
  repoRoot: string;
  outputRoot: string;
  branch: string;
}

export interface MultiRepoReactAnalysisResult {
  repositoryName: string;
  outputRoot: string;
  indexedFiles: number;
  routes: number;
  pages: number;
  components: number;
  apiCalls: number;
}

export class MultiRepoReactAnalysisService {
  constructor(private readonly scanner = new ReactRepositoryScanner()) {}

  async analyze(input: MultiRepoReactAnalysisInput): Promise<MultiRepoReactAnalysisResult> {
    await fs.mkdir(input.outputRoot, { recursive: true });
    const files = await this.scanner.scan(input.repoRoot);
    const indicators = this.scanner.detectIndicators(files);
    const routes = new ReactRouteExtractor().extract(files);
    const components = new ReactComponentExtractor().extract(files, routes);
    const interactions = new ReactInteractionExtractor().extract(files, components);
    const apiCalls = new ReactApiCallExtractor().extract(files, components);
    const formFields = new ReactFormFieldExtractor().extract(files, components);
    const states = new ReactStateExtractor().extract(files, components);
    const repositoryName = this.detectRepositoryName(input.repoUrl, input.repoRoot, input.branch);

    await writeJsonl(path.join(input.outputRoot, "file-index.jsonl"), files.map((file) => ({
      file: file.file,
      classification: file.classification,
      extension: file.extension,
      size: file.size
    })));
    await writeJsonl(path.join(input.outputRoot, "route-index.jsonl"), routes);
    await writeJsonl(path.join(input.outputRoot, "page-index.jsonl"), components.filter((component) => component.classification === "page").map((component) => ({
      page: component.component,
      route: component.route,
      file: component.file,
      imports: component.imports,
      confidence: component.confidence
    })));
    await writeJsonl(path.join(input.outputRoot, "component-index.jsonl"), components);
    await writeJsonl(path.join(input.outputRoot, "interaction-index.jsonl"), interactions);
    await writeJsonl(path.join(input.outputRoot, "api-call-index.jsonl"), apiCalls);
    await writeJsonl(path.join(input.outputRoot, "form-field-index.jsonl"), formFields);
    await writeJsonl(path.join(input.outputRoot, "state-index.jsonl"), states);

    const repoMap = new ReactRepoMapBuilder().build({
      repositoryName,
      branch: input.branch,
      indicators,
      files,
      routes,
      components,
      interactions,
      apiCalls,
      formFields,
      states
    });
    await fs.writeFile(path.join(input.outputRoot, "repo-map.md"), repoMap, "utf8");
    await fs.writeFile(path.join(input.outputRoot, "manifest.json"), JSON.stringify({
      repositoryUrl: input.repoUrl,
      repositoryName,
      branch: input.branch,
      generatedAt: new Date().toISOString(),
      framework: "React",
      indicators
    }, null, 2), "utf8");

    return {
      repositoryName,
      outputRoot: input.outputRoot,
      indexedFiles: files.length,
      routes: routes.length,
      pages: components.filter((component) => component.classification === "page").length,
      components: components.length,
      apiCalls: apiCalls.length
    };
  }

  private detectRepositoryName(repoUrl: string, repoRoot: string, branch: string): string {
    try {
      return parseBitbucketUrl(repoUrl, branch).repo;
    } catch {
      return path.basename(repoRoot);
    }
  }
}
