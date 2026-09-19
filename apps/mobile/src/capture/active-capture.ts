/**
 * Canonical "capture in progress" signal (Phase 11 durability reconcile).
 *
 * Durability ownership: the canonical capture path is the server-issued
 * direct-capture SESSION (src/direct-capture.ts) + the bounded streaming
 * clients — NOT the legacy SQLite upload-queue (which nothing enqueues; it is
 * dead and slated for Phase-12 removal). Because the queue was dead, the
 * DeepLinkGate "block links during active capture" guard (which read the queue)
 * was inert. This dependency-free signal lets the live capture screens report a
 * real in-progress session so that guard is truthful again.
 */
let active = false;

export function setCaptureActive(next: boolean): void {
  active = next;
}

export function isCaptureActive(): boolean {
  return active;
}
