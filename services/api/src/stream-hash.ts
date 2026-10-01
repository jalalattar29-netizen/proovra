// UC-ARCH-006 — the ONE streaming SHA-256 lives in @proovra/shared-runtime
// (integrity/digest.ts), shared with the worker's integrity recheck and report
// gate. This module keeps the API's historical import path.
export { sha256HexFromStream } from "@proovra/shared-runtime";
