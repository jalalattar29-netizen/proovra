/**
 * UC-4 DERIVED REVIEW — the native Evidence Detail tab.
 *
 * Mounted only for records whose acquisition category is DIRECT_SCREEN_CAPTURE
 * (`isDerivedReviewEligible`), which is the same record-property gate the web
 * applies. Reads `GET /v1/evidence/:id/derived-review` and drives
 * `POST .../derived-review/generate`.
 *
 * The caveats are not decoration. This is text a machine reconstructed from
 * keyframes, and the projection carries its own provenance, coverage and
 * limitations so a reader is never left to assume it is a record of what was
 * on screen. They render above the blocks, always, and each block carries its
 * own confidence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, View } from "react-native";

import { apiBaseUrl, apiFetch, getAuthToken } from "../api";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraSection,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "./index";
import {
  buildDerivedReviewGeneratePath,
  buildDerivedReviewPath,
  buildGenerateBody,
  confidenceLabel,
  confidenceTone,
  derivedReviewCaveats,
  parseDerivedReview,
  runStatusLabel,
  runStatusTone,
  shouldPoll,
  type DerivedReview,
  blockKeyframeUrls,
  sourceLine,
  type DerivedBlock,
} from "../product/derived-review";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; review: DerivedReview }
  | { phase: "failed" };

/**
 * T-12 — "View source" (EvidenceDerivedReviewTab.tsx:270-300): which parts and
 * offsets the text came from, and up to six source keyframes. The keyframe
 * bytes route is AUTHENTICATED (media-intelligence.routes.ts:1334), so each
 * image carries the session's bearer token; the URLs are the server's proxy
 * paths, never storage keys.
 */
