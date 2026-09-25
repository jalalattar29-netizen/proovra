/**
 * HOME SECTIONS (T-14) — the touch rendering of web Home cards:
 * Active matters, Public verification links and Team work. Models come from
 * `src/product/home-sections.ts`; Report production lives in
 * `home-overview.tsx` with its row actions.
 */
import React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { describeRelativeTime } from "../lib/relative-time";
import type { CaseHealthSummary } from "../product/home-dashboard";
import {
  MATTER_VERDICT_LABEL,
  matterChainLabel,
  middleTruncate,
  type ActiveMatters,
  type MatterVerdict,
  type TeamWork,
  type VerificationHealth,
} from "../product/home-sections";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraListRow, ProovraSection, ProovraText } from "./index";
import { ProovraEmpty, ProovraKpiGrid } from "./patterns";

const VERDICT_TONE: Record<MatterVerdict, "risk" | "pending" | "verified"> = {
  action_required: "risk",
  needs_work: "pending",
  healthy: "verified",
};

/** The web shows three rows and a "View all N →" link (HOME_PREVIEW_LIMIT). */
const PREVIEW = 3;

function Link({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600} accessibilityRole="link"
      accessibilityLabel={label} onPress={onPress} testID={testID}>
      {label}
    </ProovraText>
  );
}

export function HomeActiveMattersSection({
  matters,
  summary = null,
}: {
  matters: ActiveMatters;
  /** web CaseHealthSummary — header chips, each hidden at 0. */
  summary?: CaseHealthSummary | null;
}) {
  const router = useRouter();
  const chips = summary
    ? [
        summary.gapsCount > 0 ? { key: "gaps", label: `${summary.gapsCount} with evidence gaps`, tone: "pending" as const } : null,
        summary.blockersCount > 0 ? { key: "blocked", label: `${summary.blockersCount} blocked`, tone: "risk" as const } : null,
        summary.unlinkedCount > 0
          ? { key: "unlinked", label: `${summary.unlinkedCount} unlinked record${summary.unlinkedCount === 1 ? "" : "s"}`, tone: "info" as const }
          : null,
        summary.unreviewedCount > 0 ? { key: "unreviewed", label: `${summary.unreviewedCount} not reviewed`, tone: "pending" as const } : null,
      ].filter((c): c is NonNullable<typeof c> => c !== null)
    : [];
  return (
    <ProovraSection title="Active matters">
      {chips.length > 0 ? (
        <View testID="home-case-health-summary" style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1, marginBottom: theme.space.s2 }}>
          {chips.map((c) => (
            <ProovraBadge key={c.key} label={c.label} tone={c.tone} />
          ))}
        </View>
      ) : null}
      {!matters.available ? (
        // An unavailable projection is not an empty workspace.
        <ProovraText variant="bodySm" color={theme.color.ink.muted}>Matters could not be loaded right now.</ProovraText>
      ) : matters.rows.length === 0 ? (
        <ProovraEmpty
          presence="inline"
          title="No active matters yet"
          purpose="Group related evidence into a case to track a matter end-to-end."
          action={<ProovraButton label="Create case" fullWidth={false} onPress={() => router.push("/cases" as never)} />}
        />
      ) : (
        <ProovraCard testID="home-active-matters">
          {matters.rows.slice(0, PREVIEW).map((r) => (
            <View key={r.caseId} style={{ gap: 4, paddingVertical: theme.space.s1 }}>
              <ProovraListRow
                title={r.caseName}
                subtitle={[
                  r.statusLabel !== "On track" ? r.statusLabel : null,
                  matterChainLabel(r),
                  `${r.evidenceCount} ${r.evidenceCount === 1 ? "record" : "records"}`,
                  r.lastActivityAtUtc ? describeRelativeTime(r.lastActivityAtUtc) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                accessibilityHint="Opens the matter"
                testID={`home-matter-${r.caseId}`}
                onPress={() => router.push(`/case/${r.caseId}` as never)}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s1 }}>
                <ProovraBadge label={MATTER_VERDICT_LABEL[r.verdict]} tone={VERDICT_TONE[r.verdict]} />
                {r.hasActiveLegalHold ? <ProovraBadge label="Legal hold" tone="neutral" /> : null}
                <Link label="Open matter →" onPress={() => router.push(`/case/${r.caseId}` as never)} />
              </View>
            </View>
          ))}
          {matters.rows.length > PREVIEW ? (
            <Link label={`View all ${matters.rows.length} →`} testID="home-matters-view-all" onPress={() => router.push("/cases" as never)} />
          ) : null}
        </ProovraCard>
      )}
    </ProovraSection>
  );
}

