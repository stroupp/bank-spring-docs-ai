import { safeName } from "../utils/pathUtils";
import { sha256 } from "../utils/hash";
import { assertRepositoryUrlHasNoEmbeddedCredentials, repositoryOriginIdentity } from "../utils/repositoryUrl";

export interface ParsedBitbucketUrl {
  host: string;
  project: string;
  repo: string;
  safeFolderName: string;
}

function stripGit(value: string): string {
  return value.replace(/\.git$/i, "");
}

export function parseBitbucketUrl(repoUrl: string, branch: string): ParsedBitbucketUrl {
  const trimmed = repoUrl.trim();
  if (!trimmed) {
    throw new Error("Repository URL is required.");
  }
  assertRepositoryUrlHasNoEmbeddedCredentials(trimmed);

  let host = "";
  let parts: string[] = [];

  if (trimmed.startsWith("ssh://")) {
    const url = new URL(trimmed);
    host = url.hostname;
    parts = url.pathname.split("/").filter(Boolean);
  } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    host = url.hostname;
    parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === "scm") {
      parts = parts.slice(1);
    }
  } else {
    const sshMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (!sshMatch) {
      throw new Error("Unsupported Bitbucket URL. Use HTTPS or SSH.");
    }
    host = sshMatch[1];
    parts = sshMatch[2].split("/").filter(Boolean);
  }

  if (parts.length < 2) {
    throw new Error("Could not detect Bitbucket project and repository from URL.");
  }

  const project = parts[parts.length - 2];
  const repo = stripGit(parts[parts.length - 1]);
  const slug = [
    safeName(host).replaceAll("-", "-"),
    safeName(project),
    safeName(repo),
    safeName(branch).replaceAll("/", "-")
  ].join("_");
  const safeFolderName = `${slug.slice(0, 96)}_${sha256(`${repositoryOriginIdentity(trimmed)}:${branch}`).slice(0, 12)}`;

  return { host, project, repo, safeFolderName };
}
