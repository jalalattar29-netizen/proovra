# Operations truth audit (audit-only)

Audit of PROOVRA Operations at baseline `85c8800778e4c09e7681f83c1ee8fed4661beff9`. Nothing here is imported by Product code.

- `artifacts/`: the canonical outputs. `operations-truth-audit.json` is the authority, and `operations-truth-audit.md` is rendered from it. Do not edit either by hand.
- `authority/`: the hand-authored findings, persona cells and external blockers. Every source symbol is grep-verified and every proof id is checked by the generator.
- `source/`: inventories derived from Product source (endpoints, routes, controls, producers/resolvers, domain ownership, admin separation, native/locale).
- `evidence/`: executed proof records. Each one carries the sha256 of every Product file it depends on, and a stale fingerprint fails gate G01.
- `harness/`: the audit tests (Vitest against the real API), the Playwright browser matrix and the native test recorder.
- `generator/generate.mjs`: the conservation gates (G01–G11) and artifact generation. It is deterministic and exits 1 if any gate fails.

## Reproduce (loopback only, no Production)

```
docker run -d --name opsaudit-pg -p 127.0.0.1:55471:5432 -e POSTGRES_USER=pv -e POSTGRES_PASSWORD=pv -e POSTGRES_DB=opsaudit_test pgvector/pgvector:pg16
docker run -d --name opsaudit-redis -p 127.0.0.1:56471:6379 redis:7-alpine
# migrate opsaudit_test and opsaudit_browser, then:
cd services/api && TEST_DATABASE_URL=postgresql://pv:pv@127.0.0.1:55471/opsaudit_test RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1 P7_TEST_REDIS_URL=redis://127.0.0.1:56471 npx vitest run --config ../../audit-operations/harness/vitest.opsaudit.config.mjs
# browser: seed with harness/browser/seed-browser.ts, start services/api/scripts/dev-admin-fixture-api.mjs and apps/web/scripts/dev-admin-fixture.mjs --mode=production, then
node audit-operations/harness/browser/run-browser.mjs
node audit-operations/harness/native/record-mobile-tests.mjs
node audit-operations/generator/generate.mjs
```
