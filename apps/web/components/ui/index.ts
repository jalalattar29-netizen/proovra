/**
 * components/ui — PROOVRA shared UI foundation (Phase 7 / 7B).
 *
 * SINGLE import surface for internal pages. As of Phase 7B the legacy
 * `components/ui.tsx` file was renamed to `components/ui-legacy.tsx`,
 * which removed the file-vs-directory module-resolution SHADOW: `import
 * … from "…/components/ui"` now resolves unambiguously to THIS barrel.
 *
 * Two families live behind one door:
 *
 *   • New Phase-7 primitives (token-driven, logic-free):
 *       PageShell / PageHeader / PageSection, DataTable, FilterBar,
 *       Badge, EmptyState, StatusBadge, ConfirmAction*.
 *
 *   • Legacy primitives still relied on by ~60 accepted pages and
 *     re-exported UNCHANGED for backward compatibility:
 *       Button, Card, Modal, Input, Select, Tabs, ListRow, StatusPill,
 *       TopBar, BottomNav, TimelineBlock, Skeleton, SkeletonText,
 *       ToastProvider, useToast.
 *
 * NOTE ON Button / Card / Badge / EmptyState: the new versions (richer
 * variant/size/tone APIs) live at `./Button` `./Card` `./Badge`
 * `./EmptyState` and must be DEEP-imported (`components/ui/Card`) — the
 * barrel keeps serving the LEGACY four so existing bare-import call
 * sites (incl. multi-line imports in batch-analysis / verify) are not
 * force-migrated to the new prop shapes.
 *
 * All primitives consume the design tokens in `app/globals.css` +
 * `lib/design-tokens/tokens.css`. They contain NO product logic, no
 * data fetching, and no permission checks — presentation only.
 */

// ---------------------------------------------------------------------------
// New Phase-7 primitives (canonical design system).
// ---------------------------------------------------------------------------
export { PageShell, PageHeader, PageSection } from "./PageShell";
export type {
  PageShellProps,
  PageHeaderProps,
  PageSectionProps,
} from "./PageShell";

export { DataTable } from "./DataTable";
export type { DataTableProps, DataTableColumn } from "./DataTable";

export { FilterBar } from "./FilterBar";
export type {
  FilterBarProps,
  FilterSearchProps,
  FilterSelectProps,
  FilterSelectOption,
} from "./FilterBar";

export { StatusBadge, statusBadgeStyle } from "./StatusBadge";
export type { StatusBadgeProps } from "./StatusBadge";

export {
  ConfirmActionProvider,
  useConfirmAction,
} from "./ConfirmActionModal";
export type {
  ConfirmActionOptions,
  ConfirmActionTone,
} from "./ConfirmActionModal";

// ---------------------------------------------------------------------------
// Legacy primitives — re-exported UNCHANGED from ../ui-legacy for
// backward compatibility. Button + Card keep the legacy implementation
// here (deep-import ./Button, ./Card for the new versions).
// ---------------------------------------------------------------------------
export {
  Button,
  Card,
  Badge,
  EmptyState,
  StatusPill,
  Tabs,
  ListRow,
  TopBar,
  BottomNav,
  TimelineBlock,
  Modal,
  Skeleton,
  SkeletonText,
  Input,
  Select,
  ToastProvider,
  useToast,
} from "../ui-legacy";
export type { ToastOptions } from "../ui-legacy";
