/**
 * LEGAL DOCUMENT READER — the native port of `apps/web/app/legal/[slug]` and
 * `apps/web/app/(app)/settings/legal/[slug]`.
 *
 * The web has two readers for one corpus: a public one and an authenticated one
 * that keeps cross-references inside the App Shell. Native has one screen and
 * one navigation stack, so a cross-reference simply pushes the next document —
 * the distinction the web draws exists because it has two shells, and native
 * does not. Same corpus, same text, one destination.
 *
 * Content comes from `GET /v1/legal/:slug`, the same module the web renders.
 * Nothing is bundled and nothing opens a browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraPageHeader,
  ProovraLoadingState,
  ProovraErrorState,
} from "../../../src/ui";
import { LegalDocumentBody } from "../../../src/ui/legal-document";
import {
  buildLegalDocumentPath,
  legalSlugFromWebPath,
  parseLegalDocument,
  parseLegalMarkdown,
  legalToc,
  stripLeadingTitle,
  type LegalDocument,
} from "../../../src/product/legal";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; doc: LegalDocument }
  | { phase: "missing" }
  | { phase: "failed" };

export default function LegalDocumentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;

  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    if (!slug) {
      setState({ phase: "missing" });
      return;
    }
    setState({ phase: "loading" });
    try {
      const data = await apiFetch(buildLegalDocumentPath(slug));
      const doc = parseLegalDocument(data);
      setState(doc ? { phase: "loaded", doc } : { phase: "missing" });
    } catch (err) {
      // A 404 is "no such document", which is a real answer and not a failure.
      // `apiFetch` reports the HTTP status as `statusCode` and the API's own
      // error code as `code`; reading `status` finds neither and turns every
      // unknown slug into "something went wrong".
      const e = err as { statusCode?: number; code?: string } | undefined;
      const missing =
        e?.statusCode === 404 || e?.code === "LEGAL_DOCUMENT_NOT_FOUND";
      setState({ phase: missing ? "missing" : "failed" });
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const blocks = useMemo(() => {
    if (state.phase !== "loaded") return [];
    return stripLeadingTitle(parseLegalMarkdown(state.doc.content), state.doc.title);
  }, [state]);

  const followInternalLink = useCallback(
    (href: string) => {
      const next = legalSlugFromWebPath(href);
      if (next && next !== slug) {
        router.push(`/legal/${next}`);
        return;
      }
      // A root-relative link to something that is not a legal document (the
      // public Trust Center, a marketing page) has no native destination. It is
      // left inert rather than opening a browser: a legal reader that ejects the
      // user mid-document is the handoff this screen replaced.
    },
    [router, slug],
  );

  // T-14 — "On this page": the H2 index, and the offsets that let it scroll.
  const toc = useMemo(() => legalToc(blocks), [blocks]);
  const [tocOpen, setTocOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef({ card: 0, body: 0, sections: new Map<number, number>() });
  const jumpTo = (blockIndex: number) => {
    const y = offsets.current.card + offsets.current.body + (offsets.current.sections.get(blockIndex) ?? 0);
    scrollRef.current?.scrollTo?.({ y, animated: true });
  };

  return (
    <ProovraScreen testID="legal-document" scroll={false}>
      <ScrollView ref={scrollRef} contentContainerStyle={{ gap: theme.space.s4, paddingBottom: theme.space.s6 }}>
      <ProovraPageHeader
        title={state.phase === "loaded" ? state.doc.title : "Legal"}
        eyebrow="Legal"
        subtitle={
          state.phase === "loaded" && state.doc.lastUpdated
            ? `Last updated ${state.doc.lastUpdated}`
            : undefined
        }
        secondaryActions={
          <ProovraButton
            label="Back"
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        }
      />

      {state.phase === "loading" ? <ProovraLoadingState label="Loading document" /> : null}

      {state.phase === "failed" ? (
        <ProovraErrorState
          message="This document could not be loaded."
          onRetry={() => void load()}
        />
      ) : null}

      {state.phase === "missing" ? (
        <ProovraCard>
          <ProovraText variant="h3">No such document</ProovraText>
          <ProovraText variant="body" color={theme.color.ink.secondary}>
            {slug
              ? `There is no legal document called "${slug}".`
              : "No document was requested."}
          </ProovraText>
          <ProovraButton
            label="Browse legal documents"
            variant="secondary"
            onPress={() => router.replace("/legal")}
          />
        </ProovraCard>
      ) : null}

      {state.phase === "loaded" && toc.length > 0 ? (
        <ProovraCard testID="legal-toc">
          <ProovraText
            variant="label"
            weight="semibold"
            accessibilityRole="link"
            accessibilityLabel="On this page"
            onPress={() => setTocOpen((o) => !o)}
          >
            {`On this page ${tocOpen ? "▴" : "▾"}`}
          </ProovraText>
          {tocOpen
            ? toc.map((item) => (
                <ProovraText
                  key={item.blockIndex}
                  variant="bodySm"
                  color={theme.color.accent.a600}
                  accessibilityRole="link"
                  accessibilityLabel={`Go to ${item.title}`}
                  onPress={() => jumpTo(item.blockIndex)}
                >
                  {item.title}
                </ProovraText>
              ))
            : null}
        </ProovraCard>
      ) : null}

      {state.phase === "loaded" ? (
        <View onLayout={(e) => (offsets.current.card = e.nativeEvent.layout.y)}>
        <ProovraCard>
          {state.doc.acceptance ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Acceptance required at version ${state.doc.acceptance.requiredVersion}`}
            </ProovraText>
          ) : null}
          <View onLayout={(e) => (offsets.current.body = e.nativeEvent.layout.y)}>
            <LegalDocumentBody
              blocks={blocks}
              onInternalLink={followInternalLink}
              onSectionLayout={(i, y) => offsets.current.sections.set(i, y)}
            />
          </View>
        </ProovraCard>
        </View>
      ) : null}
      </ScrollView>
    </ProovraScreen>
  );
}
