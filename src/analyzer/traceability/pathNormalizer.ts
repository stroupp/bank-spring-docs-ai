export function normalizeHttpPath(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  let path = value.trim().split("?")[0];
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  path = path
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .replace(/:\w+/g, "{param}")
    .replace(/\$\{[^}]+\}/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}");
  return path || "/";
}

export function withoutCommonApiPrefix(value: string): string {
  return normalizeHttpPath(value).replace(/^\/api(?=\/)/, "");
}

export function pathSuffixMatches(left: string, right: string): boolean {
  const normalizedLeft = withoutCommonApiPrefix(left);
  const normalizedRight = withoutCommonApiPrefix(right);
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(normalizedRight) || normalizedRight.endsWith(normalizedLeft);
}

export function normalizeMethod(value: string | undefined): string {
  return (value || "GET").toUpperCase();
}
