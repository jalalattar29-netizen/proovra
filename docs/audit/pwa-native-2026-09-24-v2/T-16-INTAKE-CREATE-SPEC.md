# T-16 SPEC — native intake-link creation (extracted 2026-09-24, session 2)

Web: `apps/web/app/(app)/intake-links/_components/wizard/*`, `_lib/wizardState.ts` (WS),
`lib/intake-links/catalog.ts` (CAT), `vocabulary.ts` (VOC), `LinkCreatedDialog.tsx`.
API: `services/api/src/routes/workflow-intake-links.routes.ts` (R).

## Flow
4 steps: Request · Delivery · Collection rules · Review → `POST /v1/workflow/intake-links` (no step-up;
`workflow.intake_link.create`) → one-time "Secure link created" result (token shown ONCE; URL is built
client-side `${origin}/intake/${encodeURIComponent(rawToken)}`) → list refresh.
Title "New intake link"; subtitle "{purpose} · step n of 4"; buttons Cancel/Back, Continue,
"Create secure link" (MANUAL) / "Create and send"; "Creating…". Discard confirm:
"Discard this intake link?" / "You've entered details that haven't been used yet. Closing now discards
them — nothing has been created or sent." (Discard / Keep editing).

## Body (zod CreateBody R:104-211)
teamId, workflowTemplateSlug, intakeMode, deliveryMethod (MANUAL|EMAIL|SMS), intakeUrlBase (required
unless MANUAL), recipientLabel≤180|null, customerId≤120|null, recipientEmail|null, recipientPhone (E.164)|null,
maxUses (1000 if REUSABLE else 1), maxFileCountPerSession 1-500|null, allowedAcceptedKinds (catalog order),
consentDisclosureText≤4000|null, expiresAtUtc (now+clamp(h,1,8760)), idempotencyKey `create:<uuid>` per
wizard, senderDisplayMode, senderDisplayName (CUSTOM only), locationPolicy (send explicitly; server default NONE, UI default OPTIONAL).

201 → `{link, rawToken, warning, delivery}`; delivery: MANUAL skipped | sent | failed(reason) — a failed
delivery still created the link.

## Native origin
`EXPO_PUBLIC_WEB_BASE` (set to https://www.proovra.com in all four eas.json profiles; previously unread).

## Web defects found (record for web fix)
- 403 `external_intake_disabled_by_policy` never matches the web's map key `intake_disabled_by_policy`
  → web shows "HTTP 403: API error".
- The 8760 h expiry maximum is client-only; the server only rejects `expiry_in_past`.
- The send-from-result call sends no idempotencyKey.

Full verbatim copy (catalog, modes, channels, sender modes, location, expiry, kinds, validation,
error maps, result dialog, delivery reasons) lives in `apps/mobile/src/product/intake-create.ts`
with web line references.
