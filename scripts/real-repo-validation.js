const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "test-fixtures", "real-repos.json");
const reportPath = path.join(projectRoot, ".ai-docs", "dev-audits", "real-repo-validation-report.md");

async function main() {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const workspace = path.resolve(projectRoot, config.workspace);
  const offline = process.env.REAL_REPO_VALIDATION_OFFLINE === "1" || process.argv.includes("--offline");
  await fs.mkdir(workspace, { recursive: true });

  const results = [];
  for (const repo of config.repos) {
    const target = path.join(workspace, safeName(repo.name));
    const item = {
      name: repo.name,
      url: repo.url,
      branch: repo.branch,
      resolvedBranch: undefined,
      type: repo.type,
      description: repo.description,
      cloneStatus: "not-attempted",
      analyses: [],
      warnings: []
    };
    try {
      const available = await directoryExists(target);
      if (offline && !available) {
        item.cloneStatus = "skipped-offline";
        item.warnings.push("Network validation was disabled and no cached clone exists.");
      } else if (available) {
        item.cloneStatus = "cached";
        if (!offline) {
          const update = runGit(["-c", "core.longpaths=true", "fetch", "--depth=1", "origin", repo.branch], target);
          if (update.ok) {
            const checkout = runGit(["-c", "core.longpaths=true", "checkout", repo.branch], target);
            const reset = checkout.ok
              ? runGit(["-c", "core.longpaths=true", "reset", "--hard", `origin/${repo.branch}`], target)
              : checkout;
            if (reset.ok) {
              item.cloneStatus = "updated";
            } else {
              item.warnings.push(`Configured branch update failed; cached source was used: ${reset.message}`);
            }
          } else {
            const currentBranch = readGitValue(["rev-parse", "--abbrev-ref", "HEAD"], target);
            const fallbackUpdate = currentBranch
              ? runGit(["-c", "core.longpaths=true", "fetch", "--depth=1", "origin", currentBranch], target)
              : { ok: false, message: "The cached clone's current branch could not be resolved." };
            const fallbackReset = fallbackUpdate.ok
              ? runGit(["-c", "core.longpaths=true", "reset", "--hard", `origin/${currentBranch}`], target)
              : fallbackUpdate;
            if (fallbackReset.ok) {
              item.cloneStatus = "updated-default-branch";
              item.warnings.push(`Configured branch '${repo.branch}' was unavailable; updated cached branch '${currentBranch}' instead.`);
            } else {
              item.warnings.push(`Cached clone update failed; cached source was used: ${update.message}`);
            }
          }
        }
      } else {
        const clone = runGit(["-c", "core.longpaths=true", "clone", "--depth=1", "--branch", repo.branch, repo.url, target], projectRoot);
        item.cloneStatus = clone.ok ? "cloned" : "clone-failed";
        if (!clone.ok) {
          const fallback = await directoryExists(target)
            ? { ok: false, message: "The failed clone left a target directory, so a default-branch retry was skipped." }
            : runGit(["-c", "core.longpaths=true", "clone", "--depth=1", repo.url, target], projectRoot);
          if (fallback.ok) {
            item.cloneStatus = "cloned-default-branch";
            item.warnings.push(`Configured branch '${repo.branch}' was unavailable; the remote default branch was cloned instead.`);
          } else {
            item.warnings.push(clone.message);
            if (fallback.message !== clone.message) {
              item.warnings.push(`Default-branch clone retry also failed: ${fallback.message}`);
            }
          }
        }
      }

      if (await directoryExists(target)) {
        item.resolvedBranch = readGitValue(["rev-parse", "--abbrev-ref", "HEAD"], target) || undefined;
        if (repo.type === "spring-be") {
          item.analyses.push(await analyzeSpring(target, "be"));
        } else {
          for (const role of ["ui", "bff", "be"]) {
            const relative = repo.paths?.[role];
            const roleRoot = relative ? path.join(target, relative) : target;
            if (!await directoryExists(roleRoot)) {
              item.warnings.push(`Configured ${role} path is missing: ${relative ?? "."}`);
              continue;
            }
            item.analyses.push(role === "ui" ? await analyzeReact(roleRoot) : await analyzeSpring(roleRoot, role));
          }
        }
      }
    } catch (error) {
      item.warnings.push(error instanceof Error ? error.message : String(error));
    }
    results.push(item);
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, renderReport(results, offline), "utf8");
  const analyzed = results.reduce((sum, item) => sum + item.analyses.length, 0);
  const warnings = results.reduce((sum, item) => sum + item.warnings.length, 0);
  console.log(`Real repo validation completed: ${analyzed} analyzer runs, ${warnings} warnings. Report: ${reportPath}`);
}

