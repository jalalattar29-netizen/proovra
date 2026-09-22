/**
 * LEGAL DOCUMENT RENDERER — platform presentation for canonical legal markdown.
 *
 * The content, the titles, the slugs and the dates all come from
 * `GET /v1/legal/:slug`. This file owns nothing but how those blocks look on a
 * phone, which is the one thing native is allowed to own.
 *
 * It is the counterpart of `renderLegalMarkdown` in
 * `apps/web/app/legal/legal-content.tsx` — same block vocabulary, different
 * output primitives, because the web renderer emits DOM elements. The web's
 * `enhance` pass (provider panels, contact rows, chip rows) is deliberately NOT
 * reproduced: it is a desktop reading affordance, and inventing a native
 * equivalent would be a second presentation policy for the same corpus.
 */
import { Linking, View } from "react-native";
import { ProovraText } from "./index";
import { theme } from "../theme/theme";
import type { LegalBlock, LegalInline } from "../product/legal";

type TextVariantish = "h1" | "h2" | "h3" | "body" | "bodySm" | "label";

function Spans({
  spans,
  variant = "body",
  color,
  onInternalLink,
}: {
  spans: LegalInline[];
  variant?: TextVariantish;
  color?: string;
  onInternalLink?: (href: string) => void;
}) {
  return (
    <ProovraText variant={variant} color={color}>
      {spans.map((span, i) => {
        if (span.kind === "bold") {
          return (
            <ProovraText key={i} variant={variant} weight="semibold" color={color}>
              {span.text}
            </ProovraText>
          );
        }

        if (span.kind === "italic") {
          return (
            <ProovraText
              key={i}
              variant={variant}
              color={color}
              style={{ fontStyle: "italic" }}
            >
              {span.text}
            </ProovraText>
          );
        }

        if (span.kind === "link") {
          return (
            <ProovraText
              key={i}
              variant={variant}
              weight="semibold"
              color={theme.color.accent.standard}
              style={{ textDecorationLine: "underline" }}
              accessibilityLabel={
                span.external ? `${span.text} (opens outside the app)` : span.text
              }
              // `onPress` on a nested Text is how RN gives a link inside a
              // paragraph a tap target without breaking the text flow.
              onPress={() => {
                if (span.external) {
                  void Linking.openURL(span.href);
                  return;
                }
                onInternalLink?.(span.href);
              }}
            >
              {span.text}
            </ProovraText>
          );
        }

        return (
          <ProovraText key={i} variant={variant} color={color}>
            {span.text}
          </ProovraText>
        );
      })}
    </ProovraText>
  );
}

function ListBlock({
  items,
  ordered,
  onInternalLink,
}: {
  items: LegalInline[][];
  ordered: boolean;
  onInternalLink?: (href: string) => void;
}) {
  return (
    <View style={{ gap: theme.space.s1 }}>
      {items.map((spans, i) => (
        <View
          key={i}
          style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "flex-start" }}
        >
          <ProovraText variant="body" color={theme.color.ink.muted}>
            {ordered ? `${i + 1}.` : "•"}
          </ProovraText>
          <View style={{ flex: 1 }}>
            <Spans spans={spans} onInternalLink={onInternalLink} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A pipe table on a phone.
 *
 * Rendered as one labelled group per row rather than a horizontally scrolling
 * grid: a legal table's columns are short labels against prose, and a table a
 * reader has to scroll sideways to finish is a table they stop reading.
 */
function TableBlock({
  headers,
  rows,
  onInternalLink,
}: {
  headers: LegalInline[][];
  rows: LegalInline[][][];
  onInternalLink?: (href: string) => void;
}) {
  return (
    <View style={{ gap: theme.space.s2 }}>
      {rows.map((row, ri) => (
        <View
          key={ri}
          style={{
            borderWidth: 1,
            borderColor: theme.color.border.subtle,
            borderRadius: theme.radius.md,
            backgroundColor: theme.color.surface.muted,
            padding: theme.space.s4,
            gap: theme.space.s1,
          }}
        >
          {row.map((cell, ci) => (
            <View key={ci} style={{ gap: 2 }}>
              <Spans
                spans={headers[ci] ?? [{ kind: "text", text: "" }]}
                variant="label"
                color={theme.color.ink.muted}
              />
              <Spans spans={cell} variant="bodySm" onInternalLink={onInternalLink} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function LegalDocumentBody({
  blocks,
  onInternalLink,
}: {
  blocks: LegalBlock[];
  onInternalLink?: (href: string) => void;
}) {
  return (
    <View style={{ gap: theme.space.s4 }} testID="legal-document-body">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h1":
            return <Spans key={i} spans={block.spans} variant="h1" />;
          case "h2":
            return (
              <View key={i} style={{ marginTop: theme.space.s2 }}>
                <Spans spans={block.spans} variant="h2" />
              </View>
            );
          case "h3":
            return <Spans key={i} spans={block.spans} variant="h3" />;
          case "hr":
            return (
              <View
                key={i}
                style={{
                  height: 1,
                  backgroundColor: theme.color.border.subtle,
                  marginVertical: theme.space.s1,
                }}
              />
            );
          case "ul":
          case "ol":
            return (
              <ListBlock
                key={i}
                items={block.items}
                ordered={block.kind === "ol"}
                onInternalLink={onInternalLink}
              />
            );
          case "table":
            return (
              <TableBlock
                key={i}
                headers={block.headers}
                rows={block.rows}
                onInternalLink={onInternalLink}
              />
            );
          default:
            return (
              <Spans
                key={i}
                spans={block.spans}
                color={theme.color.ink.secondary}
                onInternalLink={onInternalLink}
              />
            );
        }
      })}
    </View>
  );
}
