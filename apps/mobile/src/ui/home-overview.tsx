/**
 * HOME OVERVIEW + OPERATIONS CARDS — the touch rendering of the web Home
 * modules native did not have or rendered differently:
 *
 *   HomeHeaderBlock          ← HomeDashboardSections HomeHeader (greeting + CTA)
 *   HomeSummaryBand          ← ExecutiveSummaryBand (status, title, sentence, Also:, action)
 *   HomeWorkspaceHealthCard  ← HomeSections WorkspaceHealthCard
 *   HomePrioritiesCard       ← WorkspacePrioritiesCard ("What needs attention")
 *   HomeGettingStartedCard   ← GettingStartedChecklist
 *   HomeRecentEvidenceCard   ← RecentEvidenceCard
 *   HomeTrustStateCard       ← TrustStateCard ("Verification summary")
 *   HomeReportProductionCard ← ReportProductionCard + ReportRowActions
 *
 * Models come from `src/product/home-dashboard.ts` / `home-sections.ts`.
 */
import React, { useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { describeRelativeTime } from "../lib/relative-time";
import {
  PRIORITY_SEVERITY,
  buildTrustRows,
  homeToneBadge,
  type HomeSummary,
  type HomeTone,
  type OperationsVerdict,
  type ReportProduction,
  type TrustState,
  type WorkspacePriority,
} from "../product/home-dashboard";
import { middleTruncate, type RecentReportRow } from "../product/home-sections";
import { healthToneBadge, workspaceHealthOverall, type HealthMetric } from "../product/home-operations";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraListRow, ProovraText } from "./index";
import { ProovraEmpty, ProovraPageHeader, ProovraSheet } from "./patterns";

/** The web shows three preview rows and links to the full list (HOME_PREVIEW_LIMIT). */
export const HOME_PREVIEW_LIMIT = 3;

const TONE_INK: Record<HomeTone, string> = {
  ok: theme.color.status.verified.fg,
  warn: theme.color.status.pending.fg,
  danger: theme.color.status.risk.fg,
  neutral: theme.color.ink.primary,
};

/** A titled card, the web's SectionCard. */
function HomeCard({
  title,
  subtitle,
  cta,
  testID,
  children,
}: {
  title: string;
  subtitle?: string;
  cta?: { label: string; onPress: () => void };
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <ProovraCard testID={testID} style={{ gap: theme.space.s2, marginBottom: theme.space.s3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 }}>
        <View style={{ flex: 1 }}>
          <ProovraText variant="body" weight="semibold" accessibilityRole="header">
            {title}
          </ProovraText>
          {subtitle ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {subtitle}
            </ProovraText>
          ) : null}
        </View>
        {cta ? <ProovraButton label={cta.label} variant="ghost" fullWidth={false} onPress={cta.onPress} /> : null}
      </View>
      {children}
    </ProovraCard>
  );
}

/** An inline action link ("Open matter →"). */
export function HomeActionLink({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <ProovraText
      variant="label"
      weight="semibold"
      color={theme.color.accent.a600}
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
    >
      {label}
    </ProovraText>
  );
}

/* ------------------------------------------------------------------ header */

export function HomeHeaderBlock({
  greeting,
  cta,
}: {
  greeting: string;
  cta: { label: string; href: string };
}) {
  const router = useRouter();
  return (
    <ProovraPageHeader
      title={greeting}
      subtitle="Here's what's happening across your digital evidence operations today."
      primaryAction={<ProovraButton label={cta.label} fullWidth={false} onPress={() => router.push(cta.href as never)} />}
    />
  );
}

/* --------------------------------------------------------- summary band */

export function HomeSummaryBand({ summary }: { summary: HomeSummary }) {
  const router = useRouter();
  const rail = summary.tone === "risk" ? theme.color.status.risk.fg : summary.tone === "pending" ? theme.color.status.pending.fg : summary.tone === "verified" ? theme.color.status.verified.fg : theme.color.ink.muted;
  return (
    <ProovraCard
      testID="home-summary"
      accessibilityLabel={`${summary.state}. ${summary.title}. ${summary.sentence}`}
      style={{ gap: theme.space.s2, marginBottom: theme.space.s3, borderLeftWidth: 4, borderLeftColor: rail }}
    >
      <View style={{ flexDirection: "row" }}>
        <ProovraBadge label={summary.state} tone={summary.tone} />
      </View>
      <ProovraText variant="body" weight="semibold">
        {summary.title}
      </ProovraText>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        {summary.sentence}
      </ProovraText>
      {summary.secondarySignals.length > 0 ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`Also: ${summary.secondarySignals.join(" · ")}`}
        </ProovraText>
      ) : null}
      {summary.actionLabel && summary.actionHref ? (
        <ProovraButton
          label={`${summary.actionLabel} →`}
          accessibilityLabel={summary.actionLabel}
          variant="secondary"
          fullWidth={false}
          onPress={() => router.push(summary.actionHref as never)}
        />
      ) : null}
    </ProovraCard>
  );
}

