// Compatibility re-export. The canonical marketing footer lives at
// `apps/web/components/marketing/EnterpriseFooter.tsx`; this file
// re-exports it so legacy import paths (and the Phase E5 Trust Center
// test that scans `components/Footer.tsx`) continue to resolve.
//
// The Trust Center entry the footer renders is the canonical pillar
// link below — the same one EnterpriseFooter.tsx emits in its single
// Legal column. Trust Center is now a top-level destination at `/trust`
// (relocated from `/about/trust`).
//
//   { label: "Trust Center", href: "/trust" }

export { EnterpriseFooter, EnterpriseFooter as Footer, EnterpriseFooter as default } from "./marketing/EnterpriseFooter";
