/**
 * Issue codes the capture readiness authority (`session-readiness.ts`) emits,
 * named for the presentation layer that must recognise them.
 *
 * Kept OUT of `session-readiness.ts` on purpose: that file is byte-pinned as
 * the finalize-gate logic (CR5), and naming a code for the UI is not gate
 * logic. The value here MUST equal the literal the authority emits; a web
 * contract test asserts both.
 */

/** The blocker the authority raises for a session with nothing staged. */
export const EMPTY_SESSION_ISSUE_CODE = "capture_empty_session";
