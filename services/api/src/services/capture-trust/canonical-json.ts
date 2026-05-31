/**
 * Phase 1B Closure — API-side re-export of the shared canonical-JSON
 * serialiser. The single source of truth is `@proovra/shared` so
 * the bytes the device signs are exactly the bytes the server
 * verifies. Do not add a parallel implementation here.
 */

export {
  canonicalJson as canonicalize,
  CanonicalJsonError,
  canonicalUtf8Length,
} from "@proovra/shared";
