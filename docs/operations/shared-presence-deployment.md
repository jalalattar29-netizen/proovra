# Shared Presence — Production Deployment Decision (Phase G3.2)

**Status:** documented production-scaling blocker. **Single-instance deployments are unaffected.**

## What this doc covers

The Phase G3 presence service (`services/api/src/services/presence/presence.service.ts`) tracks
"who is viewing what" via a 90-second TTL heartbeat protocol. Today the service
stores heartbeats in an **in-process `Map`** — a deliberate choice that makes
the single-instance API deploy work correctly with zero infra dependencies.

When the API runs as **two or more replicas behind a load balancer**, the
in-process map fragments: operator A's heartbeat hits replica 1, operator B's
heartbeat hits replica 2, and neither sees the other in `listViewers()`.
PresenceIndicator silently degrades to "you appear to be alone" even when peers
are present. This is incorrect, not unsafe — no policy gate, no audit gate, no
custody gate is bypassed.

## Decision

We **do not** ship a Redis-backed presence adapter in this phase. Reasons:

1. PROOVRA currently deploys as a **single-instance** API. The compose file
   `infra/docker/docker-compose.yml` (lines 16-22) runs **one** Redis container
   used solely by the rate-limiter. No autoscaling or replica configuration
   exists today.
2. The presence service's interface (`recordHeartbeat`, `listViewers`) is
   already shaped to swap implementations. The cost of building the Redis
   adapter is low; the cost of carrying an unused adapter — including its test
   surface, mock setup, and ops runbook — through the rest of the live-ops wave
   is higher than the value it adds before multi-instance is a real
   deployment target.
3. The single-instance presence already satisfies every operator scenario in
   the current product: matter workspace, evidence detail, reviewer inspector,
   discussion thread surface. Operators see peers correctly in all of these.

## When to revisit

Build the Redis-backed adapter the moment any of these is true:

- `docker-compose.yml` declares `replicas > 1` for the `api` service, OR
- The deploy plan calls for Kubernetes / Fly.io / Render autoscale with
  `MIN_REPLICAS > 1`, OR
- A customer's load profile materially exceeds the single-instance throughput
  budget (~5k RPS sustained, ~50k concurrent operators per the Phase 28
  capacity audit).

Until then, this blocker is **documented, not deferred** — the operator-visible
contract is honest, and the codebase is shaped to accept the swap when the
need arrives.

## Migration shape (when the time comes)

The presence service exposes a narrow contract:

```ts
// services/api/src/services/presence/presence.service.ts
export interface PresenceStore {
  recordHeartbeat(input: {
    teamId: string;
    resourceKind: string;
    resourceId: string;
    userId: string;
    displayName: string | null;
    nowUtc: Date;
  }): Promise<void>;

  listViewers(input: {
    teamId: string;
    resourceKind: string;
    resourceId: string;
    nowUtc: Date;
  }): Promise<ReadonlyArray<PresenceViewer>>;
}
```

The swap is bounded:

1. **Implement `RedisPresenceStore`** in a new file
   `services/api/src/services/presence/presence.redis.store.ts`. Key shape:
   `presence:{teamId}:{resourceKind}:{resourceId}` → Redis hash of
   `userId → JSON({displayName, lastSeenAtUtc})`. Apply a TTL of 90 seconds on
   each write; expired entries fall out naturally.
2. **Gate the swap on the `PRESENCE_BACKEND` environment variable**:
   - `PRESENCE_BACKEND=memory` (default) — current in-process behaviour.
   - `PRESENCE_BACKEND=redis` — wire the Redis-backed store. `REDIS_URL` is
     already required by the rate-limiter, so no new env is needed for
     connectivity.
3. **Preserve the 90-second TTL** so the contract stays identical and the
   25-viewer cap continues to bound payload size.
4. **Add a contract test** that runs both stores through the same heartbeat /
   list-viewers tape and asserts identical outputs.
5. **Update this doc** with a `Deployment` section that names the operational
   command (e.g. `kubectl set env deployment/api PRESENCE_BACKEND=redis`).

## Recommended environment configuration for multi-instance

When the migration ships, **all replicas must agree** on these values:

| Variable             | Value          | Notes                                                  |
| -------------------- | -------------- | ------------------------------------------------------ |
| `PRESENCE_BACKEND`   | `redis`        | New env added by the migration. Default `memory`.      |
| `REDIS_URL`          | (already set)  | Required today for the rate-limiter; the presence     |
|                      |                | store reuses the same connection pool.                 |
| `PRESENCE_TTL_SECS`  | `90`           | Existing constant. Documented here for clarity.        |
| `PRESENCE_MAX_VIEWERS` | `25`         | Existing cap. Documented here for clarity.             |

## Acceptance criteria for the future Redis adapter

The swap is complete only when:

- [ ] All existing G3 presence contract tests pass against both stores.
- [ ] A two-replica integration test confirms `listViewers` returns peers
      that registered against the other replica.
- [ ] Rolling-restart scenarios do not drop active heartbeats (Redis TTL
      survives replica restarts).
- [ ] The 25-viewer cap is enforced in the Redis path (Redis returns the most
      recent 25, ordered by `lastSeenAtUtc`).
- [ ] No PII (IP, device, route history) is persisted to Redis — only the
      operator-safe fields documented in the G3 runbook
      (`userId`, `displayName`, `lastSeenAtUtc`).
