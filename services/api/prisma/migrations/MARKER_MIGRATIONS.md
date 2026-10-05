# Marker migrations (historical, intentionally empty)

RGA-06. Some migration directories in this folder contain only a comment banner
and execute no SQL. They are **restored historical markers**: the directory name
is recorded as applied in production's `_prisma_migrations` table, but the
original SQL body was lost after a rollback and could not be reconstructed. They
are kept, byte-for-byte, so that `prisma migrate deploy` continues to match the
recorded history on every environment. **Do not edit, rename, re-checksum, or
delete them** — doing so would make deploy report a drift against production.

## Known marker migrations

| Directory | What its NAME implies | Where the real columns actually come from |
|---|---|---|
| `20270901000000_verification_package_validation_findings` | package validation findings | no such column exists in the current schema; nothing references one |
| `20270902000000_verification_package_hash` | package hash | `verification_packages.package_sha256` + `report_sha256` were (re)introduced by `20280680000000_artifact_recovery_progress` and `20280730000000_evidence_output_lifecycle` |
| `20270903000000_verification_package_validation_status` | package validation status | no such column exists in the current schema; nothing references one |
| `20270904000000_report_claims_package_verified` | a "package verified" claim on reports | no such column exists; the report↔package relationship is carried by `reports.verification_package_version` and `verification_packages.report_version` |

**Net effect at the current baseline:** the current schema is consistent and no
runtime code references a column these markers' names imply (verified by repo
grep for `package_verified` / `validation_status` / `validation_findings` →
zero references). They are a housekeeping artifact, **not** a current runtime
defect, and require no code change.

## Preventing new empty, misleading migrations

A prospective governance guard (reject a brand-new migration whose SQL body is
empty, while explicitly allow-listing these known historical markers by name) is
the only safe addition here. It is intentionally **not** added as a hard CI gate
in this change set, because it would require wiring into the repo's migration
tooling and cannot be proven end-to-end in this environment without that lane;
it is recorded here as the documented, bounded follow-up.
