export type RouteType =
  | "public"
  | "app"
  | "admin"
  | "auth"
  | "api"
  | "unknown";

function stripQuery(path: string): string {
  const qIndex = path.indexOf("?");
  return qIndex >= 0 ? path.slice(0, qIndex) : path;
}

export function normalizeRoutePath(
  path: string | null | undefined
): string | null {
  if (!path) return null;

  const normalized = stripQuery(path).trim();
  return normalized || null;
}

export function classifyRouteType(
  path: string | null | undefined
): RouteType {
  const normalized = normalizeRoutePath(path);
  if (!normalized) return "unknown";

  if (normalized.startsWith("/admin") || normalized.startsWith("/v1/admin")) {
    return "admin";
  }

  if (normalized.startsWith("/auth") || normalized.startsWith("/v1/auth")) {
    return "auth";
  }

  if (normalized.startsWith("/api") || normalized.startsWith("/v1/")) {
    return "api";
  }

  if (
    normalized.startsWith("/home") ||
    normalized.startsWith("/capture") ||
    normalized.startsWith("/cases") ||
    normalized.startsWith("/evidence") ||
    normalized.startsWith("/teams") ||
    normalized.startsWith("/reports") ||
    normalized.startsWith("/billing") ||
    normalized.startsWith("/settings") ||
    normalized.startsWith("/app")
  ) {
    return "app";
  }

  if (
    normalized === "/" ||
    normalized.startsWith("/pricing") ||
    normalized.startsWith("/about") ||
    normalized.startsWith("/verify") ||
    normalized.startsWith("/privacy") ||
    normalized.startsWith("/terms") ||
    normalized.startsWith("/legal") ||
    normalized.startsWith("/support") ||
    normalized.startsWith("/login") ||
    normalized.startsWith("/register") ||
    normalized.startsWith("/reset-password")
  ) {
    return "public";
  }

  return "public";
}