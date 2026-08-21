/**
 * Every Alpine package install goes through the ONE hardened installer.
 *
 * WHY THIS GUARD EXISTS
 *
 * A `deploy-images` run failed at `services/worker/Dockerfile:3` on
 * `apk add --no-cache openssl ca-certificates`. The packages were not missing:
 * apk could not fetch APKINDEX, ran its solver against an empty package
 * universe, and reported every requested package as "no such package". The
 * transport failure was a WARNING and the solver failure was the ERROR, so a
 * CDN blip read like a bad package list — and a second stage in the SAME build
 * installed `ca-certificates` without trouble, because it fetched a moment
 * apart.
 *
 * The fix is a bounded-retry wrapper (`infra/docker/apk-install.sh`). A
 * wrapper only helps where it is USED, and the cheapest way to lose it is for
 * a future edit to add one more `apk add` — which will work on every laptop
 * and fail on the one release build that catches a bad second.
 *
 * So this asserts the property directly against the Dockerfiles: no raw
 * `apk add`/`apk update` anywhere, the helper copied before any dependency or
 * source layer, and the helper itself carrying the guarantees the Dockerfiles
 * are relying on.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const HELPER_PATH = "infra/docker/apk-install.sh";
const HELPER = read(`../../../${HELPER_PATH}`);

/** Every image in this repository that installs Alpine packages. */
const DOCKERFILES = [
  { name: "services/worker/Dockerfile", src: read("../../worker/Dockerfile") },
  { name: "services/api/Dockerfile", src: read("../Dockerfile") },
] as const;

/** Lines with comments stripped, so prose about `apk add` is not a match. */
function instructions(src: string): string[] {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("Alpine package installs resolve through one hardened authority", () => {
  for (const { name, src } of DOCKERFILES) {
    describe(name, () => {
      it("contains no raw `apk add` / `apk update` instruction", () => {
        const raw = instructions(src).filter((line) =>
          /\bapk\s+(add|update|upgrade)\b/.test(line),
        );
        expect(
          raw,
          `${name} calls apk directly; use \`apk-install\` so a transient ` +
            `index fetch cannot fail the release build:\n  ${raw.join("\n  ")}`,
        ).toEqual([]);
      });

      it("installs packages through `apk-install`", () => {
        expect(src).toMatch(/^RUN apk-install /m);
      });

      it("copies the helper BEFORE any dependency or source layer", () => {
        // Placement decides whether an ordinary code edit invalidates the
        // OS-package layer. Copied late, every application change re-fetches
        // every package — which is both slow and a fresh chance to hit the
        // failure this helper exists to survive.
        const copyIdx = src.indexOf("COPY --chmod=0755 infra/docker/apk-install.sh");
        expect(copyIdx, `${name} must COPY the apk-install helper`).toBeGreaterThan(-1);

        const firstInstall = src.search(/^RUN apk-install /m);
        expect(firstInstall).toBeGreaterThan(copyIdx);

        // The first thing copied out of the build context, ahead of manifests
        // and sources alike.
        const otherCopy = src.search(/^COPY (?!--chmod=0755 infra\/docker)/m);
        if (otherCopy > -1) expect(copyIdx).toBeLessThan(otherCopy);
      });

      it("pins an explicit Alpine minor rather than a floating variant", () => {
        // A floating `-alpine` tag moves the Alpine minor without notice, and
        // the minor decides which `/alpine/v3.NN/` repository path apk fetches.
        const floating = instructions(src).filter((line) =>
          /^FROM\s+node:\d+-alpine\s+AS/i.test(line),
        );
        expect(
          floating,
          `${name} uses a floating alpine tag:\n  ${floating.join("\n  ")}`,
        ).toEqual([]);
        expect(src).toMatch(/^FROM node:\d+-alpine3\.\d+ AS base$/m);
      });

      it("does not ship a compiler toolchain in the runtime stage", () => {
        const runnerAt = src.search(/^FROM .* AS runner$/m);
        expect(runnerAt).toBeGreaterThan(-1);
        const runner = src.slice(runnerAt);
        for (const toolchain of ["gcc", "musl-dev", "python3-dev", "libffi-dev"]) {
          expect(
            instructions(runner).some((l) =>
              new RegExp(`(^|\\s)${toolchain}(\\s|\\\\|$)`).test(l),
            ),
            `${name} runtime stage installs build-only package '${toolchain}'`,
          ).toBe(false);
        }
      });
    });
  }

  describe(HELPER_PATH, () => {
    it("is POSIX sh, not bash", () => {
      // It runs under Alpine's BusyBox ash. A bash shebang would be a lie the
      // container discovers at build time.
      expect(HELPER).toMatch(/^#!\/bin\/sh\n/);
    });

    it("never swallows a failure and never loops unboundedly", () => {
      // A retry wrapper whose worst case is "succeed anyway" is worse than no
      // wrapper: it converts a broken image into a silently broken one.
      const code = HELPER.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
      // No `|| true` anywhere except the cache sweep, which is housekeeping
      // between attempts and must not decide the outcome.
      const swallowed = code.filter(
        (l) => /\|\|\s*true/.test(l) && !/rm -rf \/var\/cache\/apk/.test(l),
      );
      expect(swallowed, swallowed.join("\n")).toEqual([]);
      // The install itself is never `|| something`.
      expect(code.some((l) => /apk add[^\n]*\|\|/.test(l))).toBe(false);
      // It exits with apk's OWN status after the last attempt, and the loop
      // has a hard ceiling.
      expect(HELPER).toMatch(/exit "\$status"/);
      expect(HELPER).toMatch(/attempt" -ge "\$ATTEMPTS"/);
    });

    it("never disables TLS and never accepts a plaintext repository", () => {
      for (const forbidden of [
        "--allow-untrusted",
        "--no-check-certificate",
        "insecure",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "http://",
      ]) {
        // `http://` may appear only inside the REFUSAL pattern, never as a
        // repository this helper writes.
        const offending = HELPER.split(/\r?\n/).filter(
          (l) => l.includes(forbidden) && !/^\s*#/.test(l) && !/refusing|grep -/.test(l),
        );
        expect(
          offending,
          `helper references '${forbidden}':\n  ${offending.join("\n  ")}`,
        ).toEqual([]);
      }
      // …and it actively refuses a non-HTTPS repository list.
      expect(HELPER).toMatch(/refusing to install/);
    });

    it("takes packages as explicit arguments, never a re-split string", () => {
      expect(HELPER).toMatch(/apk add --no-cache "\$@"/);
    });
  });
});
