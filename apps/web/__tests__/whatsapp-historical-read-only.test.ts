/**
 * WHATSAPP IS READABLE, NOT SENDABLE.
 *
 * Retiring a way of SENDING does not retire the records it already wrote. A
 * delivery record is history — it says what happened when it happened, and it
 * stays on screen long after the channel is gone. When WhatsApp was retired
 * from External Intake the send path went, correctly, and its reason mapping
 * went with it, which left stored WhatsApp failures rendering to operators as
 * `whatsapp_template_unconfigured`.
 *
 * So the mappings are back, past tense and read-only. This guard exists to
 * make sure that restoring the COPY did not restore the CHANNEL, which is the
 * obvious way for this fix to go wrong later.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { friendlyDeliveryReason } from "../app/(app)/intake-links/_lib/wizardState";

const HERE = dirname(fileURLToPath(import.meta.url));
const INTAKE_LINKS = resolve(HERE, "../app/(app)/intake-links");

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

test("every retired WhatsApp reason still reads as English", () => {
  for (const code of ["whatsapp_template_unconfigured", "whatsapp_unconfigured"]) {
    const copy = friendlyDeliveryReason(code);
    assert.notEqual(copy, code, `"${code}" reaches the operator verbatim`);
    assert.ok(!copy.includes("_"), `"${copy}" still reads like an enum`);
    assert.match(copy, /WhatsApp/, `"${copy}" should still name the channel`);
  }
});

test("the WhatsApp copy is past tense — a record, not an instruction", () => {
  // "isn't approved yet" invites an operator to go and approve a template for
  // a channel that no longer exists. These records describe what happened.
  for (const code of ["whatsapp_template_unconfigured", "whatsapp_unconfigured"]) {
    assert.doesNotMatch(friendlyDeliveryReason(code), /\byet\b|\bisn't\b/);
  }
});

test("an unmapped reason still falls through unchanged", () => {
  // Deliberate and asserted elsewhere: this mapper does not invent English for
  // a code nobody has decided about. Restoring the WhatsApp entries must not
  // have turned it into a humaniser.
  assert.equal(friendlyDeliveryReason("brand_new_reason"), "brand_new_reason");
});

test("no WhatsApp SEND path came back with the copy", () => {
  const offenders: string[] = [];
  for (const file of files(INTAKE_LINKS)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(INTAKE_LINKS.length + 1).replace(/\\/g, "/");
    // A send is a channel value posted to the API, or an action offering one.
    if (/data-intake-link-send="WHATSAPP"/.test(src)) {
      offenders.push(`${rel}: offers a WhatsApp send action`);
    }
    if (/channel:\s*"WHATSAPP"/.test(src)) {
      offenders.push(`${rel}: posts WHATSAPP as a send channel`);
    }
    if (/deliveryMethod:\s*"WHATSAPP"/.test(src)) {
      offenders.push(`${rel}: creates a link with WhatsApp delivery`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "WhatsApp is retired as an intake delivery option; only its historical records may be read",
  );
});

test("the reason map is the only place WhatsApp survives here", () => {
  // If WhatsApp appears anywhere in this feature OTHER than the read-side
  // mapper and its own explanation, something has re-grown.
  const state = readFileSync(
    resolve(INTAKE_LINKS, "_lib/wizardState.ts"),
    "utf8",
  );
  const code = state
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  // The KEYS, not every mention — the English on the right-hand side names
  // the channel on purpose, because an operator reading an old record needs
  // to know which channel failed.
  const keys = [...code.matchAll(/^\s*(whatsapp_[a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(
    keys.sort(),
    ["whatsapp_template_unconfigured", "whatsapp_unconfigured"],
    "the historical reason keys are the only WhatsApp surface left in this module",
  );
});
