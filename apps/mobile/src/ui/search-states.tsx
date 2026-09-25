/**
 * THE SEARCH CONSOLE'S DISTINCT STATES — the native port of
 * apps/web/app/(app)/search/components/SearchStates.tsx and the "How search
 * works" disclosure (search/page.tsx:1891-1925).
 *
 * Each state has its own words, so "you have not searched yet", "your query
 * matched nothing", "the workspace declined" and "the service did not answer"
 * can never be rendered as one another. Only the unavailable state (and its
 * banner) may use connection language. Presentation only: the screen decides
 * which state is true, from the server.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { theme } from "../theme/theme";
import { SEARCH_RECOVERY_UNAVAILABLE_HINT } from "../product/search-readiness";
import { ProovraButton, ProovraCard, ProovraEmptyState, ProovraText } from "./index";

/** A. Nothing asked, nothing listed — the resting state. */
export function SearchPristineState() {
  return (
    <View testID="search-state-pristine">
      <ProovraEmptyState
        title="Search across this workspace"
        message="Search evidence, cases, reports, verification packages and notes. OCR and transcript text appear in results where a record provides them."
      />
    </View>
  );
}

/** B. A query ran and matched nothing. Not an error. */
export function SearchNoResultsState({ title, detail, onClearFilters }: { title: string; detail: string; onClearFilters?: () => void }) {
  return (
    <View testID="search-state-no-results">
      <ProovraEmptyState
        title={title}
        message={detail}
        action={onClearFilters ? <ProovraButton label="Clear filters" variant="secondary" fullWidth={false} onPress={onClearFilters} /> : undefined}
      />
    </View>
  );
}

/** E. The search service could not be reached. Retry + support. */
export function SearchUnavailableState({ onRetry, retrying, onContactSupport }: { onRetry: () => void; retrying: boolean; onContactSupport: () => void }) {
  return (
    <View testID="search-state-unavailable">
      <ProovraEmptyState
        title="Search is temporarily unavailable"
        message="The secure connection to the data indexing service was interrupted. Try refreshing the page or checking your network status."
        action={
          <View style={styles.actions}>
            <ProovraButton label={retrying ? "Retrying…" : "Retry Connection"} accessibilityLabel="Retry Connection" fullWidth={false} disabled={retrying} onPress={onRetry} />
            <ProovraButton label="Contact Support" variant="secondary" fullWidth={false} onPress={onContactSupport} />
          </View>
        }
      />
    </View>
  );
}

/** The banner that accompanies the outage state, and nothing else. */
export function SearchUnavailableAlert() {
  return (
    <View style={[styles.alert, { backgroundColor: theme.color.status.risk.bg, borderColor: theme.color.status.risk.border }]} accessibilityRole="alert" testID="search-alert-unavailable">
      <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.risk.fg}>Service Connection Interrupted</ProovraText>
      <ProovraText variant="label" color={theme.color.status.risk.fg}>
        {"We couldn't reach the search service. Check your connection and try again — your evidence data has not been changed."}
      </ProovraText>
    </View>
  );
}

/** An ACTION failed (load more, rebuild) — reported where it happened, never a search state. */
export function SearchActionError({ message }: { message: string }) {
  return (
    <View style={[styles.alert, { backgroundColor: theme.color.status.risk.bg, borderColor: theme.color.status.risk.border }]} accessibilityRole="alert" testID="search-action-error">
      <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{message}</ProovraText>
    </View>
  );
}

/** F. The workspace refused the request (403/404). No retry: the same grant is refused again. */
export function SearchRestrictedState() {
  return (
    <View testID="search-state-restricted">
      <ProovraEmptyState
        title="Search is not available for this workspace"
        message="Your current access does not include search in this workspace. Ask a workspace admin if you need it."
      />
    </View>
  );
}

/** I. Nothing to search yet — no work outstanding, so nothing is promised. */
export function SearchEmptyWorkspaceState({ workspaceName }: { workspaceName: string | null }) {
  return (
    <View testID="search-state-empty-workspace">
      <ProovraEmptyState
        title={`No searchable records yet${workspaceName ? ` in "${workspaceName}"` : ""}`}
        message="Evidence, cases, reports, packages and notes become searchable once they are created in this workspace."
      />
    </View>
  );
}

/** H. The workspace's first index is being built. Never beside a count. */
export function SearchInitializingState({ indexedCount, eligibleCount }: { indexedCount: number; eligibleCount: number }) {
  return (
    <View testID="search-state-initializing">
      <ProovraEmptyState
        title="Preparing workspace search…"
        message={eligibleCount > 0 ? `${indexedCount} of ${eligibleCount} records are searchable so far. This page updates on its own.` : "This page updates on its own."}
      />
    </View>
  );
}

/** J. Indexing has stopped with records outstanding and nothing to list. */
export function SearchStalledState({
  indexedCount,
  eligibleCount,
  canRecover,
  onRecover,
  recovering,
  recoveryNotice,
}: {
  indexedCount: number;
  eligibleCount: number;
  canRecover: boolean;
  onRecover: () => void;
  recovering: boolean;
  recoveryNotice: string | null;
}) {
  return (
    <View testID="search-state-stalled">
      <ProovraEmptyState
        title="Search indexing is not progressing"
        message={`${indexedCount} of ${eligibleCount} records in this workspace are searchable, and no indexing run is currently making progress. ${
          canRecover ? "Rebuilding will index the outstanding records." : "Indexing is retried automatically; the rest will appear once it catches up."
        }`}
        action={
          <View style={styles.actions}>
            {canRecover ? (
              <ProovraButton label={recovering ? "Starting…" : "Rebuild index"} accessibilityLabel="Rebuild index" variant="secondary" fullWidth={false} disabled={recovering} onPress={onRecover} />
            ) : (
              <ProovraText variant="label" color={theme.color.ink.muted} center>{SEARCH_RECOVERY_UNAVAILABLE_HINT}</ProovraText>
            )}
            {recoveryNotice ? <ProovraText variant="label" color={theme.color.ink.secondary} center accessibilityRole="text">{recoveryNotice}</ProovraText> : null}
          </View>
        }
      />
    </View>
  );
}

/** "How search works" — collapsed by default so results stay primary. */
export function SearchHelpDisclosure() {
  const [open, setOpen] = useState(false);
  return (
    <ProovraCard>
      <View style={styles.helpHead}>
        <ProovraText variant="bodySm" weight="semibold">How search works</ProovraText>
        <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? "Hide how search works" : "Show how search works"} hitSlop={8}>
          <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600}>{open ? "Hide" : "Show"}</ProovraText>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.helpBody} testID="search-help-body">
          {[
            "Titles, filenames, case names, report titles, package labels and note text are matched directly.",
            "OCR and transcript text are matched where a record carries them.",
            "Records you cannot access are counted above the results, never listed.",
            "The filters narrow by record type, evidence kind, lifecycle state and when a record was last updated.",
          ].map((line) => (
            <ProovraText key={line} variant="label" color={theme.color.ink.secondary}>{`• ${line}`}</ProovraText>
          ))}
        </View>
      ) : null}
    </ProovraCard>
  );
}

const styles = StyleSheet.create({
  actions: { gap: theme.space.s2, alignItems: "center" },
  alert: { gap: theme.space.s1, padding: theme.space.s3, borderRadius: theme.radius.sm, borderWidth: 1, marginBottom: theme.space.s2 },
  helpHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  helpBody: { gap: theme.space.s1, marginTop: theme.space.s2 },
});
