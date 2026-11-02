# Runbook 32 — Returning an organization's data at offboarding

**Status:** operator procedure. There is no customer-facing export job (GOV-015).
Written against the DPA's return obligation (`dpa.md` §Appendix E). Not yet run
against production storage.

## When

A customer instructs return of its data at contract end, under the DPA.

## Before you start

- The instruction is in writing, from someone entitled to give it.
- Do NOT start deletion. Return comes first; deletion is the governed destruction
  path and its two people.
- You have read-only database access and read access to the evidence bucket.

## Steps

1. Generate the manifest. It writes nothing but the local file.

   ```text
   pnpm --filter proovra-api ops:organization-export-manifest -- --organization=<id> --out=<file>
   ```

2. Read the summary line. Stop on any of these:
   - `missingObjects` above 0, or exit code 2: storage does not hold what the record
     says. Treat it as an integrity incident before anything leaves.
   - `heldRecordCount` above 0: see "Records under legal hold".

3. Copy each object in `records[].objects` by `key` and, when present, `versionId`.
   A key without its version can return bytes other than the sealed ones.

4. Reconcile the copy before handing it over: object count equals `objectCount`,
   bytes equal `byteCount`, and the SHA-256 of each copied object equals `sha256`
   where the manifest has one. A null `sha256` means PROOVRA holds no digest for
   that object, so list it for the customer rather than claiming it was verified.

5. Hand over the copy with the manifest and its `manifestSha256`, and record the
   date, the operator and the hash in the customer's offboarding ticket.

## Records under legal hold

Whether held bytes may leave custody is undecided (GOV-012), and the product blocks
every byte export under a hold. The manifest lists them with `legalHold: true`. Do
not copy them. Tell the customer which records are held and by whom the hold can be
lifted, and escalate to the founder.

## What this does not do

- It does not return records destroyed before the instruction. They are counted in
  `destroyedRecordCount`; their certificates are the record of what happened.
- It does not include custody events or audit logs. Those are not in this manifest.
- It does not cover redaction derivatives, derived assets or SIU bundles, which are
  derived from the objects listed.
