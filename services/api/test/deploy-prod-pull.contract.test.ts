/**
 * scripts/deploy-prod-pull.sh — the server-side Production deploy, EXECUTED
 * with stub `docker` / `git` / `curl` / `sleep` on PATH so every decision it
 * makes is observable without a Docker daemon or a server.
 *
 * It used to pull `api worker` (services the compose file does not have),
 * default IMAGE_TAG to `latest` (which the compose file refuses) and
 * `git reset --hard origin/main` whatever was being deployed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(REPO, "scripts", "deploy-prod-pull.sh");
const COMPOSE = readFileSync(resolve(REPO, "infra", "docker", "docker-compose.prod.yml"), "utf8");

const SHA = "4a37298fcc297514291d3cdbcbe193e2b643bafd";
const TAG = `sha-${SHA.slice(0, 7)}`;
const OLD_SHA = "71d2bcbba3f2e8613367febfa0da83faddd7509c";
const OLD_TAG = `sha-${OLD_SHA.slice(0, 7)}`;
const OWNER = "jalalattar29-netizen";
const SECRET = "postgresql://prod-user:SuperSecretPw@db.internal:5432/proovra";

const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
st="$STUB_STATE"
args="$*"
last="\${@: -1}"
case "$args" in
  "compose -f "*" ps -q "*) [ -f "$st/cid-$last" ] && cat "$st/cid-$last"; exit 0 ;;
  "compose -f "*" pull "*) exit "\${STUB_PULL_RC:-0}" ;;
  "compose -f "*" run "*) exit "\${STUB_GATE_RC:-0}" ;;
  "compose -f "*" up -d --no-deps "*)
     echo "new-$last" > "$st/cid-$last"
     echo "ghcr.io/$GHCR_OWNER/$last:$IMAGE_TAG" > "$st/img-new-$last"; exit 0 ;;
  "inspect --format {{.Config.Image}} "*) cat "$st/img-$last"; exit 0 ;;
  "inspect --format {{if .State.Health}}"*) echo "\${STUB_HEALTH:-healthy}"; exit 0 ;;
  "image inspect --format {{ index .Config.Labels "*)
     if [ "$last" = "$(cat "$st/current-image" 2>/dev/null)" ]; then echo "\${STUB_CUR_REV:-}"; else echo "\${STUB_NEW_REV:-}"; fi; exit 0 ;;
  "image inspect --format {{join .RepoDigests \\",\\"}} "*) echo "$last@sha256:0000"; exit 0 ;;
esac
echo "unexpected docker call: $args" >&2; exit 99
`;
const GIT_STUB = `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
case "$1" in
  diff) exit "\${STUB_GIT_DIRTY:-0}" ;;
  cat-file) exit "\${STUB_GIT_MISSING:-0}" ;;
esac
exit 0
`;
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"; exit "\${STUB_CURL_RC:-0}"
`;
const SLEEP_STUB = `#!/usr/bin/env bash
exit 0
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

type Run = { status: number | null; out: string; log: string[]; state: string; root: string };

function run(args: string[], env: Record<string, string | undefined>, setup?: (state: string, root: string) => void): Run {
  const root = mkdtempSync(join(tmpdir(), "deploy-prod-pull-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const state = join(root, "stub-state");
  for (const d of [join(root, "scripts"), join(root, "infra", "docker"), bin, state]) mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "deploy-prod-pull.sh"));
  writeFileSync(join(root, "infra", "docker", "docker-compose.prod.yml"), "services: {}\n");
  for (const [name, body] of [
    ["docker", DOCKER_STUB],
    ["git", GIT_STUB],
    ["curl", CURL_STUB],
    ["sleep", SLEEP_STUB],
  ] as const) {
    writeFileSync(join(bin, name), body.replace(/\r\n/g, "\n"));
    chmodSync(join(bin, name), 0o755);
  }
  // The running release before the deploy.
  writeFileSync(join(state, "cid-proovra-api"), "old-proovra-api\n");
  writeFileSync(join(state, "img-old-proovra-api"), `ghcr.io/${OWNER}/proovra-api:${OLD_TAG}\n`);
  writeFileSync(join(state, "current-image"), `ghcr.io/${OWNER}/proovra-api:${OLD_TAG}`);
  setup?.(state, root);
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", [join(root, "scripts", "deploy-prod-pull.sh"), ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      HOME: process.env.HOME ?? root,
      SYSTEMROOT: process.env.SYSTEMROOT,
      STUB_LOG: log,
      STUB_STATE: state,
      STATE_DIR: join(root, ".deploy-state"),
      STUB_CUR_REV: OLD_SHA,
      STUB_NEW_REV: SHA,
      // Present in a real server shell; must never be echoed.
      DATABASE_URL: SECRET,
      ...env,
    },
  });
  return {
    status: r.status,
    out: `${r.stdout}\n${r.stderr}`,
    log: readFileSync(log, "utf8").split("\n").filter(Boolean),
    state,
    root,
  };
}

const deployEnv = { GHCR_OWNER: OWNER, RELEASE_SHA: SHA, IMAGE_TAG: TAG };

describe("deploy-prod-pull.sh — refuses anything but an immutable release", () => {
  it.each([
    ["an empty IMAGE_TAG", { IMAGE_TAG: "" }, /IMAGE_TAG is required/],
    ["latest", { IMAGE_TAG: "latest" }, /moving tag/],
    ["main", { IMAGE_TAG: "main" }, /moving tag/],
    ["a tag for another commit", { IMAGE_TAG: OLD_TAG }, /does not name RELEASE_SHA/],
    ["a bare short sha as the tag", { IMAGE_TAG: SHA.slice(0, 7) }, /does not name RELEASE_SHA/],
    ["a short RELEASE_SHA", { RELEASE_SHA: SHA.slice(0, 7) }, /full 40-hex commit SHA/],
    ["no RELEASE_SHA", { RELEASE_SHA: undefined }, /full 40-hex commit SHA/],
    ["no GHCR_OWNER", { GHCR_OWNER: undefined }, /GHCR_OWNER is required/],
  ])("%s → refused before touching docker or git", (_label, override, message) => {
    const r = run([], { ...deployEnv, ...override });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(message);
    expect(r.log).toEqual([]);
  });
});

describe("deploy-prod-pull.sh — a release deploy", () => {
  it("--plan prints the selected release and changes nothing", () => {
    const r = run(["--plan"], deployEnv);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`RELEASE_SHA  = ${SHA}`);
    expect(r.out).toContain(`api image    = ghcr.io/${OWNER}/proovra-api:${TAG}`);
    expect(r.out).toContain(`worker image = ghcr.io/${OWNER}/proovra-worker:${TAG}`);
    expect(r.out).toContain(`Currently running: ${OLD_TAG} (${OLD_SHA})`);
    expect(r.out).toContain("PLAN ONLY");
    expect(r.log.some((l) => / (pull|up|run) /.test(l) || l.startsWith("git "))).toBe(false);
  });

  it("records the rollback point, checks out the release, pulls, proves revisions, gates the schema, then API before worker", () => {
    const r = run([], deployEnv);
    expect(r.status, r.out).toBe(0);
    const at = (re: RegExp) => r.log.findIndex((l) => re.test(l));
    const order = [
      at(/^git fetch --quiet --tags origin$/),
      at(/^git diff --quiet HEAD --$/),
      at(new RegExp(`^git checkout --quiet --detach ${SHA}$`)),
      at(/compose -f \S+ pull proovra-api proovra-worker$/),
      at(new RegExp(`image inspect .*proovra-worker:${TAG}$`)),
      at(/compose -f \S+ run --rm --no-deps -T --entrypoint node proovra-api scripts\/runtime-schema-gate\.mjs$/),
      at(/compose -f \S+ up -d --no-deps proovra-api$/),
      at(/^curl .*8080\/readyz$/),
      at(/compose -f \S+ up -d --no-deps proovra-worker$/),
      at(/^curl .*8090\/health$/),
    ];
    expect(order.every((i) => i >= 0), `${order}\n${r.log.join("\n")}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The compose file's real service names — never the old `api worker`.
    expect(r.log.some((l) => /compose .* (pull|up -d|up -d --no-deps) (api|worker)\b/.test(l))).toBe(false);
    expect(r.log.some((l) => /reset --hard/.test(l))).toBe(false);
    expect(readFileSync(join(r.root, ".deploy-state", "previous-release"), "utf8")).toBe(
      `RELEASE_SHA=${OLD_SHA}\nIMAGE_TAG=${OLD_TAG}\n`,
    );
    expect(r.out).toContain(`DEPLOY SUCCEEDED: proovra-api + proovra-worker at ${TAG} (${SHA})`);
    expect(r.out).toContain("--rollback");
    expect(r.out).not.toContain("SuperSecretPw");
    expect(r.out).not.toContain(SECRET);
  });

  it("an image whose revision label is not the release is refused before anything restarts", () => {
    const r = run([], { ...deployEnv, STUB_NEW_REV: OLD_SHA });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/carries revision .* not 4a37298f/);
    expect(r.log.some((l) => / up -d /.test(l) || / run /.test(l))).toBe(false);
  });

  it("a database that does not meet the new image's schema requirements stops the deploy before any restart", () => {
    const r = run([], { ...deployEnv, STUB_GATE_RC: "12" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/does not meet .* schema requirements .* Nothing was restarted/);
    expect(r.log.some((l) => / up -d /.test(l))).toBe(false);
  });

  it("modified tracked files on the server are never overwritten", () => {
    const r = run([], { ...deployEnv, STUB_GIT_DIRTY: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/modified TRACKED files/);
    expect(r.log.some((l) => /checkout|pull/.test(l))).toBe(false);
  });

  it("an API that never becomes healthy fails before the worker is touched, and names the rollback", () => {
    const r = run([], { ...deployEnv, STUB_HEALTH: "unhealthy" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/proovra-api did not become healthy/);
    expect(r.out).toContain(`GHCR_OWNER=${OWNER} ./scripts/deploy-prod-pull.sh --rollback`);
    expect(r.log.some((l) => /up -d --no-deps proovra-worker/.test(l))).toBe(false);
  });
});

describe("deploy-prod-pull.sh — rollback", () => {
  it("--rollback redeploys the recorded release, with the same proofs, and keeps the record", () => {
    const r = run(["--rollback"], { GHCR_OWNER: OWNER, STUB_NEW_REV: OLD_SHA, STUB_CUR_REV: SHA }, (state, root) => {
      // Now running the new release; the previous one is recorded.
      writeFileSync(join(state, "img-old-proovra-api"), `ghcr.io/${OWNER}/proovra-api:${TAG}\n`);
      writeFileSync(join(state, "current-image"), `ghcr.io/${OWNER}/proovra-api:${TAG}`);
      mkdirSync(join(root, ".deploy-state"), { recursive: true });
      writeFileSync(join(root, ".deploy-state", "previous-release"), `RELEASE_SHA=${OLD_SHA}\nIMAGE_TAG=${OLD_TAG}\n`);
    });
    expect(r.status, r.out).toBe(0);
    expect(r.log).toContain(`git checkout --quiet --detach ${OLD_SHA}`);
    expect(r.out).toContain(`DEPLOY SUCCEEDED: proovra-api + proovra-worker at ${OLD_TAG} (${OLD_SHA})`);
    expect(readFileSync(join(r.root, ".deploy-state", "previous-release"), "utf8")).toContain(OLD_SHA);
  });

  it("--rollback without a recorded release refuses", () => {
    const r = run(["--rollback"], { GHCR_OWNER: OWNER });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no recorded previous release/);
    expect(r.log).toEqual([]);
  });
});

describe("deploy-prod-pull.sh — agrees with the compose file", () => {
  it("names exactly the services the production compose file defines, and the compose file still refuses a missing tag", () => {
    expect(COMPOSE).toMatch(/\n {2}proovra-api:\n/);
    expect(COMPOSE).toMatch(/\n {2}proovra-worker:\n/);
    expect(COMPOSE).toMatch(/proovra-api:\$\{IMAGE_TAG:\?/);
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('API_SVC="proovra-api" WORKER_SVC="proovra-worker"');
    expect(script).not.toMatch(/IMAGE_TAG:-latest|\bpull api worker\b|reset --hard/);
    expect(existsSync(resolve(REPO, "services", "api", "scripts", "runtime-schema-gate.mjs"))).toBe(true);
  });
});
