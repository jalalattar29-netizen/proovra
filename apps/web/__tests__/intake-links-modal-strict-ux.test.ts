/**
 * /intake-links page + New Intake Link modal — strict UX pins.
 *
 * After the operations-console rewrite, three UX issues remained:
 *   1. The "Workspace › Intake links" breadcrumb above the H1 was
 *      visual clutter that duplicated the page title and pushed the
 *      primary CTA below the fold on narrow viewports.
 *   2. The native <select> controls in the New Intake Link modal
 *      rendered with browser-default chrome (OS chevron, square
 *      corners, mismatched height vs. inputs).
 *   3. The default delivery method was MANUAL (Copy link only),
 *      which buried the actual messaging channels behind an extra
 *      click for the most common case.
 *
 * Pins lock the strict UX so a future refactor can't quietly
 * regress any of them.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/intake-links/page.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — /intake-links breadcrumb removed", () => {
  it("page.tsx does not render the OperationalBreadcrumb component", () => {
    const src = read(PAGE);
    assert.ok(
      !/<OperationalBreadcrumb\b/.test(src),
      "<OperationalBreadcrumb …/> must not appear in /intake-links page",
    );
  });

  it("the OperationalBreadcrumb import is gone (no stale dead import)", () => {
    const src = read(PAGE);
    assert.ok(
      !/import\s*\{\s*OperationalBreadcrumb\s*\}\s*from/.test(src),
      "Stale OperationalBreadcrumb import must be removed",
    );
  });

  it("the H1 + subtitle are still the first content inside <main>", () => {
    const src = read(PAGE);
    // The page should start with `<main style={pageStyle}>` then the header
    // row containing the H1 "External Intake Links". The canonical Cases/Home
    // migration inserts a premium icon surface (42×42 gradient + link SVG)
    // ahead of the H1, so the window allows for that header chrome — but the
    // H1 must still be the first textual content (no breadcrumb above it; the
    // breadcrumb-removal invariant is pinned by the tests above).
    assert.match(
      src,
      /<main style=\{pageStyle\}>[\s\S]{0,2400}<h1 style=\{titleStyle\}>External Intake Links<\/h1>/,
    );
  });
});

describe("Pin 2 — modal selects use the enterprise styled wrapper, not browser default", () => {
  it("a dedicated modalSelectStyle constant exists with the prescribed visual tokens", () => {
    const src = read(PAGE);
    assert.match(src, /const modalSelectStyle: React\.CSSProperties = \{/);
    // The strict-UX brief explicitly asks for: same height as
    // inputs (10/14px padding), rounded 10-12px corners, white bg,
    // subtle border, no OS-native appearance, custom chevron.
    assert.match(src, /appearance:\s*"none"/);
    assert.match(src, /WebkitAppearance:\s*"none"/);
    assert.match(src, /borderRadius:\s*1[02]/);
    assert.match(src, /backgroundImage:\s*`url\("\$\{SELECT_CHEVRON_SVG\}"\)`/);
  });

  it("every <select> inside the New Intake Link modal uses modalSelectStyle (no leftover inputStyle selects)", () => {
    const src = read(PAGE);
    const modalStart = src.indexOf("function CreateLinkModal");
    const modalEnd = src.indexOf("function RawTokenRevealModal");
    assert.ok(modalStart > 0 && modalEnd > modalStart);
    const modalBody = src.slice(modalStart, modalEnd);
    // Count opening <select tags in the modal — must be exactly 3
    // (request type, intake mode, delivery method).
    const selectCount = (modalBody.match(/<select\b/g) ?? []).length;
    assert.equal(
      selectCount,
      3,
      `expected exactly 3 <select> in CreateLinkModal, found ${selectCount}`,
    );
    // Every one must declare style={modalSelectStyle} — no leftover
    // style={inputStyle} on a select inside this modal.
    const modalStyleCount = (
      modalBody.match(/style=\{modalSelectStyle\}/g) ?? []
    ).length;
    assert.equal(
      modalStyleCount,
      3,
      `expected 3 style={modalSelectStyle} occurrences, found ${modalStyleCount}`,
    );
    assert.ok(
      !/<select[\s\S]{0,200}style=\{inputStyle\}/.test(modalBody),
      "no <select> in the modal may still use style={inputStyle}",
    );
    // Data-attr targets the styled wrapper from e2e tests. We
    // count only occurrences inside an opening tag (not the
    // matching CSS selector in the scoped <style> sheet at the top
    // of the modal). The pattern `\n          data-intake-link-
    // modal-select\n` (i.e. on its own indented line) only
    // appears for actual tag attributes.
    const tagAttrMatches =
      modalBody.match(/^\s*data-intake-link-modal-select\s*$/gm) ?? [];
    assert.equal(
      tagAttrMatches.length,
      3,
      `expected 3 data-intake-link-modal-select tag attrs, found ${tagAttrMatches.length}`,
    );
  });

  it("focus-visible + hover + disabled styling is injected as a scoped <style> in the modal", () => {
    const src = read(PAGE);
    // CSS-in-JS can't express :focus-visible — the modal injects a
    // scoped <style> tag. Pin its existence + the three selectors.
    assert.match(
      src,
      /select\[data-intake-link-modal-select\]:focus-visible/,
    );
    assert.match(src, /select\[data-intake-link-modal-select\]:hover/);
    assert.match(src, /select\[data-intake-link-modal-select\]:disabled/);
  });
});

describe("Pin 3 — modal default delivery method = SMS (not MANUAL)", () => {
  it('useState initial value for deliveryMethod is "SMS"', () => {
    const src = read(PAGE);
    assert.match(
      src,
      /useState<DeliveryMethod>\("SMS"\)/,
    );
    // And NOT the old MANUAL default.
    assert.ok(
      !/useState<DeliveryMethod>\(\s*"MANUAL"\s*\)/.test(src),
      'deliveryMethod must NOT default to "MANUAL" anymore',
    );
  });

  it("Copy link (MANUAL) remains in the DELIVERY_METHODS catalog (still available, just not default)", () => {
    const src = read(PAGE);
    // Strict-UX brief shortened "Copy link only" → "Copy link".
    assert.match(src, /value:\s*"MANUAL"[\s\S]{0,200}label:\s*"Copy link"/);
  });
});

describe("Pin 4 — config-aware delivery-method fallback (SMS → Email → WhatsApp → Manual)", () => {
  it("a useEffect downgrades the default when senderTransport reports SMS unconfigured", () => {
    const src = read(PAGE);
    // The fallback effect must read senderTransport.sms.configured
    // and pick the next-best channel in the documented priority order.
    assert.match(src, /const smsOk = senderTransport\.sms\.configured/);
    assert.match(src, /const emailOk = senderTransport\.email\.configured/);
    assert.match(
      src,
      /const next: DeliveryMethod = smsOk\s*\n?\s*\?\s*"SMS"\s*\n?\s*:\s*emailOk\s*\n?\s*\?\s*"EMAIL"\s*\n?\s*:\s*waReady\s*\n?\s*\?\s*"WHATSAPP"\s*\n?\s*:\s*"MANUAL"/,
    );
  });

  it("the fallback is suppressed once the user has explicitly chosen a channel (deliveryMethodTouched gate)", () => {
    const src = read(PAGE);
    // The touched flag prevents the fallback from clobbering an
    // explicit operator click after senderTransport refetches.
    assert.match(src, /const \[deliveryMethodTouched, setDeliveryMethodTouched\] = useState\(false\)/);
    assert.match(src, /if \(deliveryMethodTouched\) return/);
    assert.match(src, /setDeliveryMethodTouched\(true\)/);
  });

  it("WhatsApp is never auto-selected unless the configured signal is true (template SID gates this server-side)", () => {
    const src = read(PAGE);
    // The fallback chain places WhatsApp AFTER Email, and only
    // when waReady (= senderTransport.whatsapp.configured) is true.
    // The /sender-identity endpoint already requires the Content
    // Template SID before reporting configured=true, so a missing
    // template can never produce a WhatsApp default.
    assert.match(src, /const waReady = senderTransport\.whatsapp\.configured/);
  });
});

describe("Pin 5 — phone field is visible immediately because SMS is default", () => {
  it("the SMS branch in DELIVERY_METHODS still references the SMS channel in helper copy", () => {
    const src = read(PAGE);
    // Strict-UX brief shortened the SMS description. The operator
    // still sees a one-line description under the dropdown when
    // SMS is selected.
    assert.match(
      src,
      /value:\s*"SMS"[\s\S]{0,200}PROOVRA sends the secure upload link by text message/,
    );
  });

  it("the phone input still renders for SMS / WHATSAPP delivery methods (gate preserved)", () => {
    const src = read(PAGE);
    // Existing gate: when method is SMS or WHATSAPP the phone
    // input is rendered. The strict-UX change MUST NOT remove
    // this conditional — it's what makes the SMS-default useful.
    assert.match(
      src,
      /deliveryMethod === "SMS" \|\| deliveryMethod === "WHATSAPP"/,
    );
  });
});

describe("Pin 7 — INTAKE_MODES labels are short; explanation is helper text", () => {
  it("dropdown option labels are the short forms (no dashes / parentheses)", () => {
    const src = read(PAGE);
    // The 4 short labels prescribed by the brief.
    assert.match(src, /value:\s*"EXTERNAL_ONE_TIME",\s*label:\s*"One-time link"/);
    assert.match(src, /value:\s*"EXTERNAL_REUSABLE",\s*label:\s*"Reusable link"/);
    assert.match(src, /value:\s*"EXTERNAL_ANONYMOUS",\s*label:\s*"Anonymous"/);
    assert.match(src, /value:\s*"EXTERNAL_PSEUDONYMOUS",\s*label:\s*"Display name"/);
    // The old verbose forms must be gone — no parentheses, no
    // em-dashes inside the labels.
    assert.ok(
      !/single contributor, single submission/.test(src),
      'old "single contributor, single submission" copy must be removed',
    );
    assert.ok(
      !/multiple submissions\)/.test(src),
      'old "multiple submissions)" parenthetical must be removed',
    );
    assert.ok(
      !/Anonymous — no identity recorded/.test(src),
      "old em-dash anonymous label must be removed",
    );
    assert.ok(
      !/Alias — contributor chooses a name to display/.test(src),
      "old em-dash alias label must be removed",
    );
  });

  it("INTAKE_MODE_HELPER_TEXT supplies the 4 prescribed sentences", () => {
    const src = read(PAGE);
    assert.match(src, /EXTERNAL_ONE_TIME:\s*"Best for one recipient and one submission\."/);
    assert.match(
      src,
      /EXTERNAL_REUSABLE:[\s\S]{0,80}"Use when several people may submit files through the same link\."/,
    );
    assert.match(src, /EXTERNAL_ANONYMOUS:\s*"No contributor identity is requested\."/);
    assert.match(
      src,
      /EXTERNAL_PSEUDONYMOUS:[\s\S]{0,80}"Contributor chooses a name shown with the submission\."/,
    );
  });

  it("the modal renders the helper text under the Intake mode select", () => {
    const src = read(PAGE);
    assert.match(src, /data-intake-link-intake-mode-helper/);
    assert.match(src, /INTAKE_MODE_HELPER_TEXT\[intakeMode\]/);
  });
});

describe("Pin 8 — DELIVERY_METHODS labels + descriptions follow strict-UX brief", () => {
  it("each method has the short label prescribed by the brief", () => {
    const src = read(PAGE);
    assert.match(src, /value:\s*"MANUAL",\s*\n?\s*label:\s*"Copy link"/);
    assert.match(src, /value:\s*"SMS",\s*\n?\s*label:\s*"Send by SMS"/);
    assert.match(src, /value:\s*"EMAIL",\s*\n?\s*label:\s*"Send by email"/);
    assert.match(src, /value:\s*"WHATSAPP",\s*\n?\s*label:\s*"Send by WhatsApp"/);
  });

  it("descriptions are the one-line strings the brief specified", () => {
    const src = read(PAGE);
    assert.match(src, /"Create a link and share it yourself\."/);
    assert.match(src, /"PROOVRA sends the secure upload link by text message\."/);
    assert.match(src, /"PROOVRA sends a secure request email\."/);
    assert.match(src, /"PROOVRA sends the approved WhatsApp request template\."/);
  });
});

describe("Pin 9 — Sender identity is card-style with title + description, no inline 'for example'", () => {
  it("renders a card-style options array (PROOVRA / Workspace name / Custom name)", () => {
    const src = read(PAGE);
    // options[] is the single source of truth for the radio cards.
    assert.match(src, /title:\s*"PROOVRA"/);
    assert.match(
      src,
      /title:\s*"Workspace name"[\s\S]{0,200}description:\s*"Uses the current workspace name with PROOVRA\."/,
    );
    assert.match(
      src,
      /title:\s*"Custom name"[\s\S]{0,200}description:\s*"Show a company, case, or sender name\."/,
    );
  });

  it("each card carries a data-intake-link-sender-card attr (e2e-stable)", () => {
    const src = read(PAGE);
    assert.match(src, /data-intake-link-sender-card=\{opt\.value\}/);
    assert.match(src, /data-intake-link-sender-card-selected=/);
  });

  it("no card text contains 'for example' or the old em-dash inline copy", () => {
    const src = read(PAGE);
    // The options[] array is the only source of card text; pin
    // that none of its title/description strings contain the
    // banned inline copy.
    const optionsStart = src.indexOf("const options:");
    const optionsEnd = src.indexOf("];", optionsStart);
    assert.ok(optionsStart > 0 && optionsEnd > optionsStart);
    const optionsLiteral = src.slice(optionsStart, optionsEnd);
    assert.ok(
      !/for example/i.test(optionsLiteral),
      'card options must NOT contain "for example" copy',
    );
    assert.ok(
      !/Custom display name via PROOVRA/.test(optionsLiteral),
      "old ugly 'Custom display name via PROOVRA' label must be removed",
    );
    assert.ok(
      !/PROOVRA secure intake/.test(optionsLiteral),
      "old 'PROOVRA secure intake' verbose title must be removed",
    );
  });

  it("Custom name input appears only when mode === CUSTOM and renders the prescribed labels/placeholder/helper", () => {
    const src = read(PAGE);
    assert.match(src, /mode === "CUSTOM" \? \(/);
    assert.match(src, /htmlFor="intake-link-display-name"/);
    // Label text is on its own line between tags.
    assert.match(src, />\s*Display name\s*<\/label>/);
    assert.match(src, /placeholder="Smith & Partners"/);
    assert.match(
      src,
      /This name appears in the request message before [\s\S]{0,40}via\s*\n?\s*PROOVRA/,
    );
  });
});

describe("Pin 10 — card-style radio tokens render stacked, not cramped", () => {
  it("dedicated card style constants exist (12px radius, subtle border, selected ring)", () => {
    const src = read(PAGE);
    assert.match(src, /const senderCardStyle: React\.CSSProperties = \{/);
    assert.match(src, /borderRadius:\s*12/);
    assert.match(src, /const senderCardSelectedStyle: React\.CSSProperties = \{/);
    assert.match(src, /borderColor:\s*"#4f46e5"/);
    // Stacked, not inline.
    assert.match(src, /const senderCardListStyle: React\.CSSProperties = \{/);
    assert.match(src, /flexDirection:\s*"column"/);
  });

  it("the legacy senderRadioRowStyle is gone (replaced by card tokens)", () => {
    const src = read(PAGE);
    assert.ok(
      !/const senderRadioRowStyle:/.test(src),
      "legacy senderRadioRowStyle must be removed",
    );
  });
});

describe("Pin 6 — no backend behavior changed", () => {
  it("the API endpoint string remains /v1/workflow/intake-links (unchanged)", () => {
    const src = read(PAGE);
    assert.match(src, /\/v1\/workflow\/intake-links/);
  });

  it("the create-modal still POSTs deliveryMethod + intakeUrlBase to the backend (no shape change)", () => {
    const src = read(PAGE);
    assert.match(src, /intakeUrlBase: deliveryMethod === "MANUAL" \? undefined : intakeUrlBase/);
  });
});
