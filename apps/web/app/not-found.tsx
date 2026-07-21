import { ProovraSystemState } from "../components/feedback/ProovraSystemState";

/**
 * Public (root) 404 — rendered for unknown URLs outside the authenticated
 * `(app)` group (which has its own in-shell boundary). Same canonical
 * visual system as every other state; only the recovery actions are
 * public-context.
 */
export default function NotFound() {
  return (
    <ProovraSystemState
      kind="not-found"
      context="public"
      testId="public-not-found"
      actions={[
        { label: "Go to homepage", href: "/", variant: "primary" },
        { label: "Sign in", href: "/login", variant: "secondary" },
        { label: "Contact support", href: "/support", variant: "text" },
      ]}
    />
  );
}
