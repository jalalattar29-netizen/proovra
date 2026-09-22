/**
 * TRUST CENTER — the native port of `apps/web/app/(app)/trust-center/*`.
 *
 * The web splits the content across five routes, one per article KIND. A phone
 * has no sidebar to hold five destinations that each show one list, so native
 * renders them as sections of one screen: same canonical source
 * (`GET /v1/trust/articles?kind=`), same content, re-composed for the device.
 *
 * Each section loads and fails INDEPENDENTLY, because the endpoint reports a
 * read failure per kind and one unreadable section must not hide the other
 * four on a surface whose whole purpose is being checkable.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { formatUserDateTime } from "../../src/lib/date";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraEmpty,
  ProovraSheet,
} from "../../src/ui";
import {
  TRUST_SECTIONS,
  buildTrustArticlesPath,
  parseTrustArticles,
  isEntitlementDenial,
  type TrustArticle,
  type TrustSectionState,
} from "../../src/product/trust-center";

export default function TrustCenterScreen() {
  const router = useRouter();
  const [sections, setSections] = useState<Record<string, TrustSectionState | "loading">>({});
  const [open, setOpen] = useState<TrustArticle | null>(null);

  const load = useCallback(async () => {
    setSections(Object.fromEntries(TRUST_SECTIONS.map((s) => [s.kind, "loading" as const])));
    await Promise.all(
      TRUST_SECTIONS.map(async (s) => {
        try {
          const data = await apiFetch(buildTrustArticlesPath(s.kind));
          setSections((prev) => ({ ...prev, [s.kind]: parseTrustArticles(data) }));
        } catch (err) {
          setSections((prev) => ({
            ...prev,
            // A 403 is the entitlement gate, not a failure — say "not included
            // in your plan", never "something went wrong".
            [s.kind]: isEntitlementDenial(err)
              ? { phase: "locked" }
              : { phase: "degraded", reason: "ARTICLE_READ_FAILED" },
          }));
        }
      }),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraScreen testID="trust-center">
      <ProovraPageHeader
        title="Trust Center"
        eyebrow="Trust"
        subtitle="How PROOVRA verifies evidence, and what it does not claim."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {TRUST_SECTIONS.map((section) => {
        const state = sections[section.kind];
        return (
          <ProovraPageSection key={section.kind} title={section.label}>
            {state === "loading" || state === undefined ? (
              <ProovraEmpty presence="inline" title="Loading…" framed={false} />
            ) : state.phase === "locked" ? (
              <ProovraEmpty
                presence="inline"
                title="Not included in your plan"
                purpose="The Trust Center is available on plans that include it."
              />
            ) : state.phase === "degraded" ? (
              <ProovraCard>
                <ProovraBadge label="Unavailable" tone="risk" />
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  This section could not be read. The other sections are unaffected.
                </ProovraText>
                <ProovraButton
                  label="Try again"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => void load()}
                />
              </ProovraCard>
            ) : state.phase === "empty" ? (
              <ProovraEmpty
                presence="inline"
                title="Nothing published yet"
                purpose="Published articles for this section appear here."
              />
            ) : (
              <ProovraCard>
                {state.articles.map((a) => (
                  <ProovraButton
                    key={a.id || a.slug}
                    label={a.title}
                    variant="ghost"
                    onPress={() => setOpen(a)}
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>
        );
      })}

      <ProovraSheet visible={open !== null} title={open?.title ?? ""} onClose={() => setOpen(null)}>
        {open ? (
          <>
            {open.summary ? (
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {open.summary}
              </ProovraText>
            ) : null}
            <ProovraText variant="body">{open.body}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {[
                open.version !== null ? `Version ${open.version}` : null,
                open.updatedAtIso ? `Updated ${formatUserDateTime(open.updatedAtIso)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </ProovraText>
          </>
        ) : null}
      </ProovraSheet>
    </ProovraScreen>
  );
}
