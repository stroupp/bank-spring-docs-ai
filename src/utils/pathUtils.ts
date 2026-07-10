import * as path from "path";

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function relativePosix(rootDir: string, filePath: string): string {
  return toPosixPath(path.relative(rootDir, filePath));
}

export function safeName(value: string): string {
  return value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function ensureWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
