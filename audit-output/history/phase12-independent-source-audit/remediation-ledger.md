# Phase 12 Focused Reachability Audit — NORMALIZED LEDGER

Produced by remediation **Step 0** (2026-08-06), before any production code was changed.
Audited source revision `a7863bec33f10549d84a839ee7ab353509626a2a`.

This file exists because the audit artifact contradicted itself and because two of its
rows were positive results being carried in defect counts. It reconciles both, and it is
the counting basis every later remediation claim is measured against.

---

## 1. The contradiction, resolved

`focused-final-report.md` line 18 states `Medium 8`. `findings.json` `counts.MEDIUM` also
states `8`. The findings ARRAY, however, contains **nine** rows at `severity: "MEDIUM"`:

```text
AUTH-005   MEDIUM
COMM-001   MEDIUM
ARCH-001   MEDIUM
ARCH-002   MEDIUM
ARCH-003   MEDIUM
DB-010     MEDIUM
DB-011     MEDIUM
MOBILE-001 MEDIUM
INFRA-001  MEDIUM
```

Nine rows, header says eight.

**Resolution.** The array is authoritative; the header undercounted by one. The
discrepancy is not a missing finding — it is a stale scalar. Reclassifying `DB-011` (below)
brings the ACTIONABLE Medium count to **8**, which is what the header always claimed, so
the header's number was right about the actionable set and wrong about the array length.

---

## 2. Verified positives moved out of defect counts

Two rows describe things that are CORRECT. Counting a proof of correctness as a defect
inflates the backlog and, worse, invites a "fix" to something that is already right.

### DB-011 — `MEDIUM` → `VERIFIED_CLOSURE`

Its own text: *"No reachable writer targets any object removed by the contract
migrations."* It then establishes that `case_evidence_links` has exactly ONE reachable
writer, `evidence_legal_holds` has exactly ONE, the `Evidence` model carries no `caseId`
field, no model maps to the dropped tables, and persona residue survives only in comments
in four files.

That is clean post-contract convergence with no legacy writer. There is nothing to
remediate. Classification: **VERIFIED_CLOSURE**. Its `classification` field already said
`PROVEN_MATCH`; only the `severity` was wrong.

### WEB-001 — `LOW` → `VERIFIED_CLOSURE`

Its own title: *"CSP nonce vs static-render hazard is closed."* It establishes that
middleware sets the CSP on the REQUEST headers (where Next reads the nonce for its own
inline bootstrap), that the root layout is `force-dynamic`, that the matcher covers every
page, and that the single `generateStaticParams` route sits under the force-dynamic root.

The hazard recorded in the `point7-csp-nonce-static-render` memory is demonstrably closed.
Classification: **VERIFIED_CLOSURE**.

### DB-010 — retained, narrowed

`DB-010` is NOT a verified closure and is NOT withdrawn. Its guard-correctness half is a
positive result — every contract migration was read in full and no guard was found
positioned after the statement it protects. Its RESIDUAL half is a real, open risk:

> `20271117000000_point4_schema_authority_contract` carries a banner forbidding its
> presence in the Release A/B/C artifact, and the persona guard is a SEPARATE migration
> from the drop it protects. Both properties are enforced by artifact assembly, not by the
> migration chain.

`DB-010` is retained at **MEDIUM**, scoped to that release-artifact assembly risk alone.

---

## 3. Normalized counts

```text
ConfirmedActionableCritical   1
ConfirmedActionableHigh       4
ConfirmedActionableMedium     8
ConfirmedActionableLow        6
VerifiedClosures              2
UnknownBlocked                4
```

### ConfirmedActionableCritical (1)

| ID | Title |
|---|---|
| SEC-001 | Four external-review routes authorize off a stale navigation pointer with no membership requirement — cross-tenant read plus an outbound email side effect |

### ConfirmedActionableHigh (4)

| ID | Title |
|---|---|
| ARCH-005 | The entire automation execution engine is unreachable |
| AUTH-001 | Intelligence-platform routes treat membership existence as membership validity |
| AUTH-002 | `GET /v1/me/inbox` derives the caller's workspace set from status-blind membership |
| AUTH-003 | Case mutation permission service resolves the caller's role without consulting membership status |

**AUTH-004 is reclassified from HIGH to MEDIUM, not withdrawn.** The audit's own
`CORRECTIONS_TO_PRIOR_PASS` block materially restates it: canonical adoption is 520 routes,
not 101, and the real residual is 17 routes behind a status-blind helper plus 28 inline
membership checks. What remains genuinely HIGH about it — the specific status-blind gates —
is already counted as SEC-001, AUTH-001, AUTH-002 and AUTH-005. What is uniquely AUTH-004
is that `authorization-allowlist.ts` is an unreachable, stale governance artifact: a real
defect (a control that does not run is not a control), but a MEDIUM one, because it is the
absence of a safeguard rather than a live access path. Counting it as HIGH double-counts
the same three access paths.

