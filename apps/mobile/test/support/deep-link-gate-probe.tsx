/** The gate, with what a test needs to observe it, in one module graph. */
export { DeepLinkGate } from "../../src/DeepLinkGate";
export { setAuthToken } from "../../src/api";
export { peekPendingRoute, takePendingRoute } from "../../src/deep-link/pending-intent";
export default function Nothing() {
  return null;
}