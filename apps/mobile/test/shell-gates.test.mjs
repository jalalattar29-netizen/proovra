/**
 * T-09e / T-09h (RC-10) — the shell gates and the shell's reading order.
 *
 * T-09e. The web swaps the page for a recovery surface on EVERY authenticated
 * route when the envelope carries `recoveryActions`, or when managed policy
 * forbids the active Personal Space (AppShellV2.tsx:146-159, 241-247). Native
 * checked neither in the shell: the policy was enforced on the three capture
 * screens alone, so Home, Evidence, Cases and Reports kept rendering Personal
 * content the policy forbids, and a broken workspace rendered as a screen of
 * failed requests.
 *
 * T-09h. The web's skip link exists because a keyboard user walked the whole
 * sidebar before reaching the page. On a tablet the rail preceded the content
 * in the native tree, so a screen reader did the same.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadModule, renderComponent, React } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const WEB = resolve(MOBILE, "../web");
const h = React.createElement;

let WEBGATE; // the web's pure personal-space gate, executed
let M; // the shell, rendered
let routes = {};

before(async () => {
  const out = await build({
    stdin: {
      contents: `export { resolvePersonalSpaceGate } from "./lib/platform-context/personalSpaceGate";`,
      resolveDir: WEB,
      sourcefile: "web-gate.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const dir = resolve(MOBILE, "node_modules/.render-test-cache");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `web-gate-${Date.now()}.mjs`);
  await writeFile(file, out.outputFiles[0].text, "utf8");
  WEBGATE = await import(pathToFileURL(file).href);

  M = await loadModule("src/ui/shell.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/shell-gates.ts",
  ]);
});

function installFetch() {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    return new Response(JSON.stringify(hit ? hit[1]() : { message: "unstubbed" }), {
      status: hit ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
}

beforeEach(async () => {
  routes = authenticatedRoutes({ "/v1/me/inbox/summary": () => ({ unread: 0 }) });
  installFetch();
  M.calls.reset();
  await signIn(M);
});

async function renderShellWith(env) {
  routes["/v1/platform/context"] = () => env;
  const el = () => h(M.TestProviders, null, h(M.ProovraShell, null, h("Text", null, "PAGE CONTENT")));
  const r = await renderComponent(el());
  await r.update(el());
  return r;
}

/* ------------------------------------------------ the decision, vs the web */

test("the Personal-Space decision agrees with the web's executed gate", () => {
  const options = {
    none: null,
    empty: { ownedWorkspaces: [], organizations: [] },
    owned: { ownedWorkspaces: [{ workspaceId: "o1" }], organizations: [] },
    org: { ownedWorkspaces: [], organizations: [{ workspaces: [{ workspaceId: "g1" }] }] },
  };
  for (const allowed of [true, false, undefined]) {
    for (const type of ["PERSONAL", "ORGANIZATION", undefined]) {
      for (const [name, contextOptions] of Object.entries(options)) {
        const env = { personalSpaceAllowed: allowed, activeSpace: type ? { type } : undefined, contextOptions };
        const web = WEBGATE.resolvePersonalSpaceGate(env);
        const nat = M.resolveShellGate(env);
        const label = `allowed=${allowed} type=${type} options=${name}`;
        if (web.action === "none") {
          assert.equal(nat.kind, "none", label);
        } else {
          assert.equal(nat.kind, "personal-unavailable", label);
          assert.equal(nat.switchAvailable, web.action === "heal", `${label}: switch offered ⇔ the web would heal`);
        }
      }
    }
  }
});

