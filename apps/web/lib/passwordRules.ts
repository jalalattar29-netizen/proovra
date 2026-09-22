/**
 * MOVED — the canonical rules now live in `@proovra/shared/password-rules`,
 * because Native needs the same panel and the same meter, and two password
 * rule sets that disagree are worse than either alone.
 *
 * This file stays as the path the web's auth pages already import, so the move
 * changed one module's home rather than every call site.
 */
export * from "@proovra/shared/password-rules";
