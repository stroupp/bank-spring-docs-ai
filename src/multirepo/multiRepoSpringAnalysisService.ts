import * as fs from "fs/promises";
import * as path from "path";
import { BeServiceFlowExtractor } from "../analyzer/be/beServiceFlowExtractor";
import { ExceptionFlowExtractor } from "../analyzer/be/exceptionFlowExtractor";
import { JavaMethodCallExtractor } from "../analyzer/be/javaMethodCallExtractor";
import { RepositoryMethodExtractor } from "../analyzer/be/repositoryMethodExtractor";
import { ValidationExtractor } from "../analyzer/be/validationExtractor";
import { BffDtoExtractor } from "../analyzer/bff/bffDtoExtractor";
import { BffFlowIndexBuilder } from "../analyzer/bff/bffFlowIndexBuilder";
import { BffOutboundCallExtractor } from "../analyzer/bff/bffOutboundCallExtractor";
import { JavaDependencyExtractor } from "../analyzer/javaDependencyExtractor";
import { RepositoryScanner } from "../analyzer/repositoryScanner";
import { SpringComponentExtractor } from "../analyzer/springComponentExtractor";
import { SpringConfigurationExtractor } from "../analyzer/springConfigurationExtractor";
import { SpringEndpointExtractor } from "../analyzer/springEndpointExtractor";
import { SpringEntityExtractor } from "../analyzer/springEntityExtractor";
import { SpringModuleDetector } from "../analyzer/springModuleDetector";
import { SpringRepoMapBuilder } from "../analyzer/springRepoMapBuilder";
import { SpringTestExtractor } from "../analyzer/springTestExtractor";
import { parseBitbucketUrl } from "../git/bitbucketUrlParser";
import { ManifestService } from "../storage/manifestService";
import { writeJsonl } from "../storage/jsonlWriter";
import { atomicWriteFile } from "../storage/atomicFile";
import { PipelineArtifactReceiptService } from "./pipelineArtifactReceiptService";
import { assertPathContainedForWrite } from "../storage/localStorageService";

export interface MultiRepoSpringAnalysisInput {
  repoUrl: string;
  repoRoot: string;
  outputRoot: string;
  branch: string;
  pipelineIdentity?: string;
  repositoryName?: string;
  role?: "bff" | "be";
}

export interface MultiRepoSpringAnalysisResult {
  repositoryName: string;
  outputRoot: string;
  indexedFiles: number;
  endpoints: number;
  components: number;
  entities: number;
}

export class MultiRepoSpringAnalysisService {
  constructor(private readonly scanner = new RepositoryScanner()) {}

  async analyze(input: MultiRepoSpringAnalysisInput): Promise<MultiRepoSpringAnalysisResult> {
    await assertPathContainedForWrite(path.dirname(input.outputRoot), input.outputRoot);
    await fs.mkdir(input.outputRoot, { recursive: true });
    await assertPathContainedForWrite(path.dirname(input.outputRoot), input.outputRoot);
    await fs.rm(path.join(input.outputRoot, "manifest.json"), { force: true });
    await new PipelineArtifactReceiptService().invalidateTraceability(path.dirname(input.outputRoot));

    const files = await this.scanner.scan(input.repoRoot);
    const buildTool = this.scanner.detectBuildTool(files);
    const components = new SpringComponentExtractor().extract(files);
    const endpoints = new SpringEndpointExtractor().extract(files);
    const entities = new SpringEntityExtractor().extract(files);
    const dependencies = new JavaDependencyExtractor().extract(files);
    const configurations = new SpringConfigurationExtractor().extract(files);
    const tests = new SpringTestExtractor().extract(files);
    const modules = new SpringModuleDetector().build(components);
    const repositoryName = input.repositoryName ?? this.detectRepositoryName(input.repoUrl, input.repoRoot, input.branch);

    await writeJsonl(path.join(input.outputRoot, "file-index.jsonl"), files.map((file) => ({
      file: file.file,
      kind: file.kind,
      classification: file.classification,
      extension: file.extension,
      size: file.size,
      modulePath: file.modulePath,
      sourceSet: file.sourceSet,
      sourceRoot: file.sourceRoot
    })));
    await writeJsonl(path.join(input.outputRoot, "spring-components.jsonl"), components);
    await writeJsonl(path.join(input.outputRoot, "api-endpoints.jsonl"), endpoints);
    await writeJsonl(path.join(input.outputRoot, "entity-index.jsonl"), entities);
    await writeJsonl(path.join(input.outputRoot, "dependency-graph.jsonl"), dependencies);
    await writeJsonl(path.join(input.outputRoot, "configuration-index.jsonl"), configurations);
    await writeJsonl(path.join(input.outputRoot, "test-index.jsonl"), tests);
    await new SpringModuleDetector().write(input.outputRoot, modules);

    if (input.role === "bff") {
      const outboundCalls = new BffOutboundCallExtractor().extract(files);
      const dtos = new BffDtoExtractor().extract(files);
      const methodCalls = new JavaMethodCallExtractor().extract(files);
      const bffFlows = new BffFlowIndexBuilder().build(endpoints, components, outboundCalls, methodCalls);
      await writeJsonl(path.join(input.outputRoot, "outbound-calls.jsonl"), outboundCalls);
      await writeJsonl(path.join(input.outputRoot, "dto-index.jsonl"), dtos);
      await writeJsonl(path.join(input.outputRoot, "bff-flow-index.jsonl"), bffFlows);
    }

    if (input.role === "be") {
      const repositoryMethods = new RepositoryMethodExtractor().extract(files);
      const validations = new ValidationExtractor().extract(files);
      const exceptions = new ExceptionFlowExtractor().extract(files);
      const dtos = new BffDtoExtractor().extract(files);
      const methodCalls = new JavaMethodCallExtractor().extract(files);
      const serviceFlows = new BeServiceFlowExtractor().extract(endpoints, components, entities, repositoryMethods, methodCalls);
      await writeJsonl(path.join(input.outputRoot, "service-flow-index.jsonl"), serviceFlows);
      await writeJsonl(path.join(input.outputRoot, "java-method-call-index.jsonl"), methodCalls);
      await writeJsonl(path.join(input.outputRoot, "repository-method-index.jsonl"), repositoryMethods);
      await writeJsonl(path.join(input.outputRoot, "validation-index.jsonl"), validations);
      await writeJsonl(path.join(input.outputRoot, "exception-flow-index.jsonl"), exceptions);
      await writeJsonl(path.join(input.outputRoot, "dto-index.jsonl"), dtos);
    }

    const repoMap = new SpringRepoMapBuilder().build({
      repositoryName,
      branch: input.branch,
      buildTool,
      files,
      components,
      endpoints,
      entities
    });
    await atomicWriteFile(path.join(input.outputRoot, "repo-map.md"), repoMap);
    await new ManifestService().write(input.outputRoot, {
      repositoryUrl: input.repoUrl,
      repositoryName,
      branch: input.branch,
      pipelineIdentity: input.pipelineIdentity,
      buildTool,
      generatedAt: new Date().toISOString()
    });

    return {
      repositoryName,
      outputRoot: input.outputRoot,
      indexedFiles: files.length,
      endpoints: endpoints.length,
      components: components.length,
      entities: entities.length
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