test("recovery takes precedence and maps every server href to a native screen", () => {
  // The exact list the API builds (platform-context.service.ts buildRecoveryActions).
  const env = {
    personalSpaceAllowed: false,
    activeSpace: { type: "PERSONAL" },
    recoveryActions: [
      { id: "create_personal_workspace", label: "Create personal workspace", href: "/settings" },
      { id: "create_team", label: "Create or join a team", href: "/teams" },
      { id: "open_settings", label: "Open account settings", href: "/settings" },
      { id: "retry", label: "Retry", href: null },
    ],
    diagnostics: { requestId: "req-42" },
  };
  const gate = M.resolveShellGate(env);
  assert.equal(gate.kind, "recovery", "a broken envelope must not be gated on a field it may not carry");
  assert.deepEqual(
    gate.actions.map((a) => [a.id, a.href]),
    [
      ["create_personal_workspace", "/settings"],
      ["create_team", "/teams"],
      ["open_settings", "/settings"],
      ["retry", null],
    ],
  );
  assert.equal(gate.requestId, "req-42");
});

test("a recovery href with no native screen yields no button, and Retry is always there", () => {
  const gate = M.resolveShellGate({ recoveryActions: [{ id: "create_team", label: "X", href: "/nowhere" }] });
  assert.deepEqual(gate.actions.map((a) => a.id), ["retry"]);
});

test("an unread or unreadable envelope never invents a gate", () => {
  assert.equal(M.resolveShellGate(null).kind, "none");
  assert.equal(M.resolveShellGate(undefined).kind, "none");
  assert.equal(M.resolveShellGate({}).kind, "none");
});

/* --------------------------------------------------------- what renders */

test("recovery: the page is replaced, the shell stays, Retry re-reads", async () => {
  let reads = 0;
  const env = platformContextEnvelope({
    recoveryActions: [
      { id: "open_settings", label: "Open account settings", href: "/settings" },
      { id: "retry", label: "Retry", href: null },
    ],
  });
  routes["/v1/platform/context"] = () => {
    reads += 1;
    return env;
  };
  const el = () => h(M.TestProviders, null, h(M.ProovraShell, null, h("Text", null, "PAGE CONTENT")));
  const r = await renderComponent(el());
  await r.update(el());
  assert.ok(!r.hasText("PAGE CONTENT"), "the page rendered under a broken workspace");
  assert.ok(r.hasText("Let's get you back into the product"));
  assert.ok(r.byTestId("nav-bottom-bar").length > 0, "navigation vanished with the page");
  assert.ok(r.byRole("search").length > 0, "the header vanished with the page");

  const before = reads;
  await r.press("Open account settings");
  assert.deepEqual(M.calls.push, ["/settings"]);
  await r.press("Retry");
  await r.update(el());
  assert.ok(reads > before, "Retry did not re-read the envelope");
});

test("Personal Space forbidden: every primary screen is covered, not only capture", async () => {
  const r = await renderShellWith(
    platformContextEnvelope({
      personalSpaceAllowed: false,
      activeSpace: { id: "team-1", type: "PERSONAL", displayName: "Personal", status: "active" },
      contextOptions: { ownedWorkspaces: [], organizations: [{ workspaces: [{ workspaceId: "g1" }] }] },
    }),
  );
  assert.ok(!r.hasText("PAGE CONTENT"), "Personal content rendered against managed policy");
  assert.ok(r.hasText("Personal Space isn't available right now"));
  await r.press("Switch workspace");
  assert.deepEqual(M.calls.push, ["/spaces"], "the switch must go through the ONE switching surface");
});

test("a healthy envelope renders the page untouched", async () => {
  const r = await renderShellWith(platformContextEnvelope());
  assert.ok(r.hasText("PAGE CONTENT"));
  assert.equal(r.byTestId("workspace-recovery").length, 0);
  assert.equal(r.byTestId("personal-space-unavailable").length, 0);
});

/* ------------------------------------------------------ T-09h reading order */