/* ------------------------------------------------------ workspace health */

const HEALTH_OVERALL: Record<"healthy" | "needs_attention" | "action_required", { label: string; tone: "verified" | "pending" | "risk" }> = {
  healthy: { label: "Healthy", tone: "verified" },
  needs_attention: { label: "Needs attention", tone: "pending" },
  action_required: { label: "Action required", tone: "risk" },
};

export function HomeWorkspaceHealthCard({ health }: { health: HealthMetric[] }) {
  const verdict = HEALTH_OVERALL[workspaceHealthOverall(health)];
  return (
    <HomeCard title="Workspace health" testID="home-workspace-health">
      <View style={{ flexDirection: "row" }}>
        <ProovraBadge label={verdict.label} tone={verdict.tone} />
      </View>
      {health.map((m) => (
        <View
          key={m.key}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.space.s2,
            paddingVertical: 4,
            borderTopWidth: 1,
            borderTopColor: theme.color.border.subtle,
          }}
        >
          <ProovraText variant="label" color={theme.color.ink.secondary} style={{ flex: 1 }}>
            {m.label}
          </ProovraText>
          {/* An unknown reads as "—" and stays neutral. */}
          <ProovraText variant="label" weight="semibold" color={theme.color.status[healthToneBadge(m.tone)].fg}>
            {m.value}
          </ProovraText>
        </View>
      ))}
    </HomeCard>
  );
}

/* ------------------------------------------------------------ priorities */

export function HomePrioritiesCard({
  priorities,
  verdict,
}: {
  priorities: WorkspacePriority[];
  verdict: OperationsVerdict;
}) {
  const router = useRouter();
  const top = priorities.slice(0, HOME_PREVIEW_LIMIT);
  const more = priorities.length - top.length;
  return (
    <HomeCard title="What needs attention" testID="home-priorities">
      {top.length === 0 && verdict.loadState === "loading" ? (
        // Nothing is known yet: no count, no verdict, no all-clear.
        <ProovraEmpty presence="inline" framed={false} title="Checking…" purpose="Reading this workspace's operational status." />
      ) : top.length === 0 && !verdict.mayAssertAllClear ? (
        <ProovraEmpty
          presence="inline"
          framed={false}
          title={verdict.refusal?.title ?? "Operations status incomplete"}
          purpose={verdict.refusal?.detail ?? "Not every source could be read, so this may not be the full picture."}
        />
      ) : top.length === 0 ? (
        <ProovraEmpty presence="inline" framed={false} title="All clear" purpose="No workspace priorities need attention right now." />
      ) : (
        <>
          {top.map((p) => {
            const sev = PRIORITY_SEVERITY[p.severity];
            return (
              <View
                key={p.key}
                testID={`home-priority-${p.key}`}
                style={{ gap: 4, paddingVertical: theme.space.s2, borderTopWidth: 1, borderTopColor: theme.color.border.subtle }}
              >
                <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>
                    {p.label}
                  </ProovraText>
                  <ProovraBadge label={sev.label} tone={sev.tone} />
                </View>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {p.whyItMatters}
                </ProovraText>
                <HomeActionLink label={`${p.actionLabel} →`} onPress={() => router.push(p.href as never)} />
              </View>
            );
          })}
          {more > 0 ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`+${more} lower-priority item${more === 1 ? "" : "s"} tracked`}
            </ProovraText>
          ) : null}
        </>
      )}
    </HomeCard>
  );
}

/* --------------------------------------------------------- getting started */

export function HomeGettingStartedCard() {
  const router = useRouter();
  return (
    <HomeCard title="Start your first evidence workflow" testID="home-getting-started">
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        Capture your first record or create a case to get started.
      </ProovraText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        <ProovraButton label="Capture evidence" fullWidth={false} onPress={() => router.push("/capture")} />
        <ProovraButton label="Create a case" variant="secondary" fullWidth={false} onPress={() => router.push("/cases" as never)} />
      </View>
    </HomeCard>
  );
}

