export function functionSource(src: string, name: string, fileName?: string): string;
export function routeSource(src: string, method: string, routePath: string, fileName?: string): string;
export function enclosingSource(
  src: string,
  marker: string,
  kind?: "statement" | "function" | "call" | "object" | "jsx" | "block",
  options?: { occurrence?: number; unique?: boolean; fileName?: string },
): string;
export function betweenMarkers(src: string, start: string, end: string): string;
