# Source-audit agent brief (shared by every area agent)

Repository under audit: `D:/pv-uca` (git worktree, branch `audit/universal-evidence-capture-truth`,
baseline = origin/main `47034f45403e87089b29571e3e702311c9d1a2a4`). Audit ONLY this tree.

## Hard rules
- READ-ONLY on product source. Never edit anything under apps/, services/, packages/, prisma/.
  The only file you may write is your own findings file named in your task.
- NEVER open, cat, grep or read any `.env` file (services/api/.env, services/worker/.env, apps/*/.env*).
  `.env.example` is allowed.
- Do not start servers, workers, databases, browsers or docker. Do not make network calls.
  You may run read-only shell (grep/rg/sed/cat/git log/git show) and `node -e` for pure parsing.
- Do NOT spawn sub-agents (you will be cut off).
- Never convert missing evidence into a pass. "Tests exist" ≠ complete; "code exists" ≠ reachable.
- Verify every claim first-hand at file:line in THIS tree. Line numbers must be exact.

## Context
A prior audit (`docs/evidence/audits/definitive-evidence-lifecycle-truth.json`, 153 findings `ET-*`)
was remediated and merged before this baseline (`docs/evidence/audits/definitive-evidence-lifecycle-remediation/`).
Do not re-report an ET finding as new unless it is still reproducible here; if a finding of yours
overlaps an ET id, put that id in `aliases`. Program docs: `docs/admin/audits/UC*` and memory of prior
work claims UC-0..UC-6 are "code complete" with device/store/external acceptance deferred — test that
claim, do not trust it.

## Output: one JSON file
```json
{
  "area": "<AREA>",
  "reviewed": [ {"topic": "...", "verdict": "OK|DEFECT|PARTIAL|BLOCKED|NOT_IMPLEMENTED", "evidence": "file:line …", "note": "..."} ],
  "findings": [ {
    "id": "UC-<AREA>-NNN",
    "severity": "P0|P1|P2|P3",
    "title": "one line",
    "ucs": ["UC-0a", ...],
    "platforms": ["extension","web","pwa","android","ios","api","worker","all"],
    "userImpact": "...", "legalImpact": "...", "securityImpact": "... or none",
    "locations": [ {"file": "repo/relative/path", "line": 123} ],
    "reproduction": "concrete steps or the exact code path",
    "observed": "...", "expected": "...", "rootCause": "...",
    "proof": "source-proven",
    "remediation": "...", "requiredTests": "...", "migrationImpact": "none|additive|...",
    "dependsOn": [], "aliases": [],
    "runtimeProbe": "optional: a concrete disposable-DB/API test that would runtime-prove this"
  } ],
  "facts": { "free-form structured facts your task asks for" }
}
```
Severity: P0 = cross-tenant access/write, integrity corruption, false verification of altered evidence,
destructive data loss, private evidence exposure. P1 = core capture cannot complete, evidence falsely
labelled authentic/verified, missing/misordered parts accepted, report/package/verify materially false,
recovery destroys/duplicates output, primary channel disconnected. P2 = important feature unreachable,
misleading state, provenance field lost, serious platform inconsistency, error shown as empty/success.
P3 = presentation/copy/a11y/observability.
One root cause = one finding. Be precise and conservative: a finding needs a code path, not a hunch.
Put things that are fine in `reviewed` with verdict OK and a citation — that is how coverage is proven.
Aim for depth over breadth, but cover every topic in your task list in `reviewed`.
Final message: a <=15 line summary and the path of your JSON file.
