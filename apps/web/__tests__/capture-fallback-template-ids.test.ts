/**
 * B4-F-308 (Free-user audit 0ea0) — the web's FALLBACK intake templates use the
 * server catalog's step ids. The draft binds the server template and the
 * seal's checklist gate requires the server's required step ids, so a Guided
 * capture mapped against fallback ids of their own was refused at the seal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COLLECTION_PLAN_TEMPLATES } from "../app/(app)/capture/_lib/templates";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = readFileSync(resolve(APP_ROOT, "../../services/api/src/services/capture-intake-templates.ts"), "utf8");

/** The server catalog's templates and their step ids, in order (read from source). */
function serverCatalog(): Map<string, { ids: string[]; required: boolean[] }> {
  const out = new Map<string, { ids: string[]; required: boolean[] }>();
  let current: { ids: string[]; required: boolean[] } | null = null;
  for (const m of SERVER.matchAll(/id: "([^"]+)"|required: (true|false)/g)) {
    if (m[1]) {
      if (m[1].includes("-")) {
        current = { ids: [], required: [] };
        out.set(m[1], current);
      } else current?.ids.push(m[1]);
    } else if (current && m[2]) {
      current.required.push(m[2] === "true");
    }
  }
  return out;
}

test("B4-F-308: every fallback template's step ids equal the server catalog's, in order", () => {
  const server = serverCatalog();
  for (const template of COLLECTION_PLAN_TEMPLATES) {
    const s = server.get(template.id);
    assert.ok(s, `${template.id} exists in the server catalog`);
    assert.deepEqual(template.steps.map((step) => step.id), s.ids, `${template.id} step ids`);
  }
});

test("B4-F-308: a fallback template's REQUIRED steps are the server's required steps", () => {
  const server = serverCatalog();
  for (const template of COLLECTION_PLAN_TEMPLATES) {
    const s = server.get(template.id)!;
    const serverRequired = s.ids.filter((_, i) => s.required[i]);
    const fallbackRequired = template.steps.filter((step) => step.required).map((step) => step.id);
    assert.deepEqual(fallbackRequired, serverRequired, `${template.id} required steps`);
  }
});
