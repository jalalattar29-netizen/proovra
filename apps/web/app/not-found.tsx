import { ProovraErrorState } from "../components/feedback/ProovraErrorState";

/**
 * Branded 404 (PROOVRA Feedback System). Calm, on-brand, useful CTAs —
 * no bare "Page not found" on an unstyled page.
 */
export default function NotFound() {
  return (
    <ProovraErrorState
      severity="info"
      title="Page not found"
      message="The page may have moved, or the link may no longer be available. Let's get you back on track."
      actions={[
        { label: "Back to home", href: "/", variant: "primary" },
        { label: "Open platform", href: "/platform", variant: "secondary" },
        { label: "Contact support", href: "/support", variant: "secondary" },
      ]}
    />
  );
}
