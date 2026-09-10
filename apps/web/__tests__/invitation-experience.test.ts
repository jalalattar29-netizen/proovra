/**
 * THE PUBLIC INVITATION STATE MATRIX.
 *
 * `resolveInvitationView` is the one render authority for `/invite/[token]`,
 * so every state in the journey is reachable here without a browser, a server
 * or a token. That is the point of having extracted it: the page it replaced
 * decided what to show inside a `useEffect` that had already accepted the
 * invitation, which made most of these states untestable and two of them
 * unreachable.
 *
 * The file also pins the things a redesign can silently undo — that the page
 * does not mutate on arrival, that no legacy green survives, that the shell
 * matches the auth pages, and that the sign-in and register continuations use
 * the parameter each of those pages actually reads.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveInvitationView,
  type InvitationAcceptOutcome,
  type InvitationAuthState,
  type InvitationLookupOutcome,
} from "../lib/invitations/resolveInvitationView";
import {
  WORKSPACE_INVITATION_REFUSAL_CODES,
  isWellFormedWorkspaceInviteToken,
  maskInvitedEmail,
  type WorkspaceInvitationContext,
} from "@proovra/shared";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

/**
 * COMMENTS ARE NOT CODE, and this file learned it the hard way.
 *
 * Every correction in this change is explained at its site, and those
 * explanations NAME what was removed — the retired `site-velvet-bg` token, the
 * old `message.includes("already accepted")` chain, `EnterpriseFooter`,
 * `textAlign: "left"`. A test that searches raw source therefore finds the
 * retired thing in the prose recording its retirement and fails on a correct
 * file. Six of these did exactly that on their first run.
 *
 * So every absence assertion below reads a comment-stripped source. This is
 * the same discipline `settings-billing-canonical-actions.test.ts` applies to
 * CSS ("prose explaining a retired rule is not a rule").
 */
const stripTs = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const stripCss = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

const PAGE_RAW = read("app/invite/[token]/page.tsx");
const CSS_RAW = read("app/invite/invite.css");
const PAGE = stripTs(PAGE_RAW);
const CSS = stripCss(CSS_RAW);
const RESOLVER = stripTs(read("lib/invitations/resolveInvitationView.ts"));

/** A shape-valid token, so the resolver reaches the lookup arms. */
const TOKEN = `wsit_v1_${"a".repeat(43)}`;

const CONTEXT: WorkspaceInvitationContext = {
  workspaceName: "Northgate Investigations",
  organizationName: "Northgate Group",
  role: "MEMBER",
  invitedEmailMasked: "j••••@northgate.example",
  expiresAtUtc: "2026-09-20T10:00:00.000Z",
};

const SIGNED_OUT: InvitationAuthState = { kind: "signed-out" };
const SIGNED_IN: InvitationAuthState = {
  kind: "signed-in",
  email: "someone@example.com",
};
const IDLE: InvitationAcceptOutcome = { kind: "idle" };
const pendingLookup: InvitationLookupOutcome = { kind: "pending" };
const live: InvitationLookupOutcome = {
  kind: "resolved",
  lookup: { state: "PENDING", context: CONTEXT },
};

const at = (over: {
  token?: string;
  auth?: InvitationAuthState;
  lookup?: InvitationLookupOutcome;
  accept?: InvitationAcceptOutcome;
}) =>
  resolveInvitationView({
    token: over.token ?? TOKEN,
    auth: over.auth ?? SIGNED_OUT,
    lookup: over.lookup ?? live,
    accept: over.accept ?? IDLE,
  });

// ===========================================================================
// 1. THE MATRIX — one render state per thing that is actually true
// ===========================================================================

test("1. loading — a pending lookup is never a verdict", () => {
  const v = at({ lookup: pendingLookup });
  assert.equal(v.kind, "loading");
  // The defect this replaces: the old page could paint "this invitation is no
  // longer valid" before the request had answered.
  assert.deepEqual(v.actions, []);
  assert.equal(v.context, null);
});

test("1b. loading — auth still resolving does not flash a sign-in prompt", () => {
  const v = at({ auth: { kind: "resolving" } });
  assert.equal(v.kind, "loading");
  assert.deepEqual(v.actions, []);
});

