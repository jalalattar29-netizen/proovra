/**
 * The legal document's list and rule treatment, as the RENDERED web page
 * draws it (LEGAL_ARTICLE_TYPOGRAPHY, apps/web/components/legal/legalArticleStyles.ts:44-52):
 *   - unordered: a drawn 6×6 #2563EB dot at top 0.75rem, 24px indent — no "•" glyph;
 *   - ordered: a drawn 28×28 #F1F5F9 circle with a 1px #DDE6F2 ring and a
 *     centred 0.78rem semibold #0B1F4D number, 40px indent — no "1." glyph;
 *   - items: #475569 at 0.98rem / 1.78, 10px apart;
 *   - rule: a 1px gradient line (transparent → #DDE6F2 30%–70% → transparent), 32px above and below.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

const h = React.createElement;
let M;
before(async () => {
  M = await loadWithProviders("src/ui/legal-document.tsx");
});

const t = (text) => [{ kind: "text", text }];
const BLOCKS = [
  { kind: "ul", items: [t("Account data"), t("Evidence metadata")] },
  { kind: "hr" },
  { kind: "ol", items: [t("Request access"), t("Receive a copy"), t("Ask for deletion")] },
];

test("unordered items carry a drawn blue dot, not a bullet glyph", async () => {
  const r = await renderInProviders(M, h(M.LegalDocumentBody, { blocks: BLOCKS }));
  const dots = r.byTestId("legal-li-bullet");
  assert.equal(dots.length, 2);
  const dot = r.styleOf(dots[0]);
  assert.equal(dot.width, 6);
  assert.equal(dot.height, 6);
  assert.equal(dot.borderRadius, 3);
  assert.equal(dot.backgroundColor, "#2563EB");
  assert.equal(dot.position, "absolute");
  assert.equal(dot.top, 12);
  assert.equal(r.styleOf(r.byTestId("legal-ul")[0]).gap, 10);
  const items = r.byTestId("legal-li");
  assert.equal(r.styleOf(items[0]).paddingLeft, 24);
  assert.ok(!r.texts().some((s) => s.includes("•")), "a typed bullet glyph remains");
  r.unmount();
});

test("ordered items carry a drawn numbered circle, not a '1.' glyph", async () => {
  const r = await renderInProviders(M, h(M.LegalDocumentBody, { blocks: BLOCKS }));
  const marks = r.byTestId("legal-li-number");
  assert.equal(marks.length, 3);
  const m = r.styleOf(marks[0]);
  assert.equal(m.width, 28);
  assert.equal(m.height, 28);
  assert.equal(m.borderWidth, 1);
  assert.equal(m.borderColor, "#DDE6F2");
  assert.equal(m.backgroundColor, "#F1F5F9");
  assert.equal(m.alignItems, "center");
  assert.equal(m.justifyContent, "center");
  assert.equal(m.top, 2.4);
  const num = marks[1].findAll((n) => n.type === "Text")[0];
  assert.equal(num.props.children, "2");
  const numStyle = r.styleOf(num);
  assert.equal(numStyle.color, "#0B1F4D");
  assert.equal(numStyle.fontSize, 12.48);
  const olItem = r.byTestId("legal-li")[2];
  assert.equal(r.styleOf(olItem).paddingLeft, 40);
  assert.ok(!r.texts().some((s) => /^\d+\.$/.test(s.trim())), "a typed '1.' marker remains");
  r.unmount();
});

test("item text is the web's #475569 at 0.98rem / 1.78", async () => {
  const r = await renderInProviders(M, h(M.LegalDocumentBody, { blocks: BLOCKS }));
  const item = r.byTestId("legal-li")[0];
  const text = item.findAll((n) => n.type === "Text").find((n) => r.styleOf(n).fontSize === 15.68);
  assert.ok(text, "no list text at 15.68px");
  const st = r.styleOf(text);
  assert.equal(st.lineHeight, 27.9);
  assert.equal(st.color, "#475569");
  r.unmount();
});

test("a horizontal rule is a 1px fading gradient with 32px margins", async () => {
  const r = await renderInProviders(M, h(M.LegalDocumentBody, { blocks: BLOCKS }));
  const hr = r.byTestId("legal-hr")[0];
  assert.ok(hr, "no gradient rule");
  assert.equal(hr.type, "LinearGradient");
  assert.deepEqual(hr.props.colors, ["rgba(221, 230, 242, 0)", "#DDE6F2", "#DDE6F2", "rgba(221, 230, 242, 0)"]);
  assert.deepEqual(hr.props.locations, [0, 0.3, 0.7, 1]);
  const st = r.styleOf(hr);
  assert.equal(st.height, 1);
  assert.equal(st.marginVertical, 32);
  r.unmount();
});
