# Runbook slug classification

Every `runbookSlug` this codebase emits, and what it resolves to.

## Why this exists

`runbookSlug` looked like a document reference and was mostly not one. Of the
slugs emitted by incident services, six had a markdown file and the rest named a
*condition*. Three surfaces linked all of them — `CommandCenter`,
`GovernanceControlPlane` and the admin Operations table — so most "Runbook"
links pointed at nothing, and once the reader existed with
`dynamicParams = false` they would have pointed at a 404 mid-incident.

The classification below is the fix's second half. The first half was making
link sites check `hasRunbook()` before rendering a link; this is deciding, for
each slug, whether the answer to that check should be yes.

## Dispositions

| Disposition | Meaning |
| --- | --- |
| **PROCEDURE** | A markdown runbook exists at this exact slug. |
| **ALIAS** | Deliberately mapped to another runbook, which covers it. |
| **LABEL** | Names a condition. The condition's own `safeSummary` and threshold say everything an operator needs; no separate procedure exists or should. |

`LABEL` is a real answer, not a backlog entry. Writing a runbook per threshold
would produce thirty documents that each say "the number is above the number";
the condition text already carries the source query, the threshold and the
escalation point. A link is only offered where a document adds something the
condition does not.

## The table

Grouped by the high-risk families that require an authoritative procedure.

### Cryptographic timestamping

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `evidence-integrity-recovery` | ALIAS | [`tsa-timestamp-failure`](./tsa-timestamp-failure.md) |
| `evidence-integrity` | ALIAS | [`tsa-timestamp-failure`](./tsa-timestamp-failure.md) |
| `ots-anchoring` | ALIAS | [`ots-degradation`](./ots-degradation.md) |

TSA and OTS are deliberately separate documents and must not be merged. A failed
OTS anchor is retryable; a failed RFC3161 timestamp is not, because
re-contacting the authority would mint a token whose `genTime` is later than the
evidence it certifies. Reasoning from one to the other is the specific mistake
both runbooks warn against.

### Report generation

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `report-pipeline` | ALIAS | [`failed-report-generation`](./failed-report-generation.md) |
| `report-generation-failure` | ALIAS | [`failed-report-generation`](./failed-report-generation.md) |

### Verification packages

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `package-pipeline` | ALIAS | [`failed-verification-package`](./failed-verification-package.md) |
| `package-generation-denied` | ALIAS | [`export-blocked`](./export-blocked.md) |

`package-generation-denied` is a governance **refusal**, not a failure — the
eligibility gate declined. `export-blocked` is the document about deliberate
refusals; `failed-verification-package` is the one about things breaking.
Pointing a refusal at the failure runbook would send an operator looking for a
fault that does not exist.

### Queue and worker

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `queue-outage` | ALIAS | [`worker-wedged`](./worker-wedged.md) |
| `queue-failed-jobs` | ALIAS | [`worker-wedged`](./worker-wedged.md) |
| `worker-heartbeat-stale` | ALIAS | [`worker-wedged`](./worker-wedged.md) |
| `queue-inventory-unavailable` | ALIAS | [`observability-degraded`](./observability-degraded.md) |
| `worker-heartbeat` | LABEL | — |
| `retry-storm` | LABEL | — |
| `telemetry-sampler` | LABEL | — |

`queue-inventory-unavailable` deliberately points at observability rather than
at the worker runbook. It means the inventory could not be READ — which is a
measurement failure, not a queue failure. Treating it as a queue outage sends an
operator to restart something that may be perfectly healthy, and hides the fact
that queue health is currently unmeasured rather than good.

### Search and indexing

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `search-index` | PROCEDURE | [`search-index-degraded`](./search-index-degraded.md) |

### Storage and immutability

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `immutable-drift` | PROCEDURE | [`immutable-drift`](./immutable-drift.md) |

### Signing

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `signing-pipeline` | PROCEDURE | [`signing-backlog`](./signing-backlog.md) |

### Authentication and security

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `suspicious-login-burst` | PROCEDURE | [`suspicious-login-burst`](./suspicious-login-burst.md) |
| `high-risk-session-surge` | ALIAS | [`suspicious-login-burst`](./suspicious-login-burst.md) |
| `runtime-adaptive-block` | ALIAS | [`suspicious-login-burst`](./suspicious-login-burst.md) |
| `idp-outage-response` | ALIAS | [`twilio-outage`](./twilio-outage.md) |

`high-risk-session-surge` and `runtime-adaptive-block` are the same
investigation as a login burst — establish whether the signal is an attack or a
population shift, then decide whether the automatic response was correct. They
are aliased rather than duplicated so the three cannot give different advice.

`idp-outage-response` is aliased to the third-party-outage procedure because the
shape is identical: an external identity provider is down, the platform is not
at fault, and the operator's job is to confirm scope, communicate, and avoid
changing configuration during someone else's incident. **If IdP-specific steps
are ever needed, write them — do not extend the Twilio runbook to cover both.**

### Webhooks

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `webhook-invalid-signature-burst` | PROCEDURE | [`webhook-invalid-signature-burst`](./webhook-invalid-signature-burst.md) |

### Incident lifecycle and reviewer operations

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `reviewer-escalation-storm` | PROCEDURE | [`reviewer-escalation-storm`](./reviewer-escalation-storm.md) |
| `reviewer-ops` | ALIAS | [`reviewer-queue-stuck`](./reviewer-queue-stuck.md) |
| `coordination-backlog` | ALIAS | [`reviewer-escalation-backlog`](./reviewer-escalation-backlog.md) |

### Upload

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `stuck-upload` | PROCEDURE | [`stuck-upload`](./stuck-upload.md) |

### Third-party delivery

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `twilio-outage` | PROCEDURE | [`twilio-outage`](./twilio-outage.md) |

### Not in a high-risk family

| Slug | Disposition | Resolves to |
| --- | --- | --- |
| `billing-provider-authorization` | LABEL | — |
| `operational-seeding` | LABEL | — |

`billing-provider-authorization` fires when a payment provider declines an
authorization. It is actionable, but the action is entirely on the provider's
side and the condition text names the provider and the decline reason. A runbook
would restate it.

`operational-seeding` fires from the operational seed service and describes a
setup state rather than an incident.

## What the tests enforce

`apps/web/__tests__/runbook-catalog-freshness.test.ts`:

- every slug emitted anywhere in the API or worker source appears in this
  classification — a new emitter cannot be added without a decision;
- every PROCEDURE and every ALIAS target resolves to a real markdown file;
- every LABEL slug is **absent** from the resolver, so no surface can render it
  as a link;
- the generated catalog and the `docs/runbooks` README index stay complete;
- no filesystem path is presented to a browser as a link.