test("2. valid + signed out — sign in, create account, and the context", () => {
  const v = at({ auth: SIGNED_OUT });
  assert.equal(v.kind, "ready-signed-out");
  assert.deepEqual(v.actions, ["sign-in", "create-account"]);
  assert.equal(v.context?.workspaceName, "Northgate Investigations");
  // No Accept before there is an identity to bind it to.
  assert.ok(!v.actions.includes("accept"));
});

test("3. valid + signed in — Accept is offered, and it is the primary", () => {
  const v = at({ auth: SIGNED_IN });
  assert.equal(v.kind, "ready-signed-in");
  assert.deepEqual(v.actions, ["accept"]);
  assert.equal(v.context?.role, "MEMBER");
});

test("4. wrong account — the invitation is VALID, only the session is wrong", () => {
  const v = at({
    auth: SIGNED_IN,
    accept: { kind: "refused", code: "INVITE_EMAIL_MISMATCH" },
  });
  assert.equal(v.kind, "wrong-account");
  // NOT "no longer valid" — the distinction the brief calls out explicitly.
  assert.notEqual(v.kind, "unknown");
  assert.notEqual(v.kind, "expired");
  assert.ok(v.actions.includes("switch-account"));
  assert.ok(!v.actions.includes("accept"));
});

test("5. already a member — a success, and no second mutation", () => {
  const v = at({
    auth: SIGNED_IN,
    accept: { kind: "accepted", alreadyMember: true, destination: "/home" },
  });
  assert.equal(v.kind, "already-member");
  assert.equal(v.tone, "success");
  assert.deepEqual(v.actions, ["open-workspace"]);
  assert.ok(!v.actions.includes("accept"));
});

test("6. accept in progress — no actions at all while it is in flight", () => {
  const v = at({ auth: SIGNED_IN, accept: { kind: "submitting" } });
  assert.equal(v.kind, "accepting");
  // Nothing to press twice.
  assert.deepEqual(v.actions, []);
});

test("7. accepted — success is violet, and it leads somewhere", () => {
  const v = at({
    auth: SIGNED_IN,
    accept: { kind: "accepted", alreadyMember: false, destination: "/home" },
  });
  assert.equal(v.kind, "accepted");
  assert.equal(v.tone, "success");
  assert.equal(v.destination, "/home");
  // Not a dead success card.
  assert.deepEqual(v.actions, ["open-workspace"]);
});

test("8. expired — its own state, distinct from invalid", () => {
  const v = at({
    lookup: { kind: "resolved", lookup: { state: "EXPIRED", context: null } },
  });
  assert.equal(v.kind, "expired");
  assert.notEqual(v.kind, "unknown");
  assert.ok(!v.actions.includes("accept"));
  // A terminal state does not re-name the workspace.
  assert.equal(v.context, null);
});

test("9. revoked — distinct from expired", () => {
  const v = at({
    lookup: { kind: "resolved", lookup: { state: "REVOKED", context: null } },
  });
  assert.equal(v.kind, "revoked");
  assert.notEqual(v.kind, "expired");
  assert.ok(!v.actions.includes("accept"));
});

test("10. already used, signed out — no membership claim is made", () => {
  const v = at({
    auth: SIGNED_OUT,
    lookup: { kind: "resolved", lookup: { state: "ACCEPTED", context: null } },
  });
  assert.equal(v.kind, "already-used");
  // The unauthenticated lookup cannot know who accepted it, so it must not
  // say "you are already a member".
  assert.ok(!v.actions.includes("open-workspace"));
});

test("10b. already used, signed in — Accept lets the SERVER decide who they are", () => {
  const v = at({
    auth: SIGNED_IN,
    lookup: { kind: "resolved", lookup: { state: "ACCEPTED", context: null } },
  });
  assert.equal(v.kind, "already-used");
  // The server answers `alreadyMember` for the accepter and
  // INVITE_ALREADY_USED / INVITE_EMAIL_MISMATCH for anybody else, so the
  // membership fact stays on the side that can prove it.
  assert.ok(v.actions.includes("accept"));
});

test("11. malformed token — opaque, and no request is implied", () => {
  const v = at({ token: "not-a-token", lookup: pendingLookup });
  assert.equal(v.kind, "unknown");
  // Reached WITHOUT the lookup having resolved: the page never sends it.
  assert.equal(v.context, null);
});

