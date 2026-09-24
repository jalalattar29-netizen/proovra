/**
 * THE AUTHENTICATED FIXTURE — the one that was missing.
 *
 * Every render test in this suite except `intake-links` ran SIGNED OUT, and
 * nothing said so. The secure-store stub starts empty, so
 * `SecureStore.getItemAsync("proovra-token")` answers null, `AuthProvider`
 * never reaches `authReady`, and `platform-context.ts` short-circuits on
 * `if (!authReady || !token) return` before it ever fetches. `activeTeamId`
 * was therefore null in every test, and every workspace-scoped request
 * short-circuited to `Promise.resolve(null)` without being sent.
 *
 * The consequence was not a missing test. It was a MISLEADING one: Home's
 * suite asserted KPI labels, section titles and empty states against the
 * signed-out branch while reading as coverage of the signed-in screen. The
 * same held for capture and settings-security.
 *
 * Seeding a token alone does not fix it. The app only becomes authenticated
 * when the whole boot chain completes:
 *
 *   1. `proovra-token` exists in the secure store
 *   2. `GET /v1/auth/me` answers with a user           → authReady
 *   3. `GET /v1/platform/context` answers an envelope with `activeSpace`
 *      AT THE TOP LEVEL (what `platform-context.routes.ts` actually sends,
 *      and where `projectPlatformContext` reads it)
 *
 * Miss any one and the screen silently renders the signed-out branch again.
 * `assertScopedRequests` exists so a test cannot pass while that happens.
 */

/** The workspace every authenticated fixture resolves to. */
export const TEST_TEAM_ID = "team-1";

/**
 * The platform-context envelope as the SERVER sends it.
 *
 * `platform-context.routes.ts` answers `reply.code(200).send(result.envelope)`
 * and the envelope carries `activeSpace` at the top level. A stub that nests
 * it under `context` resolves `activeTeamId` to null — which is exactly the
 * defect this file exists to prevent, and exactly what `home.render.test.mjs`
 * did.
 */
export function platformContextEnvelope(overrides = {}) {
  return {
    activeSpace: {
      id: TEST_TEAM_ID,
      type: "ORGANIZATION",
      plan: "BUSINESS",
      displayName: "Test Workspace",
      status: "active",
    },
    personalSpaceAllowed: true,
    ...overrides,
  };
}

/** The `/v1/auth/me` answer that lets AuthProvider finish booting. */
export function authMe(overrides = {}) {
  return {
    user: {
      id: "user-1",
      email: "operator@example.invalid",
      displayName: "Test Operator",
      ...overrides,
    },
  };
}

/**
 * The two routes EVERY authenticated screen needs before its own.
 *
 * Spread this into a test's route table rather than restating it, so a screen
 * that starts requiring one of them cannot quietly fall back to signed-out.
 */
export function authenticatedRoutes(overrides = {}) {
  return {
    "/v1/auth/me": () => authMe(),
    "/v1/platform/context": () => platformContextEnvelope(),
    ...overrides,
  };
}

/**
 * Seed the app's own secure store. `mod` must come from a `loadModule` that
 * included `test/support/expo-stub.mjs`, so the Map being written is the one
 * the screen reads.
 */
export async function signIn(mod, token = "test-token") {
  if (typeof mod?.setItemAsync !== "function") {
    throw new Error(
      "signIn() needs the expo-stub from the screen's own module graph — add " +
        '"test/support/expo-stub.mjs" to the loadModule list',
    );
  }
  await mod.setItemAsync("proovra-token", token);
  await mod.setItemAsync("proovra-auth-mode", "password");
}

/**
 * PROVE THE SCOPED REQUESTS ACTUALLY EXECUTED.
 *
 * The failure this guards is silent by construction: a workspace-scoped call
 * that never fires leaves no trace, and the screen renders a plausible empty
 * state. So a test states which paths must have been requested WITH a teamId,
 * and this fails loudly when one is missing — naming what was requested
 * instead, because "nothing happened" is the least useful failure message
 * there is.
 */
export function assertScopedRequests(assert, requests, expectedPaths) {
  const seen = requests.map((r) => r.path);
  const scoped = seen.filter((p) => p.includes(`teamId=${TEST_TEAM_ID}`));
  const missing = expectedPaths.filter(
    (p) => !scoped.some((s) => s.startsWith(p)),
  );

  assert.deepEqual(
    missing,
    [],
    `these workspace-scoped requests never executed: ${missing.join(", ")}\n` +
      `requests actually made:\n  ${seen.join("\n  ") || "(none)"}\n` +
      "A null activeTeamId short-circuits them to Promise.resolve(null), " +
      "which renders as an empty workspace rather than as an error.",
  );
  return scoped;
}
