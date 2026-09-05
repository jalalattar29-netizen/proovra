"use client";

/**
 * PHASE 6 §6 — THE LAST CRUMB SHOULD NAME THE RECORD, NOT ITS TYPE.
 *
 * Every contextual detail rendered a static type name: an operator reading
 * Acme Legal's page saw "Platform admin › Customers & organizations ›
 * Customer directory › Customer". Correct, and useless — three of those four
 * crumbs are the same on every customer page, and the one that would tell you
 * WHICH customer you are looking at said "Customer".
 *
 * ===========================================================================
 * WHY A CONTEXT AND NOT A PROP
 * ===========================================================================
 * The breadcrumb is rendered by the admin LAYOUT, deliberately: nineteen of
 * the pages omitted the console nav for exactly as long as rendering it was
 * each page's own job. The layout therefore cannot know the entity — only the
 * detail page has fetched it.
 *
 * So the page publishes upward. `useAdminEntityCrumb(label)` sets it while the
 * page is mounted and clears it on unmount, which is what makes navigating
 * from one customer to another, or back to the list, leave nothing stale
 * behind.
 *
 * ===========================================================================
 * THE FALLBACK IS THE POINT
 * ===========================================================================
 * A page that has not loaded yet, a page whose fetch failed, and a page whose
 * entity has been deleted all publish nothing — and the crumb falls back to
 * the static type name from the contextual route. That is the honest answer:
 * "Customer" is true of a record we cannot name, whereas an empty crumb is a
 * broken chain and a guessed name is a lie.
 *
 * A deleted entity may publish an explicit fallback of its own, which is how
 * "Deleted customer" reaches the crumb rather than a blank.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type EntityCrumb = { label: string | null };

const AdminEntityCrumbContext = createContext<{
  entity: EntityCrumb;
  publish: (label: string | null) => void;
} | null>(null);

export function AdminEntityCrumbProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  const value = useMemo(
    () => ({ entity: { label }, publish: setLabel }),
    [label],
  );
  return (
    <AdminEntityCrumbContext.Provider value={value}>
      {children}
    </AdminEntityCrumbContext.Provider>
  );
}

/** Read by the breadcrumb. Null whenever no page has published a name. */
export function useAdminEntityCrumbValue(): string | null {
  return useContext(AdminEntityCrumbContext)?.entity.label ?? null;
}

/**
 * Publish the name of the record this page is showing.
 *
 * Pass null while loading, on failure, or when the entity is gone — the crumb
 * then shows the type name instead of an empty or invented one.
 *
 * Safe outside the provider (a detail page rendered in a test harness), so a
 * page never has to guard the call.
 */
export function useAdminEntityCrumb(label: string | null | undefined): void {
  const ctx = useContext(AdminEntityCrumbContext);
  const publish = ctx?.publish;
  const next = label && label.trim() ? label.trim().slice(0, 80) : null;
  useEffect(() => {
    if (!publish) return;
    publish(next);
    return () => publish(null);
  }, [publish, next]);
}

/**
 * The same thing for a SERVER page.
 *
 * The runbook reader is server-rendered — it resolves the document before it
 * renders, which is right — so it cannot call a hook. It renders this instead,
 * which is a client component that publishes and draws nothing.
 */
export function AdminEntityCrumbPublisher({
  label,
}: {
  label: string | null | undefined;
}) {
  useAdminEntityCrumb(label);
  return null;
}
