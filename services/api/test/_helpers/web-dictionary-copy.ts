/**
 * B2A-F-12 — the app shell, Home, Search, Support and the lead forms read
 * their copy from the web dictionary (`@proovra/shared/i18n`, spread from
 * packages/shared/src/i18n-*.ts) through `t("key")`. Source pins that used to
 * find an English literal in a component now find it in the module's EN block
 * and the key in the component.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "shared", "src");

export type WebDictionaryModule = "app-shell" | "home" | "search" | "support-leads";

/** The source of the module's English block (`const EN = { … } as const;`). */
export function webDictionaryEn(module: WebDictionaryModule): string {
  const src = readFileSync(resolve(SHARED_SRC, `i18n-${module}.ts`), "utf8");
  const start = src.indexOf("const EN = {");
  const end = src.indexOf("} as const;", start);
  if (start < 0 || end < 0) throw new Error(`i18n-${module}.ts has no EN block`);
  return src.slice(start, end);
}

/** The English string of one key, or null when the key is absent. */
export function webDictionaryEnValue(module: WebDictionaryModule, key: string): string | null {
  const en = webDictionaryEn(module);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = en.match(new RegExp(`(?:^|\\n)\\s*(?:"${esc}"|${esc}):\\s*("(?:[^"\\\\]|\\\\.)*")`));
  return m ? (JSON.parse(m[1]) as string) : null;
}

/** The key whose English string is exactly `text` (null when none is). */
export function webDictionaryKeyFor(module: WebDictionaryModule, text: string): string | null {
  const en = webDictionaryEn(module);
  const re = /(?:^|\n)\s*(?:"([^"]+)"|([A-Za-z0-9_]+)):\s*("(?:[^"\\]|\\.)*")/g;
  for (let m = re.exec(en); m; m = re.exec(en)) {
    if ((JSON.parse(m[3]) as string) === text) return m[1] ?? m[2];
  }
  return null;
}

/** `t("key")` (or `t('key')`) appears in the component source. */
export function usesKey(componentSource: string, key: string): boolean {
  return componentSource.includes(`t("${key}")`) || componentSource.includes(`t('${key}')`) || componentSource.includes(`"${key}"`);
}
