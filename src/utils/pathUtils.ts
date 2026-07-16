import * as path from "path";
import { createHash } from "crypto";

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

export function safePathSegment(value: string, fallback = "item", maxLength = 80): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 12) {
    throw new Error("Safe path segment length must be an integer of at least 12 characters.");
  }
  const normalized = safeName(value).replace(/^\.+|\.+$/g, "");
  const safeFallback = safeName(fallback).replace(/^\.+|\.+$/g, "") || "item";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const base = normalized && !isWindowsDeviceName(normalized) ? normalized : safeFallback;
  return `${base.slice(0, Math.max(1, maxLength - hash.length - 1))}-${hash}`;
}

export function ensureWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !isParentTraversal(relative) && !path.isAbsolute(relative);
}

export function ensureWithinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!isParentTraversal(relative) && !path.isAbsolute(relative));
}

function isParentTraversal(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`);
}

function isWindowsDeviceName(value: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}
