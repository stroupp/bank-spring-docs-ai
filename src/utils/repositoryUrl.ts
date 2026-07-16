export function repositoryUrlForArtifact(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (/^(?:https?|ssh):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      // Fall through to the conservative string sanitization below.
    }
  }
  return trimmed
    .replace(/^(?:[^@/]+@)(?=[^:/]+:)/, "")
    .replace(/[?#].*$/, "");
}

export function repositoryUrlForStorage(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (/^(?:https?|ssh):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parsed.username = "";
      }
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return trimmed.replace(/[?#].*$/, "");
    }
  }
  return trimmed.replace(/[?#].*$/, "");
}

export function assertRepositoryUrlHasNoEmbeddedCredentials(repoUrl: string): void {
  const trimmed = repoUrl.trim();
  if (/^(?:https?|ssh):\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return;
    }
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (parsed.password || (isHttp && parsed.username) || parsed.search || parsed.hash) {
      throw new Error(
        "Repository URLs must not contain embedded credentials, query parameters, or fragments. Use Git Credential Manager or SSH keys."
      );
    }
    return;
  }
  if (/[?#]/.test(trimmed)) {
    throw new Error(
      "Repository URLs must not contain embedded credentials, query parameters, or fragments. Use Git Credential Manager or SSH keys."
    );
  }
}

export function repositoryOriginIdentity(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (/^(?:https?|ssh):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const pathname = normalizedRepositoryPath(parsed.pathname);
      return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}`;
    } catch {
      // Fall through to SCP-style and conservative normalization.
    }
  }
  const scp = trimmed.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
  if (scp) {
    return `ssh://${scp[1].toLowerCase()}${normalizedRepositoryPath(`/${scp[2]}`).toLowerCase()}`;
  }
  return repositoryUrlForArtifact(trimmed)
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizedRepositoryPath(value: string): string {
  const collapsed = value.replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
  return collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
}