/* ------------------------------------------------------- recent evidence */

export interface HomeRecentEvidenceRow {
  id: string;
  title: string;
  subtitle: string;
  statusLabel: string;
  statusTone: React.ComponentProps<typeof ProovraBadge>["tone"];
}

export function HomeRecentEvidenceCard({ rows, body }: { rows: HomeRecentEvidenceRow[]; body?: React.ReactNode }) {
  const router = useRouter();
  return (
    <HomeCard title="Recent evidence" testID="home-recent-evidence" cta={{ label: "All evidence →", onPress: () => router.push("/evidence" as never) }}>
      {body ??
        (rows.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            Your newest records appear here after the first capture.
          </ProovraText>
        ) : (
          rows.slice(0, HOME_PREVIEW_LIMIT).map((r) => (
            <ProovraListRow
              key={r.id}
              title={r.title}
              subtitle={r.subtitle}
              trailing={<ProovraBadge tone={r.statusTone} label={r.statusLabel} />}
              onPress={() => router.push(`/evidence/${r.id}` as never)}
            />
          ))
        ))}
    </HomeCard>
  );
}

/* ---------------------------------------------------- verification summary */

export function HomeTrustStateCard({ trust }: { trust: TrustState }) {
  const router = useRouter();
  return (
    <HomeCard title="Verification summary" testID="home-trust-state">
      {trust.empty ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          No evidence captured yet — these are the integrity signals each record will earn once captured.
        </ProovraText>
      ) : null}
      {buildTrustRows(trust).map((r) => (
        <View
          key={r.key}
          testID={`home-trust-${r.key}`}
          style={{ gap: 2, paddingVertical: 4, borderTopWidth: 1, borderTopColor: theme.color.border.subtle }}
        >
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {r.label}
          </ProovraText>
          <ProovraText variant="label" weight="semibold">
            {r.segments.map((seg, i) => (
              <ProovraText key={seg.text} variant="label" weight="semibold" color={TONE_INK[seg.tone]}>
                {i > 0 ? " · " : ""}
                {seg.text}
              </ProovraText>
            ))}
          </ProovraText>
        </View>
      ))}
      {trust.empty ? <ProovraButton label="Capture first evidence" fullWidth={false} onPress={() => router.push("/capture")} /> : null}
      <ProovraText variant="label" color={theme.color.ink.muted}>
        PROOVRA records integrity signals; it does not determine factual truth or legal admissibility.
      </ProovraText>
    </HomeCard>
  );
}

/* ------------------------------------------------------- report production */

function ProductionStat({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "danger" }) {
  const active = value > 0;
  const t = active ? homeToneBadge(tone) : "neutral";
  return (
    <View
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flex: 1,
        minWidth: 64,
        padding: theme.space.s2,
        borderRadius: 10,
        backgroundColor: theme.color.status[t].bg,
        borderWidth: 1,
        borderColor: theme.color.status[t].border,
        alignItems: "center",
      }}
    >
      <ProovraText variant="h3" weight="bold" color={theme.color.status[t].fg}>
        {String(value)}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.status[t].fg} center>
        {label}
      </ProovraText>
    </View>
  );
}