async function analyzeSpring(repoRoot, role) {
  const { RepositoryScanner } = require("../dist/analyzer/repositoryScanner");
  const { SpringComponentExtractor } = require("../dist/analyzer/springComponentExtractor");
  const { SpringEndpointExtractor } = require("../dist/analyzer/springEndpointExtractor");
  const { SpringEntityExtractor } = require("../dist/analyzer/springEntityExtractor");
  const { BffOutboundCallExtractor } = require("../dist/analyzer/bff/bffOutboundCallExtractor");
  const { JavaMethodCallExtractor } = require("../dist/analyzer/be/javaMethodCallExtractor");
  const files = await new RepositoryScanner().scan(repoRoot);
  const endpoints = new SpringEndpointExtractor().extract(files);
  const components = new SpringComponentExtractor().extract(files);
  const entities = new SpringEntityExtractor().extract(files);
  const roleSpecific = role === "bff"
    ? { outboundCalls: new BffOutboundCallExtractor().extract(files).length }
    : { methodCalls: new JavaMethodCallExtractor().extract(files).length };
  return {
    role,
    root: path.relative(projectRoot, repoRoot),
    files: files.length,
    endpoints: endpoints.length,
    components: components.length,
    entities: entities.length,
    ...roleSpecific
  };
}

async function analyzeReact(repoRoot) {
  const { ReactRepositoryScanner } = require("../dist/analyzer/ui/reactRepositoryScanner");
  const { ReactRouteExtractor } = require("../dist/analyzer/ui/reactRouteExtractor");
  const { ReactComponentExtractor } = require("../dist/analyzer/ui/reactComponentExtractor");
  const { ReactApiCallExtractor } = require("../dist/analyzer/ui/reactApiCallExtractor");
  const files = await new ReactRepositoryScanner().scan(repoRoot);
  const routes = new ReactRouteExtractor().extract(files);
  const components = new ReactComponentExtractor().extract(files, routes);
  const apiCalls = new ReactApiCallExtractor().extract(files, components);
  return {
    role: "ui",
    root: path.relative(projectRoot, repoRoot),
    files: files.length,
    routes: routes.length,
    components: components.length,
    apiCalls: apiCalls.length
  };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return {
    ok: result.status === 0,
    message: (result.stderr || result.stdout || `git exited with ${result.status}`).trim().slice(0, 600)
  };
}

function readGitValue(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

function renderReport(results, offline) {
  const analyzerRuns = results.reduce((sum, item) => sum + item.analyses.length, 0);
  const warnings = results.reduce((sum, item) => sum + item.warnings.length, 0);
  const lines = [
    "# Real Repo Validation Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Mode: ${offline ? "offline/cached-only" : "network-enabled with graceful fallback"}`,
    "",
    "## Run Summary",
    "",
    `- Repositories configured: ${results.length}`,
    `- Analyzer runs completed: ${analyzerRuns}`,
    `- Warnings: ${warnings}`,
    "- AI calls: 0",
    "",
    "The runner does not import or invoke Qwen, Copilot, or other AI clients. Its only network operations are Git clone/fetch commands; repository source remained local and was processed only by deterministic analyzers.",
    ""
  ];
  for (const item of results) {
    lines.push(
      `## ${item.name}`,
      "",
      `- URL: ${item.url}`,
      `- Configured branch: ${item.branch}`,
      `- Analyzed branch: ${item.resolvedBranch ?? "not available"}`,
      `- Type: ${item.type}`,
      `- Clone status: ${item.cloneStatus}`,
      `- Description: ${item.description}`,
      "",
      "### Analyzer Results",
      "",
      item.analyses.length ? "```json" : "No analyzer result was produced.",
      ...(item.analyses.length ? [JSON.stringify(item.analyses, null, 2), "```"] : []),
      "",
      "### Warnings",
      "",
      ...(item.warnings.length ? item.warnings.map((warning) => `- ${warning}`) : ["- None"]),
      ""
    );
  }
  lines.push(
    "## Interpretation",
    "",
    "This runner is diagnostic. Clone/network failures are warnings and do not fail compile or automated tests. Fixture tests remain the reproducible regression gate.",
    ""
  );
  return lines.join("\n");
}

async function directoryExists(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

main().catch(async (error) => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `# Real Repo Validation Report\n\nValidation runner warning: ${error instanceof Error ? error.message : String(error)}\n`, "utf8");
  console.warn(`Real repo validation finished with a non-fatal warning: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
