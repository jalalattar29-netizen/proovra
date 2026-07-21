/**
 * ProovraDenialState — thin authenticated-context preset over the
 * canonical `ProovraSystemState`, for access/denial/recovery gates
 * (PageRouteGate, SurfaceGate forbidden, AccessGate, WorkspaceRecovery,
 * CapabilityDegradedPanel).
 *
 * It fixes `context="authenticated"` and defaults to the `contained`
 * presentation (gates render inside an existing page/App Shell canvas,
 * not as a full-viewport takeover) while inheriting the exact same
 * typography, symbol system, tokens, actions, and support-reference
 * behaviour as every other system state. No legacy dark gradients, no
 * red panels, no command-center chrome, no raw request ids.
 */

import {
  ProovraSystemState,
  type ProovraSystemStateProps,
} from "./ProovraSystemState";

export type ProovraDenialStateProps = Omit<
  ProovraSystemStateProps,
  "context"
>;

export function ProovraDenialState({
  presentation = "contained",
  ...rest
}: ProovraDenialStateProps) {
  return (
    <ProovraSystemState
      context="authenticated"
      presentation={presentation}
      {...rest}
    />
  );
}