export function HomeReportProductionCard({
  production,
  recent,
  reportsIncluded,
}: {
  production: ReportProduction;
  recent: RecentReportRow[];
  reportsIncluded: boolean;
}) {
  const router = useRouter();
  const hasAny =
    production.reportsReady + production.packagesReady + production.reportsPending + production.packagesPending + production.reportsFailed + production.packagesFailed > 0 ||
    recent.length > 0;
  return (
    <HomeCard title="Report production" testID="home-report-production">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <ProductionStat label="Reports ready" value={production.reportsReady} tone="ok" />
        <ProductionStat label="Packages ready" value={production.packagesReady} tone="ok" />
        <ProductionStat label="Pending" value={production.reportsPending + production.packagesPending} tone="warn" />
        <ProductionStat label="Failed" value={production.reportsFailed + production.packagesFailed} tone="danger" />
      </View>
      {production.needsAction.map((i) => (
        <View
          key={i.key}
          testID={`home-report-issue-${i.key}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space.s2,
            padding: theme.space.s2,
            borderRadius: 8,
            backgroundColor: theme.color.status[i.tone === "danger" ? "risk" : i.tone === "warn" ? "pending" : "neutral"].bg,
          }}
        >
          <ProovraText variant="label" weight="semibold" style={{ flex: 1 }}>
            {`${i.count} · ${i.label}`}
          </ProovraText>
          <HomeActionLink label={`${i.actionLabel} →`} onPress={() => router.push(i.href as never)} />
        </View>
      ))}
      {!hasAny ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {reportsIncluded
            ? "Complete an evidence record to generate your first report."
            : "Reports are included with Pay-Per-Evidence, Pro, and Team."}
        </ProovraText>
      ) : recent.length === 0 ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          No reports generated yet — the counts above update as production runs.
        </ProovraText>
      ) : (
        <>
          {recent.slice(0, HOME_PREVIEW_LIMIT).map((r) => (
            <HomeReportRow key={r.evidenceId} row={r} />
          ))}
          {recent.length > HOME_PREVIEW_LIMIT ? (
            <HomeActionLink label="Open reports →" onPress={() => router.push("/reports" as never)} />
          ) : null}
        </>
      )}
    </HomeCard>
  );
}

/**
 * web ReportRowActions — Open, and a "More actions" menu with Download PDF,
 * Download package and Verify page. A download mints a URL on TAP only
 * (`/report/latest` records a custody download) and opens what the server
 * returned; nothing is pre-fetched per row.
 */
export function HomeReportRow({ row }: { row: RecentReportRow }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<"pdf" | "package" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasTitle = Boolean(row.title && row.title !== row.evidenceId);

  const trigger = async (kind: "pdf" | "package", path: string) => {
    if (busy) return;
    setMenuOpen(false);
    setBusy(kind);
    setError(null);
    try {
      const resp = (await apiFetch(path)) as { url?: string; code?: string } | null;
      if (resp?.url) await Linking.openURL(resp.url);
      else if (resp?.code === "verification_package_pending") setError("Package is still generating.");
      else setError(kind === "pdf" ? "Report URL is unavailable." : "Package URL is unavailable.");
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      setError(
        status === 202
          ? kind === "pdf"
            ? "Report is still generating."
            : "Package is still generating."
          : status === 403
            ? "You don't have permission to download this."
            : status === 409
              ? toSafeUserError(e, { message: "Download blocked by workspace policy." }).message
              : status === 404
                ? "File not found."
                : toSafeUserError(e, { message: "Could not start download." }).message,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <View
      testID={`home-report-${row.evidenceId}`}
      style={{ gap: 4, paddingVertical: theme.space.s2, borderTopWidth: 1, borderTopColor: theme.color.border.subtle }}
    >
      <ProovraText variant="bodySm" weight="semibold" numberOfLines={1}>
        {hasTitle ? row.title : middleTruncate(row.evidenceId)}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {[
          `Report${row.version != null ? ` v${row.version}` : ""}`,
          row.packageReady ? "Package ready" : "No package",
          row.generatedAtUtc ? describeRelativeTime(row.generatedAtUtc) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </ProovraText>
      <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
        <ProovraButton
          label="Open"
          accessibilityLabel={`Open ${hasTitle ? row.title : row.evidenceId}`}
          variant="secondary"
          fullWidth={false}
          onPress={() => router.push(`/evidence/${row.evidenceId}` as never)}
        />
        <ProovraButton
          label={busy ? "Opening…" : "⋯"}
          accessibilityLabel="More actions"
          variant="secondary"
          fullWidth={false}
          disabled={busy !== null}
          onPress={() => setMenuOpen(true)}
        />
      </View>
      {error ? (
        <ProovraText variant="label" color={theme.color.status.risk.fg}>
          {error}
        </ProovraText>
      ) : null}
      <ProovraSheet visible={menuOpen} title={hasTitle ? row.title : "Report actions"} onClose={() => setMenuOpen(false)}>
        <ProovraButton label="Download PDF" variant="secondary" onPress={() => void trigger("pdf", row.reportPdfApiPath)} />
        {row.packageZipApiPath ? (
          <ProovraButton label="Download package" variant="secondary" onPress={() => void trigger("package", row.packageZipApiPath as string)} />
        ) : null}
        {row.packageReady ? (
          <ProovraButton
            label="Verify page"
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              router.push(`/verify?id=${encodeURIComponent(row.evidenceId)}` as never);
            }}
          />
        ) : null}
      </ProovraSheet>
    </View>
  );
}