test("12. unknown token — the same opaque state as malformed", () => {
  const malformed = at({ token: "%%%", lookup: pendingLookup });
  const unknown = at({ lookup: { kind: "not-available" } });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.kind, malformed.kind);
  // Indistinguishable: same actions, same absent context.
  assert.deepEqual(unknown.actions, malformed.actions);
  assert.equal(unknown.context, malformed.context);
});

test("13. workspace not accepting members — not called expired", () => {
  const v = at({
    lookup: {
      kind: "resolved",
      lookup: { state: "NOT_ACCEPTING_MEMBERS", context: null },
    },
  });
  assert.equal(v.kind, "not-accepting");
  assert.notEqual(v.kind, "expired");
  assert.ok(!v.actions.includes("accept"));
});

test("14. transient lookup failure — NOT an invalid invitation", () => {
  const v = at({ lookup: { kind: "unreachable" } });
  assert.equal(v.kind, "unreachable");
  assert.notEqual(v.kind, "unknown");
  assert.notEqual(v.kind, "expired");
  // Retry is real here, and it is the primary.
  assert.equal(v.actions[0], "retry");
});

test("15. transient accept failure — the invitation is not blamed", () => {
  const v = at({ auth: SIGNED_IN, accept: { kind: "unreachable" } });
  assert.equal(v.kind, "unreachable");
  assert.ok(v.actions.includes("retry"));
});

test("16. seat/plan refusals are a WORKSPACE condition, with no false retry", () => {
  for (const code of [
    "WORKSPACE_SEAT_LIMIT_REACHED",
    "WORKSPACE_MEMBERS_NOT_INCLUDED",
  ] as const) {
    const v = at({ auth: SIGNED_IN, accept: { kind: "refused", code } });
    assert.equal(v.kind, "capacity", code);
    // The invitee cannot resolve this, so no button pretends they can.
    assert.ok(!v.actions.includes("retry"), `${code} must not offer retry`);
    assert.ok(!v.actions.includes("accept"), `${code} must not offer accept`);
  }
});

test("16b. lock contention IS retryable — the one transient refusal", () => {
  const v = at({
    auth: SIGNED_IN,
    accept: { kind: "refused", code: "WORKSPACE_SEAT_CONTENTION" },
  });
  assert.ok(v.actions.includes("retry"));
});

// ===========================================================================
// 2. EXHAUSTIVENESS — no refusal falls through to a generic error
// ===========================================================================

test("every backend refusal code resolves to an intentional state", () => {
  for (const code of WORKSPACE_INVITATION_REFUSAL_CODES) {
    const v = at({ auth: SIGNED_IN, accept: { kind: "refused", code } });
    assert.ok(v.kind, `${code} produced no view`);
    assert.notEqual(
      v.kind,
      "loading",
      `${code} must not resolve to a loading state`,
    );
    assert.ok(
      v.actions.length > 0,
      `${code} left the reader with nothing to do`,
    );
  }
});

test("an accept answer always outranks the state the page was drawn in", () => {
  // The invitation expired between render and click: the reader was looking at
  // ready-signed-in, and must now see expired rather than the stale card.
  const v = resolveInvitationView({
    token: TOKEN,
    auth: SIGNED_IN,
    lookup: live,
    accept: { kind: "refused", code: "INVITE_EXPIRED" },
  });
  assert.equal(v.kind, "expired");
});

test("no state offers both accept and a terminal escape", () => {
  // A control that cannot succeed beside one that can is how a reader learns
  // to distrust the page.
  const terminal = new Set(["expired", "revoked", "not-accepting", "capacity", "unknown"]);
  const cases: Array<ReturnType<typeof at>> = [
    at({ lookup: { kind: "resolved", lookup: { state: "EXPIRED", context: null } } }),
    at({ lookup: { kind: "resolved", lookup: { state: "REVOKED", context: null } } }),
    at({ lookup: { kind: "not-available" } }),
    at({ auth: SIGNED_IN, accept: { kind: "refused", code: "WORKSPACE_SEAT_LIMIT_REACHED" } }),
  ];
  for (const v of cases) {
    if (!terminal.has(v.kind)) continue;
    assert.ok(!v.actions.includes("accept"), `${v.kind} offered accept`);
  }
});

// ===========================================================================
// 3. THE READ PATH — arriving must not mutate
// ===========================================================================