test("T-09h: on a tablet the page precedes the rail in reading order, while the rail still draws on the leading edge", async () => {
  // The render stub fixes the window at phone width, so the tablet branch is
  // checked structurally: tree order is exactly what a screen reader follows.
  {
    const src = (await import("node:fs")).readFileSync(resolve(MOBILE, "src/ui/shell.tsx"), "utf8");
    const railBranch = src.slice(src.indexOf('if (navMode === "rail")'), src.indexOf("T-09a / RC-10 — on phones"));
    const contentAt = railBranch.indexOf("{page(styles.railContent)}");
    const railAt = railBranch.indexOf("<ProovraTabletRail");
    assert.ok(contentAt > 0 && railAt > 0, "could not locate the tablet content and rail");
    assert.ok(contentAt < railAt, "the rail precedes the page in the tree, so a screen reader walks it first");
    assert.match(
      railBranch,
      /flexDirection: isRTL \? "row" : "row-reverse"/,
      "with content first in the tree, the row must be reversed to keep the rail on the leading edge",
    );
  }
});

/* ------------------------------------------- which screens carry the shell */

const AUTHENTICATED_STACK_SCREENS = [
  "billing", "case/[id]", "collaboration-team/[id]", "evidence-request/[id]", "evidence-requests",
  "evidence/[id]", "intake-links", "intake-link-create", "operations/index", "operations/health", "operations/batch-analysis", "operations/quotas",
  "organizations/[id]", "organizations/index", "reports", "search", "settings/ai",
  "settings/notifications", "settings/privacy", "settings/reviewer-criteria", "settings/security",
  "spaces", "trust-center", "workspace-people",
];
/** Pre-auth, public-token and full-screen capture flows: the web renders these outside AppShellV2 too. */
const UNSHELLED_SCREENS = [
  "auth", "register", "forgot-password", "reset-password", "verify-email", "mfa", "mfa-recovery-verify",
  "legal-acceptance", "legal/index", "legal/[slug]", "intake/[token]", "intake/capture", "invite/[token]",
  "org-invite/[token]", "portal/index", "portal/[token]", "portal/accept/[grantId]", "portal/work/[workflowId]",
  "capture", "continuous-capture", "screen-capture", "support",
];

test("RC-10: every authenticated stack screen renders inside the shell — in EVERY state", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const stack = resolve(MOBILE, "app/(stack)");
  const all = [];
  const walk = (dir, rel = "") => {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full, rel + f + "/");
      else if (f.endsWith(".tsx")) all.push(rel + f.replace(/\.tsx$/, ""));
    }
  };
  walk(stack);
  const classified = new Set([...AUTHENTICATED_STACK_SCREENS, ...UNSHELLED_SCREENS]);
  assert.deepEqual(all.filter((f) => !classified.has(f)), [], "a new stack screen must be classified as shelled or not");

  for (const f of AUTHENTICATED_STACK_SCREENS) {
    const src = readFileSync(join(stack, f + ".tsx"), "utf8");
    const screens = src.match(/<ProovraScreen(?=[\s>])[^>]*/g) ?? [];
    assert.ok(screens.length > 0, f + " renders no ProovraScreen");
    // Loading and error states included: a shell that vanishes while a screen
    // loads is the same defect for the length of the request.
    for (const tag of screens) assert.match(tag, /\bshell\b/, f + ": a ProovraScreen renders outside the shell: " + tag);
  }
  for (const f of UNSHELLED_SCREENS) {
    const src = readFileSync(join(stack, f + ".tsx"), "utf8");
    assert.doesNotMatch(src, /<ProovraScreen shell/, f + " is a pre-auth / public / capture flow and must not carry the app chrome");
  }
});

test("a shelled ProovraScreen renders the header, the navigation and the page", async () => {
  const S = await loadModule("src/ui/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  await signIn(S);
  routes["/v1/platform/context"] = () => platformContextEnvelope();
  const el = () => h(S.TestProviders, null, h(S.ProovraScreen, { shell: true, testID: "stack-page" }, h("Text", null, "STACK PAGE")));
  const r = await renderComponent(el());
  await r.update(el());
  assert.ok(r.hasText("STACK PAGE"));
  assert.equal(r.byRole("search").length, 1, "no header search on a stack screen");
  assert.equal(r.byTestId("nav-bottom-bar").length, 1, "no navigation on a stack screen");
  assert.equal(r.byTestId("stack-page").length, 1);
});
