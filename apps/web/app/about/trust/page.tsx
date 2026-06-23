// Trust Center — /about/trust compatibility route.
//
// The canonical Trust Center implementation lives at
// `apps/web/app/trust/page.tsx`. This file exists so the in-app
// AppTopbarV2 help link (`href="/about/trust"`) and any pre-existing
// external links to /about/trust continue to land on the same
// canonical content. There is no separate "About > Trust" page to
// maintain — /about/trust follows /trust, not the other way around.
//
// IMPORTANT: Do NOT add About-only content here. If About needs an
// overview that links into the Trust Center, build it on /about and
// leave this route as the canonical Trust Center re-export.
// Re-exports only `default` — Next.js disallows a `metadata` export
// inside the "use client" canonical module. Page-level title/description
// fall back to the root layout for this compatibility route.
export { default } from "../../trust/page";