export function HomeVerificationHealthSection({ health }: { health: VerificationHealth }) {
  const router = useRouter();
  const openVerify = (evidenceId: string) => router.push(`/verify?id=${encodeURIComponent(evidenceId)}` as never);
  return (
    <ProovraSection title="Public verification links">
      {health.empty ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          Public verification links appear once you publish a record — letting anyone independently confirm your evidence.
        </ProovraText>
      ) : null}
      <ProovraKpiGrid
        items={[
          // Only a live count earns the success tone; zeros stay neutral, as on the web.
          { key: "live", label: `verification page${health.live === 1 ? "" : "s"} live`, value: String(health.live), tone: health.live > 0 ? "verified" : undefined },
          { key: "unpublished", label: "Not published", value: String(health.unpublished) },
          { key: "suspended", label: "Suspended", value: String(health.suspended) },
        ]}
      />
      {health.unpublished > 0 ? (
        <ProovraButton label="Publish verification" variant="secondary" fullWidth={false} onPress={() => router.push("/evidence" as never)} />
      ) : null}
      {health.recentPublications.length > 0 ? (
        <ProovraCard testID="home-verify-recent-publications">
          <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>
            RECENTLY PUBLISHED
          </ProovraText>
          {health.recentPublications.map((pub) => (
            <ProovraListRow
              key={pub.href + pub.occurredAt}
              title={pub.label}
              subtitle={describeRelativeTime(pub.occurredAt)}
              onPress={() => router.push(pub.href as never)}
            />
          ))}
        </ProovraCard>
      ) : null}
      {health.verifiable.length > 0 ? (
        <ProovraCard testID="home-verifiable">
          {health.verifiable.slice(0, PREVIEW).map((v) => {
            const hasTitle = Boolean(v.title && v.title !== v.evidenceId);
            return (
              <View
                key={v.evidenceId}
                testID={`home-verifiable-${v.evidenceId}`}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2, paddingVertical: 4 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s1, flex: 1 }}>
                  <ProovraText variant="bodySm" weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {hasTitle ? v.title : middleTruncate(v.evidenceId)}
                  </ProovraText>
                  <ProovraText variant="label" weight="semibold" color={theme.color.status.verified.fg}>
                    Live
                  </ProovraText>
                </View>
                <Link label="Open verify →" onPress={() => openVerify(v.evidenceId)} />
              </View>
            );
          })}
          {health.verifiable.length > PREVIEW ? (
            <Link label="View all links →" testID="home-verify-view-all" onPress={() => router.push("/evidence" as never)} />
          ) : null}
        </ProovraCard>
      ) : null}
    </ProovraSection>
  );
}

export function HomeTeamWorkSection({ team }: { team: TeamWork }) {
  const router = useRouter();
  return (
    <ProovraSection
      title="Team work"
      action={<ProovraButton label="Manage team" variant="ghost" fullWidth={false} onPress={() => router.push("/teams" as never)} />}
    >
      <ProovraKpiGrid
        items={[
          { key: "review", label: "Awaiting review", value: String(team.submissionsAwaitingReview) },
          { key: "today", label: "Reports today", value: String(team.reportsToday) },
          { key: "members", label: "Members", value: String(team.members) },
          { key: "invites", label: "Pending invites", value: String(team.pendingInvites) },
        ]}
      />
    </ProovraSection>
  );
}