test("the page does not accept on mount", () => {
  // THE defect. The retired implementation POSTed the accept endpoint from a
  // `useEffect`, so opening the email link consumed the invitation.
  // Positional rather than a fixed character window: every reference to the
  // accept endpoint must appear AFTER `const onAccept`, which is declared
  // after the effect. A window would either miss a long effect or spill into
  // the handler below it, and both make the assertion meaningless.
  const handlerAt = PAGE.indexOf("const onAccept = useCallback");
  assert.ok(handlerAt > 0, "acceptance must be a handler, not a lifecycle");

  const effectAt = PAGE.indexOf("useEffect(");
  assert.ok(effectAt > 0 && effectAt < handlerAt, "expected the read effect first");

  const acceptRefs: number[] = [];
  const re = /invites\/[^"'`\n]*accept/g;
  for (let m = re.exec(PAGE); m; m = re.exec(PAGE)) acceptRefs.push(m.index);
  assert.ok(acceptRefs.length > 0, "the page must still be able to accept");
  for (const idx of acceptRefs) {
    assert.ok(
      idx > handlerAt,
      "the accept endpoint is referenced before/outside onAccept — arriving must not mutate",
    );
  }
  assert.match(PAGE, /\/accept`,\s*\n?\s*\{ method: "POST"/);
});

test("the lookup is a read, and it is the only thing an effect calls", () => {
  assert.match(PAGE, /"\/v1\/teams\/invites\/lookup"/);
  const effect = PAGE.slice(PAGE.indexOf("useEffect("));
  assert.match(effect.slice(0, 2000), /invites\/lookup/);
});

test("a double press cannot submit twice", () => {
  // The disabled attribute is the visible half; the ref is the half that holds
  // when a second click lands in the same tick.
  assert.match(PAGE, /acceptInFlight = useRef\(false\)/);
  assert.match(PAGE, /if \(acceptInFlight\.current\) return;/);
});

test("classification is by STABLE code, never by message text", () => {
  // What the old page did: `message.includes("already accepted")`.
  assert.ok(
    !/\.includes\(["'](already accepted|expired|Forbidden|Invite not found)/.test(PAGE),
    "the page still classifies by substring match over the message",
  );
  assert.match(PAGE, /isWorkspaceInvitationRefusalCode\(code\)/);
  // And the resolver switches over the union with no default arm.
  assert.ok(
    !/case "WORKSPACE_SEAT_CONTENTION":[\s\S]{0,400}default:/.test(RESOLVER),
    "the refusal switch must stay exhaustive rather than gain a default",
  );
});

test("the token never reaches Sentry or a log", () => {
  assert.ok(
    !/captureException\([^)]*token/.test(PAGE),
    "the token is a live credential and must not be attached to an error report",
  );
});

// ===========================================================================
// 4. THE AUTH RETURN FLOW — the parameter each page actually reads
// ===========================================================================

test("sign-in returns to the invitation via `next`, register via `returnUrl`", () => {
  // These are NOT the same parameter. `/login` reads `next` (or `returnUrl`);
  // `/register` reads ONLY `returnUrl`. Sending the wrong one drops the reader
  // on /home having lost the invitation they came for.
  assert.match(PAGE, /\/login\?next=\$\{encodeURIComponent\(returnPath\)\}/);
  assert.match(PAGE, /\/register\?returnUrl=\$\{encodeURIComponent\(returnPath\)\}/);
  assert.match(PAGE, /const returnPath = `\/invite\/\$\{encodeURIComponent\(token\)\}`/);
});

test("the pages this hands off to still read those parameters", () => {
  // Pins the other half of the contract, so a rename over there fails here
  // rather than in a mailbox.
  const login = stripTs(read("app/login/page.tsx"));
  const register = stripTs(read("app/register/page.tsx"));
  assert.match(login, /searchParams\.get\("next"\)/);
  assert.match(register, /searchParams\.get\("returnUrl"\)/);
});

// ===========================================================================
// 5. NO LEGACY GREEN / TEAL, AND NO MARKETING FOOTER
// ===========================================================================

test("the retired green/teal treatment is gone from the invitation route", () => {
  const source = `${PAGE}\n${CSS}`;
  for (const legacy of [
    "site-velvet-bg",
    "panel-silver",
    "rgba(8,18,22",
    "rgba(158,216,207",
    "rgba(79,112,107",
    "#1d3136",
    "#55666a",
    "rgba(245,247,244",
    "rgba(236,239,236",
  ]) {
    assert.ok(
      !source.includes(legacy),
      `the invitation experience still references the retired token ${legacy}`,
    );
  }
});

/**
 * Is this colour a green or a teal, as opposed to a cool slate?
 *
 * Checked by HUE rather than against a blocklist of the specific values that
 * used to be here, so a different green cannot pass.
 *
 * The discriminator is where GREEN sits relative to BLUE, and getting it wrong
 * in either direction makes the test useless:
 *
 *   slate  #475569  r71  g85  b105   green below blue by 20 — this is the
 *                                    canonical PROOVRA ink and must PASS
 *   slate  #64748B  r100 g116 b139   green below blue by 23 — must PASS
 *   teal   #9ED8CF  r158 g216 b207   green ABOVE blue — must FAIL
 *   teal   #1D3136  r29  g49  b54    green within 5 of blue — must FAIL
 *
 * So "green at or near blue, and clearly above red" is the teal signature, and
 * "green well below blue" is slate. The margin is 8, which separates every
 * value in both lists above. Negative controls below prove the guard actually
 * rejects the retired palette rather than merely accepting the new one.
 */
function isGreenOrTeal(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const greenDominant = g > r + 10 && g > b + 10;
  const tealish = g > r + 10 && g >= b - 8;
  return greenDominant || tealish;
}

test("the hue guard rejects the retired palette (negative controls)", () => {
  // Without this, the guard below could be vacuously true.
  for (const legacy of ["#9ED8CF", "#1D3136", "#4F706B", "#55666A", "#2E7D32"]) {
    assert.ok(isGreenOrTeal(legacy), `${legacy} should be rejected as green/teal`);
  }
  // And it must NOT reject the canonical cool inks, or it would forbid the
  // design system this page is built on.
  for (const canonical of [
    "#0F172A",
    "#475569",
    "#64748B",
    "#E7ECF4",
    "#F7F8FC",
    "#5B3FBF",
    "#7C3AED",
    "#B45309",
    "#B3261E",
  ]) {
    assert.ok(!isGreenOrTeal(canonical), `${canonical} is canonical and must pass`);
  }
});

test("the shell declares its own ink, so nothing inherits the legacy teal", () => {
  /*
    Found by measuring the built page in a browser, not by reading source: 32
    computed colours under the shell were `rgb(36, 55, 59)` — the global
    `--foreground` token, a dark teal — because nothing between `body` and the
    card re-declared `color`. The card looked right; the header's links did not.

    The global token is deliberately untouched (other surfaces use it), so the
    fix is a scoped declaration, and this pins it.
  */
  assert.match(
    CSS,
    /\.invite-shell \{[\s\S]{0,400}color: #0f172a/,
    "the invitation shell must declare the canonical ink explicitly",
  );
});

test("no green or teal hue is introduced anywhere in the invitation styles", () => {
  const hexes = CSS.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  assert.ok(hexes.length > 0, "expected the stylesheet to declare colours");
  for (const hex of hexes) {
    assert.ok(
      !isGreenOrTeal(hex),
      `${hex} is a green/teal hue — this experience uses navy/violet only`,
    );
  }
});

test("success is violet, not green", () => {
  const v = at({
    auth: SIGNED_IN,
    accept: { kind: "accepted", alreadyMember: false, destination: "/home" },
  });
  assert.equal(v.tone, "success");
  // The tone table maps success onto the product accent, and the primitive
  // paints one 40px glyph with it — never a green surface.
  const primitive = stripTs(read("components/feedback/ProovraSystemState.tsx"));
  assert.match(primitive, /success: "#5B3FBF"/);
});

test("the shell matches the auth pages: MarketingHeader, no footer", () => {
  assert.match(PAGE, /MarketingHeader/);
  assert.ok(
    !PAGE.includes("EnterpriseFooter"),
    "the marketing footer must not dominate a transaction page",
  );
  // Legal destinations stay reachable, in one restrained line.
  assert.match(PAGE, /invite-trust/);
  assert.match(PAGE, /href="\/legal\/privacy"/);
});

// ===========================================================================
// 6. LAYOUT / RESPONSIVE / A11Y CONTRACTS
// ===========================================================================

test("the card is content-driven, not a fixed rectangle", () => {
  assert.ok(
    !/\.invite-card[^}]*min-block-size/.test(CSS),
    "a minimum height is what produced the giant empty card",
  );
  assert.match(CSS, /\.invite-card \{[\s\S]{0,400}max-inline-size: 660px/);
});

test("long values wrap instead of scrolling the page sideways", () => {
  assert.match(CSS, /\.invite-facts dd \{[\s\S]{0,240}overflow-wrap: anywhere/);
  // The value column may shrink to zero so a long name wraps rather than
  // widening the grid.
  assert.match(CSS, /minmax\(0, 1fr\)/);
});

test("the layout is written in LOGICAL properties, so RTL mirrors", () => {
  assert.ok(
    !/(^|[^-])\b(margin-left|margin-right|padding-left|padding-right|text-align:\s*left)\b/m.test(
      CSS,
    ),
    "a physical property will not mirror under dir=rtl",
  );
  assert.match(CSS, /padding-inline/);
  assert.match(CSS, /border-block/);
});

test("the canonical state primitive itself is RTL-correct", () => {
  const primitive = stripTs(read("components/feedback/ProovraSystemState.tsx"));
  assert.match(primitive, /textAlign: "start"/);
  assert.ok(
    !/textAlign: "left"/.test(primitive),
    "left alignment does not mirror in an RTL document",
  );
  assert.match(primitive, /marginInlineStart: 5/);
});

test("actions stack full-width on a phone", () => {
  assert.match(CSS, /@media \(max-width: 420px\)[\s\S]{0,400}flex-direction: column/);
});

test("the loading state is announced, and its motion is optional", () => {
  assert.match(PAGE, /aria-busy=\{busy\}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}animation: none/);
  // The skeleton is decoration; the accessible signal is aria-busy.
  assert.match(PAGE, /invite-facts--loading[\s\S]{0,120}aria-hidden/);
});

test("the facts are a definition list, not four mini-cards", () => {
  assert.match(PAGE, /<dl className="invite-facts"/);
  assert.match(PAGE, /<dt>Workspace<\/dt>/);
  assert.match(PAGE, /<dt>Invited as<\/dt>/);
});

test("decorative separators are hidden from assistive technology", () => {
  assert.match(PAGE, /<span aria-hidden="true"> · <\/span>/);
});

// ===========================================================================
// 7. DISCLOSURE — no internal identifier reaches the reader
// ===========================================================================

test("no internal id is rendered", () => {
  // `workspaceId` is read from the accept response to build a link; it must
  // never appear as content.
  assert.ok(!/<dd>\{[^}]*\bid\b/.test(PAGE), "an id is rendered as a value");
  for (const field of ["teamId", "organizationId", "inviteId", "userId", "tokenHash"]) {
    assert.ok(
      !new RegExp(`\\{[^}]*${field}[^}]*\\}`).test(PAGE.replace(/\/\*[\s\S]*?\*\//g, "")),
      `${field} must not reach the invitation surface`,
    );
  }
});

test("the invited address is masked, and recognisably so", () => {
  assert.equal(maskInvitedEmail("jalal@example.com"), "j••••@example.com");
  // A one-character mailbox is not disclosed exactly by the function whose job
  // is to withhold it.
  assert.ok(!maskInvitedEmail("a@example.com").startsWith("a"));
  // Garbage in, nothing out — never a partial address.
  assert.equal(maskInvitedEmail("not-an-email"), "•••");
  assert.equal(maskInvitedEmail(""), "•••");
});

test("token shape is checked before anything is sent", () => {
  assert.ok(isWellFormedWorkspaceInviteToken(TOKEN));
  assert.ok(!isWellFormedWorkspaceInviteToken("wsit_v1_short"));
  assert.ok(!isWellFormedWorkspaceInviteToken("ctit_v1_" + "a".repeat(43)));
  assert.ok(!isWellFormedWorkspaceInviteToken(""));
  assert.ok(!isWellFormedWorkspaceInviteToken(null));
  // And the page uses it, so a guess costs no request and no rate-limit budget.
  assert.match(PAGE, /isWellFormedWorkspaceInviteToken\(token\)/);
});
