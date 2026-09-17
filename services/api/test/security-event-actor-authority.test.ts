/**
 * PV-AUD-001 — A SECURITY EVENT'S ACTOR COMES FROM THE EVENT, NEVER THE READER.
 *
 * The identity timeline projected `actorUserId: q.subjectUserId ?? null`: with
 * no filter every row read "System", and with `?subjectUserId=X` every row
 * claimed X had acted. `resolveSecurityEventActor` is now the one authority,
 * shared by the timeline and the security-events list. These cases pin what it
 * may conclude from what an event recorded — and, as importantly, what it may
 * not conclude when the event recorded nothing.
 *
 * The live-PostgreSQL proof that the ROUTE uses it (filters narrow, actors do
 * not move) is identity-timeline-actor-attribution.integration.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  MACHINE_AUTHORED_SECURITY_EVENTS,
  projectSecurityEvent,
  recordedActorDetails,
  resolveSecurityEventActor,
} from "../src/services/security/security-event.service.js";

const PERSON = "0adf0000-0000-4000-8000-000000000001";
const GRANT = "0adf0000-0000-4000-8000-0000000000aa";

describe("resolveSecurityEventActor", () => {
  it("a recorded actorUserId is a person", () => {
    expect(
      resolveSecurityEventActor({
        eventType: "sso_health_checked",
        details: { actorUserId: PERSON, overallStatus: "HEALTHY" },
      }),
    ).toEqual({ type: "HUMAN", userId: PERSON, supportGrantId: null, source: "RECORDED" });
  });

  it("an event that recorded no actor is NOT_RECORDED — never System by default", () => {
    const actor = resolveSecurityEventActor({
      eventType: "permission_denied",
      details: { reasonCode: "x" },
    });
    expect(actor).toEqual({ type: null, userId: null, supportGrantId: null, source: "NOT_RECORDED" });
    expect(actor.type).not.toBe("SYSTEM");
  });

  it("null and non-object details are NOT_RECORDED, not a crash", () => {
    for (const details of [null, undefined, "text", 7, [PERSON]]) {
      expect(resolveSecurityEventActor({ eventType: "permission_denied", details }).source).toBe(
        "NOT_RECORDED",
      );
    }
  });

  it("an actorUserId that is not a UUID is not promoted to a person", () => {
    expect(
      resolveSecurityEventActor({
        eventType: "permission_denied",
        details: { actorUserId: "public/system" },
      }).source,
    ).toBe("NOT_RECORDED");
  });

  it("a stated actorType wins, so a writer can say what kind of thing acted", () => {
    expect(
      resolveSecurityEventActor({
        eventType: "sso_health_checked",
        details: { actorType: "WORKER" },
      }),
    ).toEqual({ type: "WORKER", userId: null, supportGrantId: null, source: "RECORDED" });
  });

  it("an unknown stated actorType is ignored rather than trusted", () => {
    expect(
      resolveSecurityEventActor({
        eventType: "sso_health_checked",
        details: { actorType: "ADMINISTRATOR", actorUserId: PERSON },
      }).type,
    ).toBe("HUMAN");
  });

  it("a support operator acting under a grant is SUPPORT_CONTEXT, not the customer", () => {
    expect(
      resolveSecurityEventActor({
        eventType: "session_revoked_admin",
        details: { actorUserId: PERSON, supportGrantId: GRANT },
      }),
    ).toEqual({ type: "SUPPORT_CONTEXT", userId: PERSON, supportGrantId: GRANT, source: "RECORDED" });
    // Break-glass grants are named the same way.
    expect(
      resolveSecurityEventActor({
        eventType: "session_revoked_admin",
        details: { actorUserId: PERSON, breakGlassGrantId: GRANT },
      }).type,
    ).toBe("SUPPORT_CONTEXT");
  });

  it("a machine-authored event type is attributed by its writer, marked as derived", () => {
    for (const [eventType, kind] of Object.entries(MACHINE_AUTHORED_SECURITY_EVENTS)) {
      expect(resolveSecurityEventActor({ eventType, details: {} })).toEqual({
        type: kind,
        userId: null,
        supportGrantId: null,
        source: "EVENT_AUTHORITY",
      });
    }
  });

  it("recordedActorDetails round-trips through the resolver", () => {
    expect(
      resolveSecurityEventActor({
        eventType: "sso_connection_updated",
        details: recordedActorDetails({ userId: PERSON }),
      }),
    ).toMatchObject({ type: "HUMAN", userId: PERSON, source: "RECORDED" });
    expect(
      resolveSecurityEventActor({
        eventType: "sso_connection_updated",
        details: recordedActorDetails({ userId: PERSON, supportGrantId: GRANT }),
      }),
    ).toMatchObject({ type: "SUPPORT_CONTEXT", userId: PERSON, supportGrantId: GRANT });
  });
});

describe("projectSecurityEvent carries the same actor", () => {
  it("the list projection and the resolver cannot disagree", () => {
    const row = {
      id: "0adf0000-0000-4000-8000-0000000000e1",
      teamId: "0adf0000-0000-4000-8000-0000000000b1",
      userId: null,
      eventType: "sso_health_checked",
      severity: "INFO",
      details: { actorUserId: PERSON, overallStatus: "HEALTHY" },
      ipAddressHash: null,
      userAgent: null,
      requestId: null,
      createdAt: new Date("2026-09-10T10:00:00Z"),
    } as unknown as Parameters<typeof projectSecurityEvent>[0];
    const projected = projectSecurityEvent(row);
    expect(projected.actor).toEqual(resolveSecurityEventActor(row));
    // The actor id is NOT smuggled back out through the details allow-list.
    expect(projected.details).not.toHaveProperty("actorUserId");
  });
});
