/**
 * Phase Final-D3 — contract test: zero raw `window.confirm` in apps/web.
 *
 * D-3 closed the legacy destructive-action UX pattern. Every UI flow
 * that used to call `window.confirm("...")` now goes through the
 * canonical `<ConfirmActionModal>` + `useConfirmAction()` hook
 * (apps/web/components/ui/ConfirmActionModal.tsx).
 *
 * This contract test FAILS the build the moment a regression PR
 * reintroduces a raw `window.confirm(` call anywhere under apps/web.
 *
 * What "raw call" means here:
 *   - `window.confirm(`         — explicit
 *   - `globalThis.confirm(`     — possible re-introduction surface
 *   - bare `confirm("...")`     — when used as a JSX/handler call
 *
 * Doc comments / closure comments mentioning the legacy term are
 * allowed and explicitly skipped:
 *   - lines whose first non-whitespace chars are `*` (block-comment
 *     body) or `//` (line comment)
 *   - the single allowlist file `ConfirmActionModal.tsx` (the
 *     replacement's own JSDoc names the legacy symbol).
 *
 * The walker is bounded:
 *   - Skips `node_modules`, `.next`, `dist`, `out`, `coverage`.
 *   - Reads each file as utf8 and inspects line-by-line.
 *
 * Why this lives in services/api/test:
 *   - apps/web has no test runner installed (see
 *     apps/web/package.json — `"test": "echo \"(no tests)\""`).
 *   - The api workspace already runs vitest in CI and has fs-walking
 *     contract tests (phase-cr1-legacy-purge.test.ts,
 *     phase-g5-vocabulary-contracts.test.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Resolve apps/web from this test file's location.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = join(__dirname, "..", "..", "..", "apps", "web");
const SKIP_DIRS = new Set([
    "node_modules",
    ".next",
    "dist",
    "out",
    "coverage",
    ".turbo",
    ".vercel",
]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
// The single file allowed to reference the legacy symbol by name —
// the replacement's own JSDoc + the literal regex strings of the
// contract test it documents.
const ALLOWLIST = new Set([
    join(WEB_ROOT, "components", "ui", "ConfirmActionModal.tsx"),
]);
function walk(dir, out) {
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name))
            continue;
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        }
        catch {
            continue;
        }
        if (st.isDirectory()) {
            walk(full, out);
            continue;
        }
        if (!st.isFile())
            continue;
        const dot = name.lastIndexOf(".");
        if (dot < 0)
            continue;
        if (!EXTS.has(name.slice(dot)))
            continue;
        out.push(full);
    }
}
function isCommentLine(line) {
    const trimmed = line.trimStart();
    return (trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*/"));
}
// Patterns we want to ban from real code:
//   1. `window.confirm(`
//   2. `globalThis.confirm(`
//   3. bare `confirm(...)` *as a callable* — we approximate by
//      requiring it to be preceded by start-of-line / `(` / `!` /
//      `=` / `&&` / `||` / `?` / `,` / `{` / whitespace, and NOT by
//      `.` (to skip method calls like `foo.confirm(...)`) or letters
//      (to skip `useConfirmAction`, `customConfirm`, etc.).
const HARD_PATTERNS = [
    /window\.confirm\s*\(/,
    /globalThis\.confirm\s*\(/,
];
const BARE_CONFIRM = /(?:^|[\s(!=&|?,{])confirm\s*\(/;
function classifyLine(line) {
    for (const re of HARD_PATTERNS) {
        if (re.test(line))
            return re.source;
    }
    // The bare `confirm(...)` ban is narrow — skip if the previous
    // char that's part of an identifier makes this a `*Confirm(` /
    // `someConfirm(` symbol, and skip when preceded by `await` (which
    // means the call routes through the `useConfirmAction()` hook).
    const m = line.match(BARE_CONFIRM);
    if (m && m.index !== undefined) {
        const confirmStart = m.index + m[0].indexOf("confirm");
        const before = line.slice(0, confirmStart);
        const prevChar = before.slice(-1);
        if (/[A-Za-z0-9_$.]/.test(prevChar))
            return null;
        // Look back through whitespace; if the preceding token is
        // `await`, this is a hook call and is allowed.
        const trimmedBefore = before.replace(/\s+$/u, "");
        if (/(^|[^A-Za-z0-9_$])await$/.test(trimmedBefore))
            return null;
        return BARE_CONFIRM.source;
    }
    return null;
}
describe("Phase Final-D3 — zero raw window.confirm in apps/web", () => {
    it("no source file under apps/web contains a raw window.confirm or bare confirm() call", () => {
        const files = [];
        walk(WEB_ROOT, files);
        expect(files.length).toBeGreaterThan(0);
        const offenders = [];
        for (const file of files) {
            if (ALLOWLIST.has(file))
                continue;
            let content;
            try {
                content = readFileSync(file, "utf8");
            }
            catch {
                continue;
            }
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i] ?? "";
                if (isCommentLine(line))
                    continue;
                const matched = classifyLine(line);
                if (matched) {
                    offenders.push({
                        file,
                        line: i + 1,
                        text: line.trim().slice(0, 200),
                        matched,
                    });
                }
            }
        }
        expect(offenders, `Found ${offenders.length} raw confirm() call(s):\n${offenders
            .map((o) => `  ${o.file}:${o.line}  [${o.matched}]  ${o.text}`)
            .join("\n")}`).toEqual([]);
    });
    it("ConfirmActionModal.tsx (the canonical replacement) exists", () => {
        const target = join(WEB_ROOT, "components", "ui", "ConfirmActionModal.tsx");
        const content = readFileSync(target, "utf8");
        // Sanity — the hook is exported.
        expect(content).toMatch(/export\s+function\s+useConfirmAction/);
        expect(content).toMatch(/export\s+function\s+ConfirmActionProvider/);
    });
    it("ConfirmActionProvider is mounted in app/providers.tsx", () => {
        const target = join(WEB_ROOT, "app", "providers.tsx");
        const content = readFileSync(target, "utf8");
        expect(content).toMatch(/ConfirmActionProvider/);
        expect(content).toMatch(/<ConfirmActionProvider>/);
    });
});
