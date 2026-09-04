"use client";

/**
 * PHASE 38.8 — Enterprise command palette.
 *
 * Cmd+K / Ctrl+K opens. Indexes the canonical `routeRegistry`. Uses
 * `resolveRouteAccess()` to label each result (Available / Requires
 * organization / Requires permission / Advanced). Workflow profile
 * changes RANKING only — never access.
 *
 * Hard rules:
 *
 *   1. The palette NEVER bypasses access. Capability-gated routes
 *      show their structured reason + a "Request access" CTA, never
 *      open the route directly when denied.
 *   2. The palette NEVER auto-changes the workflow profile.
 *   3. Bounded vocabulary. Status badges come from the access
 *      resolver's bounded `accessState`.
 *   4. Keyboard-first: arrow keys, Enter to open, Escape to close,
 *      Cmd+K / Ctrl+K toggles.
 *   5. Focus management: opening focuses the search input; closing
 *      restores focus to the trigger.
 *   6. Accessible: dialog semantics, labeled input, aria-current on
 *      the highlighted result.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import {
  usePersonalSpaceFragment,
  usePlatformContext,
  useWorkspaceFragment,
} from "../../lib/platform-context";
import {
  ROUTE_REGISTRY,
  type RouteDefinition,
} from "../../lib/navigation/routeRegistry";
import {
  dedupeByDestination,
  orderPaletteCandidates,
  paletteGroupFor,
  paletteTitleFor,
} from "../../lib/navigation/paletteModel";
import { operationalGroupDescriptor } from "../../lib/navigation/phaseBOperationalGroups";
import {
  resolveRouteAccess,
  type RouteAccessResult,
} from "../../lib/navigation/routeAccessResolver";

type IndexedItem = {
  route: RouteDefinition;
  access: RouteAccessResult;
  /** Static ranking score; higher = earlier in the result list. */
  rank: number;
};

const MAX_RESULTS = 20;


