// Compatibility re-export. The canonical marketing header lives at
// `apps/web/components/marketing/MarketingHeader.tsx`. Legacy paths
// (and the Phase 32.8 Foundation test) still expect a top-level
// `components/header.tsx` to exist; this file forwards to the real
// component without duplicating any UI logic.
//
// CR0: dead AppHeader + APP_NAV vocabulary intentionally absent.

export { MarketingHeader, MarketingHeader as default } from "./marketing/MarketingHeader";
