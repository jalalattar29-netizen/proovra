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
import { Linking, View, type TextStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { ProovraText } from "./index";
import { theme } from "../theme/theme";
import type { LegalBlock, LegalInline } from "../product/legal";

type TextVariantish = "h1" | "h2" | "h3" | "body" | "bodySm" | "label";

function Spans({
  spans,
  variant = "body",
  color,
  onInternalLink,
  style,
}: {
  spans: LegalInline[];
  variant?: TextVariantish;
  color?: string;
  onInternalLink?: (href: string) => void;
  /** Size/leading for the whole run — nested Text would otherwise reset it to the variant's. */
  style?: TextStyle;
}) {
  return (
    <ProovraText variant={variant} color={color} style={style}>
      {spans.map((span, i) => {
        if (span.kind === "bold") {
          return (
            <ProovraText key={i} variant={variant} weight="semibold" color={color} style={style}>
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
              style={[style, { fontStyle: "italic" }]}
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
              style={[style, { textDecorationLine: "underline" }]}
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
          <ProovraText key={i} variant={variant} color={color} style={style}>
            {span.text}
          </ProovraText>
        );
      })}
    </ProovraText>
  );
}

/**
 * The web document typography — LEGAL_ARTICLE_TYPOGRAPHY in
 * apps/web/components/legal/legalArticleStyles.ts:44-52, as measured on the
 * rendered page. The two values with no theme token (#DDE6F2 for the rule and
 * the number ring, #0B1F4D for the number) are the web's literals.
 */
const LEGAL_LIST = {
  /** `[&_ul]:grid gap-2.5` */
  gap: 10,
  /** `[&_li]:text-[0.98rem] leading-[1.78] text-[#475569]` */
  itemText: { fontSize: 15.68, lineHeight: 27.9 } as TextStyle,
  itemColor: theme.color.ink.secondary,
  /** `[&_li]:pl-6` / `[&_ol>li]:pl-10` */
  indentUl: 24,
  indentOl: 40,
  /** `[&_ul>li::before]` — 6×6 filled circle, #2563EB, top 0.75rem. */
  bullet: {
    position: "absolute",
    left: 0,
    top: 12,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.color.semantic.info,
  } as const,
  /** `[&_ol>li::before]` — 28×28 circle, #F1F5F9 fill, 1px #DDE6F2 ring, top 0.15rem. */
  number: {
    position: "absolute",
    left: 0,
    top: 2.4,
    width: 28,
    height: 28,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: "#DDE6F2",
    backgroundColor: theme.color.status.neutral.bg,
    alignItems: "center",
    justifyContent: "center",
  } as const,
  /** 0.78rem semibold #0B1F4D */
  numberText: { fontSize: 12.48, lineHeight: 16 } as TextStyle,
  numberInk: "#0B1F4D",
} as const;

/** `[&_hr]:my-8 border-0 h-px bg-[linear-gradient(90deg,transparent_0%,#DDE6F2_30%,#DDE6F2_70%,transparent_100%)]` */
const LEGAL_RULE = {
  colors: ["rgba(221, 230, 242, 0)", "#DDE6F2", "#DDE6F2", "rgba(221, 230, 242, 0)"] as const,
  locations: [0, 0.3, 0.7, 1] as const,
  marginVertical: 32,
};

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
    <View style={{ gap: LEGAL_LIST.gap }} testID={ordered ? "legal-ol" : "legal-ul"}>
      {items.map((spans, i) => (
        <View
          key={i}
          style={{ position: "relative", paddingLeft: ordered ? LEGAL_LIST.indentOl : LEGAL_LIST.indentUl }}
          testID="legal-li"
        >
          {/* The marker is DRAWN, as the web's ::before is — never a typed "•" or "1." glyph. */}
          {ordered ? (
            <View style={LEGAL_LIST.number} testID="legal-li-number">
              <ProovraText variant="label" weight="semibold" color={LEGAL_LIST.numberInk} style={LEGAL_LIST.numberText}>
                {String(i + 1)}
              </ProovraText>
            </View>
          ) : (
            <View style={LEGAL_LIST.bullet} testID="legal-li-bullet" />
          )}
          <Spans spans={spans} color={LEGAL_LIST.itemColor} style={LEGAL_LIST.itemText} onInternalLink={onInternalLink} />
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
  onSectionLayout,
}: {
  blocks: LegalBlock[];
  onInternalLink?: (href: string) => void;
  /** Reports each H2's y within the body, so a section index can scroll to it. */
  onSectionLayout?: (blockIndex: number, y: number) => void;
}) {
  return (
    <View style={{ gap: theme.space.s4 }} testID="legal-document-body">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h1":
            return <Spans key={i} spans={block.spans} variant="h1" />;
          case "h2":
            return (
              <View key={i} style={{ marginTop: theme.space.s2 }} onLayout={onSectionLayout ? (e) => onSectionLayout(i, e.nativeEvent.layout.y) : undefined}>
                <Spans spans={block.spans} variant="h2" />
              </View>
            );
          case "h3":
            return <Spans key={i} spans={block.spans} variant="h3" />;
          case "hr":
            return (
              <LinearGradient
                key={i}
                colors={[...LEGAL_RULE.colors]}
                locations={[...LEGAL_RULE.locations]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{ height: 1, marginVertical: LEGAL_RULE.marginVertical }}
                testID="legal-hr"
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
