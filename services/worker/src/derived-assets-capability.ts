/**
 * Phase 31.13 — Derived assets runtime capability detection.
 *
 * `sharp` is a native binary dependency. On environments where its
 * prebuilts don't load (unusual musl variants, missing libvips,
 * etc.) we MUST NOT crash the worker — the rest of the runtime is
 * unaffected. This module probes sharp once at startup and caches
 * the result.
 *
 * Hard rules:
 *   * NEVER throws. Detection that fails returns `{ ok: false }`.
 *   * Synchronous after first call (cached). The first call is
 *     async because it dynamic-imports sharp.
 *   * Used by the worker processor to skip jobs cleanly with status
 *     UNSUPPORTED instead of repeatedly throwing.
 *   * NEVER pulls bytes — purely an availability check.
 */

let cached:
  | null
  | { ok: true; sharp: typeof import("sharp") }
  | { ok: false; reason: string } = null;

/**
 * Detect sharp availability + cache. The first call is async; later
 * calls return the cached result.
 */
export async function detectDerivedAssetCapability(): Promise<
  { ok: true; sharp: typeof import("sharp") } | { ok: false; reason: string }
> {
  if (cached !== null) return cached;
  try {
    const mod = (await import("sharp")) as typeof import("sharp") & {
      default?: typeof import("sharp");
    };
    // sharp can be loaded as CJS default or ESM named — handle both.
    const lib = (mod.default ?? mod) as typeof import("sharp");
    // Probe a 1x1 image — verifies the native binary actually
    // works, not just that the package resolved.
    await lib({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    cached = { ok: true, sharp: lib };
    return cached;
  } catch (err) {
    cached = {
      ok: false,
      reason:
        err instanceof Error
          ? `sharp_unavailable:${err.message.slice(0, 80)}`
          : "sharp_unavailable",
    };
    return cached;
  }
}

/**
 * Test-only — clear cached detection so a unit test can re-probe.
 */
export function __resetDerivedAssetCapabilityForTests(): void {
  cached = null;
}
