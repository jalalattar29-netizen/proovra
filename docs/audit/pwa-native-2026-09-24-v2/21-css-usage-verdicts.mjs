#!/usr/bin/env node
/**
 * 21 — re-adjudicates every OPEN T-08 CSS row (the q4 NO_RULE_ANYWHERE bucket)
 * against the CURRENT web tree. A class with no stylesheet rule is only a
 * visual defect when it is the element's SOLE styling source. Verdicts:
 *
 *   TAILWIND_GENERATED      the project's own Tailwind (3.4) compiles it — the
 *                           q4 classifier missed it (proved by running
 *                           tailwindcss with apps/web/tailwind.config.ts)
 *   RULE_EXISTS_NOW         a rule for it exists in apps/web/**.css today
 *   NOT_A_CLASS             the token is in a comment/string, not a className
 *   HOOK_ON_STYLED_ELEMENT  the element is styled by other resolvable classes
 *                           or an inline style; the class is a hook (test/probe/BEM)
 *   UNSTYLED_ELEMENT        nothing else styles the element — the PWA renders
 *                           it with inherited/default styles; inspect by hand
 *
 * Output: css-usage-verdicts.json (next to this script).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const WEB = path.join(ROOT, "apps/web");

const css = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".css")) css.push(fs.readFileSync(p, "utf8"));
  }
})(WEB);
const allCss = css.join("\n");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const hasRule = (c) => new RegExp("\\." + esc(c) + "(?![\\w-])").test(allCss);

const ledger = JSON.parse(fs.readFileSync(path.join(HERE, "WORK-LEDGER.json"), "utf8"));
const rows = ledger.rows.filter((r) => r.axis === "CSS" && r.status !== "CLOSED");
const classes = rows.map((r) => r.id.replace(/^CSS:/, ""));

// Ask the project's own Tailwind which of these it generates.
const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "twprobe-"));
fs.writeFileSync(path.join(tmp, "probe.html"), `<div class="${classes.join(" ")}"></div>`);
fs.writeFileSync(path.join(tmp, "in.css"), "@tailwind utilities;\n");
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tailwindcss", "-c", "tailwind.config.ts", "-i", path.join(tmp, "in.css"), "--content", path.join(tmp, "probe.html"), "-o", path.join(tmp, "out.css")], { cwd: WEB, stdio: "ignore", shell: process.platform === "win32" });
const twOut = fs.readFileSync(path.join(tmp, "out.css"), "utf8");
// Tailwind escapes selectors: `[&_h2]:scroll-mt-24` → `.\[\&_h2\]\:scroll-mt-24`.
const twEsc = (c) => "." + c.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
const twGenerated = (c) => twOut.includes(twEsc(c));

const out = [];
for (const r of rows) {
  const c = r.id.replace(/^CSS:/, "");
  const at = r.at;
  const [file, line] = [at.replace(/:\d+$/, ""), Number(at.split(":").pop())];
  let verdict;
  let detail = {};
  if (twGenerated(c)) verdict = "TAILWIND_GENERATED";
  else if (hasRule(c)) verdict = "RULE_EXISTS_NOW";
  else {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
    const win = src.slice(Math.max(0, line - 3), line + 6).join("\n");
    const attr = win.match(new RegExp("className=(\\{[^}]*" + esc(c) + "[^}]*\\}|\"[^\"]*" + esc(c) + "[^\"]*\"|`[^`]*" + esc(c) + "[^`]*`)"));
    if (!attr) verdict = "NOT_A_CLASS";
    else {
      const tokens = attr[1].replace(/[{}"`]/g, " ").split(/[\s$]+/).filter((t) => t && t !== c && /^[a-z![]/.test(t));
      const styledOthers = tokens.filter((t) => hasRule(t) || twGenerated(t) || /^(?:[a-z]+:)*(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|w|h|text|font|leading|rounded|border|bg|shadow|flex|grid|items|justify|inline|block|relative|absolute|overflow|truncate)(?:-|$)/.test(t));
      const inline = /style=\{\{/.test(win);
      // The element's tag, and whether an ENCLOSING element styles it: a
      // Tailwind arbitrary variant `[&_ul]:…` / `[&_button]:…` on an ancestor,
      // a shared class constant spread into an ancestor (e.g.
      // LEGAL_ARTICLE_TYPOGRAPHY), or a stylesheet descendant rule
      // `.ancestor tag`. Scans the enclosing JSX above the element.
      let tag = null;
      for (let i = line - 1; i >= Math.max(0, line - 4); i--) {
        const m = src[i].match(/<([a-z][\w]*)/);
        if (m) { tag = m[1]; break; }
      }
      const above = src.slice(Math.max(0, line - 400), line - 1).join("\n");
      const fileText = src.join("\n");
      const ancestorClasses = [...above.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/)).filter(Boolean);
      const constRefs = [...above.matchAll(/\$\{([A-Z_][A-Z0-9_]+)\}/g)].map((m) => m[1]);
      let constText = "";
      for (const name of constRefs) {
        const imp = fileText.match(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`));
        if (imp) {
          const base = path.resolve(path.dirname(path.join(ROOT, file)), imp[1]);
          for (const ext of [".ts", ".tsx", "/index.ts"]) if (fs.existsSync(base + ext)) constText += fs.readFileSync(base + ext, "utf8");
        }
        constText += (fileText.match(new RegExp(`const ${name}\\s*=\\s*\`([\\s\\S]*?)\``)) ?? [])[1] ?? "";
      }
      const variantSource = ancestorClasses.join(" ") + " " + constText;
      const ancestorStyled =
        tag !== null &&
        (new RegExp(`\\[&_${tag}[\\]>:.]`).test(variantSource) ||
          ancestorClasses.some((a) => new RegExp("\\." + esc(a) + "\\s+(?:[\\w.-]+\\s+)*" + tag + "(?![\\w-])").test(allCss)));
      verdict = styledOthers.length || inline ? "HOOK_ON_STYLED_ELEMENT" : ancestorStyled ? "STYLED_BY_ANCESTOR" : "UNSTYLED_ELEMENT";
      detail = { tag, styledOthers: styledOthers.slice(0, 5), inline, ancestorStyled };
    }
  }
  out.push({ id: r.id, class: c, at, routes: r.routes, verdict, ...detail });
}
fs.writeFileSync(path.join(HERE, "css-usage-verdicts.json"), JSON.stringify({ generatedAt: new Date().toISOString(), tailwind: "3.4 (apps/web/package.json)", rows: out }, null, 1));
const by = out.reduce((a, x) => ((a[x.verdict] = (a[x.verdict] ?? 0) + 1), a), {});
console.log(JSON.stringify(by));
for (const x of out.filter((x) => x.verdict === "UNSTYLED_ELEMENT" || x.verdict === "NOT_A_CLASS")) console.log(x.verdict, x.class, "@", x.at.replace("apps/web/", ""));
