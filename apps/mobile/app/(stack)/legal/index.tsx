/**
 * LEGAL CENTER — the index of the canonical legal corpus.
 *
 * The web reaches individual documents from footers, from Settings, and from
 * cross-references inside the documents themselves; it has no single index
 * page. A phone has no footer, so without an index the only reachable documents
 * would be the two Settings happens to link — which is how Terms and Privacy
 * came to be the only legal text the app could show.
 *
 * This is navigation, not content: every row's title and date come from
 * `GET /v1/legal`, and the list is whatever the corpus contains.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraListRow,
  ProovraPageHeader,
  ProovraLoadingState,
  ProovraErrorState,
} from "../../../src/ui";
import {
  buildLegalIndexPath,
  parseLegalIndex,
  type LegalDocumentSummary,
} from "../../../src/product/legal";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; documents: LegalDocumentSummary[] }
  | { phase: "failed" };

export default function LegalIndexScreen() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const data = await apiFetch(buildLegalIndexPath());
      setState({ phase: "loaded", documents: parseLegalIndex(data) });
    } catch {
      setState({ phase: "failed" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraScreen testID="legal-index">
      <ProovraPageHeader
        title="Legal"
        eyebrow="Legal"
        subtitle="The policies that govern this product, as published."
        secondaryActions={
          <ProovraButton
            label="Back"
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        }
      />

      {state.phase === "loading" ? <ProovraLoadingState label="Loading documents" /> : null}

      {state.phase === "failed" ? (
        <ProovraErrorState
          message="The legal documents could not be loaded."
          onRetry={() => void load()}
        />
      ) : null}

      {state.phase === "loaded" ? (
        <ProovraCard>
          {state.documents.map((doc) => (
            <ProovraListRow
              key={doc.slug}
              title={doc.title}
              subtitle={doc.lastUpdated ? `Last updated ${doc.lastUpdated}` : undefined}
              onPress={() => router.push(`/legal/${doc.slug}`)}
              trailing={
                doc.acceptance ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    Acceptance
                  </ProovraText>
                ) : undefined
              }
            />
          ))}
        </ProovraCard>
      ) : null}
    </ProovraScreen>
  );
}