export function CommandPalette() {
  const { envelope } = usePlatformContext();
  // PERSONAL-FIRST RESCUE fragments come from the centralized
  // platform-context hooks — direct envelope reads for the workspace
  // fragment are forbidden outside lib/platform-context (see
  // phase-g4-tenancy-cleanup.test.ts).
  const workspaceFragment = useWorkspaceFragment();
  const personalSpaceFragment = usePersonalSpaceFragment();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const indexed = useMemo<IndexedItem[]>(() => {
    const items: IndexedItem[] = [];
    for (const route of ROUTE_REGISTRY) {
      // Track 1A (surface-tier removal) — the ONE resolver decides.
      // Enterprise + commercial gating come from the SERVER-projected
      // flags/planFeatures booleans passed below (canSeeNav: false
      // excludes those routes from the cmd-K corpus).
      const access = resolveRouteAccess({
        route,
        activeSpaceType: envelope?.activeSpace?.type ?? null,
        isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
        capabilities: envelope?.capabilities ?? {},
        accountPlan: envelope?.account?.accountPlan ?? null,
        isEnterpriseWorkspace: envelope?.flags?.isEnterpriseWorkspace === true,
        planFeatures: envelope?.planFeatures ?? null,
        // PERSONAL-FIRST RESCUE — pass envelope fragments so the gate
        // can fall back to workspace.id / personalSpace.id when
        // activeSpace.type is missing from the backend projection.
        // Required so personal-only users are NEVER blocked from core
        // product routes (capture / evidence / reports / verify / etc.)
        // even when the backend returns a partial envelope.
        workspace: workspaceFragment,
        personalSpace: personalSpaceFragment,
      });
      // Hidden routes (e.g. platform-admin-only) are excluded from
      // command-palette search even before query filtering.
      if (!access.canSeeNav) continue;
      if (!route.commandPaletteVisible) continue;
      /*
       * No pre-ranking here any more.
       *
       * The old score was `canLoad ? 2 : 0` plus `advancedByDefault ? 0 : 1`,
       * so every route landed on one of four values and the list was then cut
       * at twenty. A user entitled to MORE routes had more 3s, which pushed
       * every 2 — `/tools` among them — off the visible list entirely. That is
       * why FREE saw All Tools and PRO did not.
       *
       * Ordering is now a function of the QUERY, in `paletteModel`.
       */
      items.push({ route, access, rank: 0 });
    }
    return items;
  }, [envelope, workspaceFragment, personalSpaceFragment]);

  // Filter + rank for the current query.
  const results = useMemo<IndexedItem[]>(() => {
    /*
     * Relevance first, then destination-dedup, then the cap.
     *
     * Deduping AFTER ordering keeps the best-matching label for a destination
     * that several registry entries point at, and deduping BEFORE the cap means
     * a duplicate can no longer consume one of the twenty slots.
     */
    const ordered = orderPaletteCandidates(
      indexed.map((item) => ({ route: item.route, canLoad: item.access.canLoad, item })),
      query,
    );
    return dedupeByDestination(ordered.map((c) => c.item)).slice(0, MAX_RESULTS);
  }, [indexed, query]);

  // Reset highlight when the result set changes.
  useEffect(() => {
    setHighlight(0);
  }, [results.length, query]);

  // Open / close handlers.
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    // Restore focus to the trigger if it remembered one.
    const t = triggerRef.current;
    if (t && typeof t.focus === "function") {
      t.focus();
    }
  }, []);

  const openPalette = useCallback(() => {
    triggerRef.current =
      (typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null) ?? null;
    setOpen(true);
    // Defer focus to the input element after the next render.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Global Cmd+K / Ctrl+K listener.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isOpenShortcut =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isOpenShortcut) {
        e.preventDefault();
        setOpen((prev) => {
          if (prev) {
            close();
            return false;
          }
          openPalette();
          return true;
        });
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, openPalette]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[highlight];
      if (!target) return;
      // If access is denied, route to the access resolver's primary
      // action (e.g. /teams to create an org). Never bypass.
      if (target.access.canLoad) {
        router.push(target.route.href);
      } else if (target.access.primaryAction) {
        router.push(target.access.primaryAction.href);
      } else {
        // Phase IA-self-serve-regression-fix — fallback was
        // `/tools`, but `/tools` is INTERNAL (notFound for non-
        // admins). For self-serve users this fallback rendered the
        // 404 page. Route to `/home` instead — every user can reach
        // home, so the palette never lands the user on a blank
        // page.
        router.push("/home");
      }
      close();
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-command-palette
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.4)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          width: "min(640px, 92vw)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          border: "1px solid #cbd5e1",
          borderRadius: 10,
          boxShadow: "0 24px 64px rgba(15, 23, 42, 0.25)",
          overflow: "hidden",
        }}
      >
        <label
          htmlFor="command-palette-input"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0,0,0,0)",
            border: 0,
          }}
        >
          Search tools and routes
        </label>
        <input
          id="command-palette-input"
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Search tools, routes, settings…"
          aria-label="Search tools and routes"
          data-command-palette-input
          style={{
            border: "none",
            borderBottom: "1px solid #e2e8f0",
            outline: "none",
            padding: "14px 16px",
            fontSize: 15,
          }}
        />
        <ul
          role="listbox"
          aria-label="Search results"
          data-command-palette-results
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            overflowY: "auto",
            flex: 1,
          }}
        >
          {results.length === 0 ? (
            <li
              style={{ padding: "16px", color: "#64748b", fontSize: 13 }}
              data-command-palette-empty
            >
              No matching tools. Workflow profiles personalize ranking; they
              do not change permissions or remove tools.
            </li>
          ) : (
            results.map((item, idx) => {
              const isHighlighted = idx === highlight;
              // Phase G2 (B.6) — Phase B operational group attribution.
              // Renders a small group chip beside each result so
              // operators see Workspace · Governance · Outputs ·
              // System grouping at a glance.
              const opGroup = operationalGroupDescriptor(item.route.id);
              return (
                <li
                  key={item.route.id}
                  role="option"
                  aria-current={isHighlighted ? "true" : undefined}
                  aria-selected={isHighlighted}
                  data-command-palette-result-id={item.route.id}
                  data-command-palette-result-state={item.access.accessState}
                  data-command-palette-operational-group={opGroup?.id ?? ""}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => {
                    if (item.access.canLoad) {
                      router.push(item.route.href);
                    } else if (item.access.primaryAction) {
                      router.push(item.access.primaryAction.href);
                    } else {
                      // Phase IA-self-serve-regression-fix — fallback was
        // `/tools`, but `/tools` is INTERNAL (notFound for non-
        // admins). For self-serve users this fallback rendered the
        // 404 page. Route to `/home` instead — every user can reach
        // home, so the palette never lands the user on a blank
        // page.
        router.push("/home");
                    }
                    close();
                  }}
                  style={{
                    padding: "10px 16px",
                    background: isHighlighted ? "#eef2ff" : "transparent",
                    cursor: "pointer",
                    borderBottom: "1px solid #f1f5f9",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      {/*
                        ONE title and, below, one quiet metadata line.

                        A row could previously carry three capsules at once — an
                        operational-group chip, an "Advanced" chip and a status
                        chip — so a list of twenty rows rendered up to sixty
                        pills and read like a diagnostic table rather than a way
                        to get somewhere. The same facts are still here; they
                        are just no longer shouted.
                      */}
                      <strong style={{ fontSize: 13, color: "#0f172a" }}>
                        {paletteTitleFor(item.route)}
                      </strong>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "#475569",
                        marginTop: 2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.route.description}
                    </div>
                    {/*
                      ONE metadata line, in words rather than capsules.

                      Group tells the reader what KIND of destination this is —
                      the distinction the screenshots lost, where seven Settings
                      subpages read as unrelated product tools. Availability is
                      appended only when it is not simply "you can open this".
                    */}
                    <div
                      data-command-palette-meta
                      data-command-palette-group={paletteGroupFor(item.route)}
                      style={{
                        fontSize: 11,
                        color: "var(--app-ink-secondary, #667085)",
                        marginTop: 3,
                      }}
                    >
                      {paletteGroupFor(item.route)}
                      {item.access.canLoad ? null : (
                        <>
                          {" · "}
                          {/*
                            Slate, not red. Needing an organization is a normal
                            entitlement boundary, not a fault — this line used
                            `--status-risk-fg` (#991b1b), so every enterprise
                            surface a personal user could see was painted like
                            an error they had caused.
                          */}
                          <span
                            data-command-palette-availability={item.access.accessState}
                            style={{ color: "var(--app-ink-secondary, #667085)" }}
                          >
                            {item.access.accessState === "NEEDS_ORGANIZATION"
                              ? "Requires organization"
                              : "Not available here"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <kbd
                    aria-hidden="true"
                    style={{
                      fontSize: 10,
                      color: "#64748b",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ↵
                  </kbd>
                </li>
              );
            })
          )}
        </ul>
        <footer
          data-command-palette-footer
          style={{
            borderTop: "1px solid #e2e8f0",
            padding: "8px 16px",
            fontSize: 11,
            color: "#64748b",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>
            <kbd>↑↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>esc</kbd> close
          </span>
          <span>Cmd+K to toggle</span>
        </footer>
      </div>
    </div>
  );
}