function BlockSource({ block, urls }: { block: DerivedBlock; urls: Record<string, string | null> }) {
  const [open, setOpen] = useState(false);
  const thumbs = blockKeyframeUrls(block, urls);
  if (block.sources.length === 0 && thumbs.length === 0) return null;
  const token = getAuthToken();
  return (
    <View style={{ gap: theme.space.s1 }}>
      <ProovraButton label={open ? "Hide source" : "View source"} variant="ghost" fullWidth={false} onPress={() => setOpen((v) => !v)} />
      {open ? (
        <>
          {block.sources.map((src, i) => (
            <ProovraText key={`${src.evidencePartId}-${i}`} variant="label" color={theme.color.ink.muted}>
              {sourceLine(src)}
            </ProovraText>
          ))}
          {thumbs.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
              {thumbs.map((u) => (
                <Image
                  key={u}
                  source={{ uri: u, headers: token ? { authorization: `Bearer ${token}` } : undefined }}
                  accessibilityLabel="Derived source keyframe"
                  style={{ width: 96, height: 64, borderRadius: theme.radius.sm, backgroundColor: theme.color.surface.muted }}
                  resizeMode="cover"
                />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function DerivedReviewTab({
  evidenceId,
  teamId,
}: {
  evidenceId: string;
  teamId: string | null;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const data = await apiFetch(buildDerivedReviewPath(evidenceId, teamId));
      if (!alive.current) return;
      setState({ phase: "loaded", review: parseDerivedReview(data, apiBaseUrl()) });
    } catch {
      if (!alive.current) return;
      setState({ phase: "failed" });
    }
  }, [evidenceId, teamId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Poll only while a run is in flight, and stop the moment it settles.
  const running = state.phase === "loaded" && shouldPoll(state.review.run);
  useEffect(() => {
    if (!running) return;
    const handle = setInterval(() => void load(), 4000);
    return () => clearInterval(handle);
  }, [running, load]);

  const generate = useCallback(
    async (regenerate: boolean) => {
      if (!teamId) return;
      setBusy(true);
      try {
        await apiFetch(buildDerivedReviewGeneratePath(evidenceId), {
          method: "POST",
          body: JSON.stringify(buildGenerateBody(teamId, regenerate)),
        });
        await load();
      } catch {
        setState({ phase: "failed" });
      } finally {
        setBusy(false);
      }
    },
    [evidenceId, teamId, load],
  );

  if (!teamId) return <ProovraLoadingState label="Resolving workspace" />;
  if (state.phase === "loading") return <ProovraLoadingState label="Derived review" />;
  if (state.phase === "failed") {
    return (
      <ProovraErrorState
        message="The derived review could not be loaded."
        onRetry={() => void load()}
      />
    );
  }

  const { run, projection, keyframeUrls } = state.review;
  const caveats = projection ? derivedReviewCaveats(projection) : [];

  return (
    <ProovraSection title="Derived review">
      <ProovraCard>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.space.s2,
          }}
        >
          <View style={{ flex: 1 }}>
            <ProovraText variant="body" weight="semibold">
              {runStatusLabel(run)}
            </ProovraText>
            {run.updatedAtIso ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {formatUserDateTime(run.updatedAtIso)}
              </ProovraText>
            ) : null}
          </View>
          <ProovraBadge label={runStatusLabel(run)} tone={runStatusTone(run)} />
        </View>

        {run.status === "FAILED" && run.lastError ? (
          <ProovraText variant="label" color={theme.color.status.risk.fg}>
            {run.lastError}
          </ProovraText>
        ) : null}

        <ProovraButton
          label={run.status === "COMPLETED" ? "Regenerate" : "Generate"}
          variant={run.status === "COMPLETED" ? "secondary" : "primary"}
          loading={busy}
          disabled={shouldPoll(run)}
          onPress={() => void generate(run.status === "COMPLETED")}
        />
      </ProovraCard>

      {projection === null ? (
        <ProovraEmpty
          presence="inline"
          title="Nothing has been reconstructed yet."
          purpose="Generate a derived review to read the text extracted from this recording's keyframes."
        />
      ) : (
        <>
          {/*
            The caveats come first and are never optional. Rendering the blocks
            without them would present a machine reconstruction as a record of
            what was on screen — the one claim this descriptor exists to avoid.
          */}
          {caveats.length > 0 ? (
            <ProovraCard>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                What this is, and is not
              </ProovraText>
              <View style={{ gap: theme.space.s1 }}>
                {caveats.map((c, i) => (
                  <ProovraText key={i} variant="label" color={theme.color.ink.muted}>
                    {`• ${c}`}
                  </ProovraText>
                ))}
              </View>
            </ProovraCard>
          ) : null}

          <ProovraCard>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`${projection.stats.keyframeCount} keyframe(s) from ${projection.stats.sourcePartCount} part(s)` +
                `${projection.generatedAtIso ? ` · generated ${formatUserDateTime(projection.generatedAtIso)}` : ""}`}
            </ProovraText>
          </ProovraCard>

          {projection.blocks.length === 0 ? (
            <ProovraEmpty
              presence="inline"
              title="No text was reconstructed from this recording."
            />
          ) : (
            <ProovraCard>
              <View style={{ gap: theme.space.s4 }}>
                {projection.blocks.map((block) => (
                  <View key={block.blockId} style={{ gap: theme.space.s1 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: theme.space.s2,
                      }}
                    >
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {`${block.kind} · seen in ${block.observedInFrames} frame(s)`}
                      </ProovraText>
                      <ProovraBadge
                        label={confidenceLabel(block.confidence)}
                        tone={confidenceTone(block.confidence)}
                      />
                    </View>
                    <ProovraText variant="body">{block.text}</ProovraText>
                    <BlockSource block={block} urls={keyframeUrls} />
                  </View>
                ))}
              </View>
            </ProovraCard>
          )}

          {projection.blockTotal > projection.blocks.length ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Showing ${projection.blocks.length} of ${projection.blockTotal} blocks.`}
            </ProovraText>
          ) : null}
        </>
      )}
    </ProovraSection>
  );
}
