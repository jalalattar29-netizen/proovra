/**
 * B5B-F-502 — ONE parser for what a recipient pastes into a Verify input.
 *
 * Three separately written inputs parsed differently: /verify encoded a full
 * pasted URL into the path (`/verify/https%3A%2F%2F…`, a 404 notice), and the
 * home "Verify now" read a package link's `package` segment as the reference.
 * This ports the native semantics (apps/mobile/src/deep-link.ts
 * extractVerificationId / extractVerificationPackageId):
 *
 *   …/verify/package/<id>          → /verify/package/<id>
 *   …/verify/<reference>, ?id=<r>  → /verify/<reference>
 *   proovra://verify?id=<r>        → /verify/<reference>
 *   a bare reference (pvr_…, pvs_…) → /verify/<reference>
 *
 * A URL with no verify segment, or text with spaces or slashes, is refused.
 */
const SAFE_ID = /^[\w.-]+$/;

function segmentsOf(u: URL): string[] {
  return u.protocol === "proovra:"
    ? [u.hostname, ...u.pathname.split("/").filter(Boolean)]
    : u.pathname.split("/").filter(Boolean);
}

export function resolveVerifyEntryTarget(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url) {
    if (raw.startsWith("/")) {
      try {
        url = new URL(raw, "https://placeholder.invalid");
      } catch {
        return null;
      }
    } else {
      return SAFE_ID.test(raw) && raw !== "package" ? `/verify/${encodeURIComponent(raw)}` : null;
    }
  }
  const segs = segmentsOf(url);
  const vi = segs.lastIndexOf("verify");
  if (vi >= 0 && segs[vi + 1] === "package") {
    const id = decodeURIComponent(segs[vi + 2] ?? "").trim();
    return id && SAFE_ID.test(id) ? `/verify/package/${encodeURIComponent(id)}` : null;
  }
  const qp = url.searchParams.get("id")?.trim();
  const ref = qp || (vi >= 0 && segs[vi + 1] ? decodeURIComponent(segs[vi + 1]).trim() : "");
  return ref && SAFE_ID.test(ref) ? `/verify/${encodeURIComponent(ref)}` : null;
}