### ConfirmedActionableMedium (8)

| ID | Title |
|---|---|
| AUTH-004 | Authorization policy re-implemented per route file; the preventing mechanism is itself unreachable and stale *(reclassified from HIGH — see above)* |
| AUTH-005 | 28 routes perform an inline membership check instead of calling any audited gate |
| COMM-001 | Seat and member counts include SUSPENDED and REVOKED members |
| ARCH-001 | Two workspace vocabularies coexist: tri-state WorkspaceKind and binary workspaceType (PERSONAL\|TEAM) |
| ARCH-002 | Workspace kind is not enforced by the database and the NULL fallback infers kind from the plan |
| ARCH-003 | Platform-context envelope field named `organizations` carries Workspace ids |
| DB-010 | Release-artifact assembly can ship a destructive migration without its guard *(narrowed)* |
| MOBILE-001 | Mobile Teams tab lists workspaces but exposes no action and no navigation |

`INFRA-001` moves to Low: it is a deployment-hygiene defect with no runtime access or data
consequence, and the audit itself records that API and worker share one `IMAGE_TAG` so they
cannot skew relative to each other. It is retained as fully actionable.

### ConfirmedActionableLow (6)

| ID | Title |
|---|---|
| INFRA-001 | Production compose defaults both service images to the floating `:latest` tag *(reclassified from MEDIUM)* |
| LEGACY-003 | Eleven further production modules are unreachable from every runtime entrypoint |
| LEGACY-001 | `TEAM_WORKSPACE_*` error codes and `allowsTeamWorkspace` retain Team-Workspace terminology |
| COMM-002 | Public pricing page hard-codes owned-workspace limits as client-side fallbacks |
| WEB-002 | Search recent-queries bypasses the canonical tenant-storage helper |
| ARCH-004 | Organization membership has no lifecycle state; revocation is a physical delete |

Six rows: the original Low set (`LEGACY-003`, `LEGACY-001`, `COMM-002`, `WEB-002`,
`ARCH-004`, `WEB-001`) minus `WEB-001` (moved to VerifiedClosures), plus the reclassified
`INFRA-001`. Net: 6 − 1 + 1 = **6**.

### VerifiedClosures (2)

| ID | What is proven correct |
|---|---|
| DB-011 | No reachable writer targets any object removed by the contract migrations; convergence is clean |
| WEB-001 | The CSP-nonce vs static-render hazard is closed; no page can be emitted with `nonce=$undefined` |

### UnknownBlocked (4)

| ID | Question |
|---|---|
| UNK-001 | Does the deployment artifact ship each contract migration together with its guard? |
| UNK-002 | Source-to-image correspondence |
| UNK-003 | Applied-migration state, checksum drift, post-contract schema convergence |
| UNK-004 | Production count of `teams.workspace_kind IS NULL` |

---

## 4. Reconciliation arithmetic

```text
                       audit says   normalized   movement
CRITICAL                        1            1   —
HIGH                            5            4   AUTH-004 -> MEDIUM
MEDIUM                    8 (hdr)            8   +AUTH-004, -DB-011 (closure), -INFRA-001 (to LOW)
                          9 (arr)
LOW                             6            6   +INFRA-001, -WEB-001 (closure)
VERIFIED_CLOSURE                0            2   +DB-011, +WEB-001
UNKNOWN_BLOCKED                 4            4   —

total rows                     25           25   conserved
                    (1+5+9+6+4)  (1+4+8+6+2+4)
```

Row conservation is the check that matters: nothing was dropped, nothing invented.
Twenty-five rows in, twenty-five rows out; only their classification moved. (Twenty-five,
not twenty: the header's `Medium 8` was the undercount identified in §1.)

**Actionable total: 19 findings** (1 CRITICAL + 4 HIGH + 8 MEDIUM + 6 LOW), plus 4
UNKNOWN_BLOCKED questions, plus 2 verified closures that require no work.

---

## 5. What this step deliberately did NOT do

No unchanged source was re-audited. The audit's findings were read as given and only their
CLASSIFICATION was corrected. Where a finding's own body contradicted its severity — DB-011
proving correctness while carrying MEDIUM, WEB-001 proving closure while carrying LOW — the
body was taken as authoritative, because the body contains the evidence and the severity
field contains only a claim.
