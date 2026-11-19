/**
 * WS-REL / PRO-K2-20 — creating an evidence discussion thread is all-or-nothing
 * with its audit row, a refused first message leaves no thread, the record is
 * found through the canonical workspace predicate, and writes are throttled
 * per actor.
 *
 * The real discussion service over an in-memory client; the workspace
 * predicate is the double (the real one reads the workspace kind).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@proovra/shared-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@proovra/shared-runtime")>()),
  workspaceEvidenceWhere: async (teamId: string) => ({ OR: [{ teamId }, { teamId: null, ownerUserId: "owner" }] }),
}));

import { DiscussionError, createDiscussionThread } from "../src/services/collaboration/discussion.service.js";

type Row = Record<string, unknown> & { id: string };
const db = {
  threads: [] as Row[],
  participants: [] as Row[],
  messages: [] as Row[],
  audits: [] as Row[],
  evidenceWhere: null as unknown,
  failMessageCreate: false,
};
let seq = 0;
const id = () => `id-${++seq}`;

function model(rows: () => Row[], opts: { onCreate?: (r: Row) => void } = {}) {
  return {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const r = { id: id(), createdAt: new Date(), updatedAt: new Date(), status: "OPEN", ...data };
      opts.onCreate?.(r);
      rows().push(r);
      return r;
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      rows().filter((r) => Object.entries(where).every(([k, v]) => (typeof v === "object" && v !== null ? true : r[k] === v))).length,
    findUnique: async ({ where }: { where: { id: string } }) => rows().find((r) => r.id === where.id) ?? null,
    update: async ({ where }: { where: { id: string } }) => rows().find((r) => r.id === where.id),
    deleteMany: async ({ where }: { where: Record<string, string> }) => {
      const before = rows().length;
      const keep = rows().filter((r) => !Object.entries(where).every(([k, v]) => r[k] === v));
      rows().splice(0, rows().length, ...keep);
      return { count: before - keep.length };
    },
  };
}

const client = {
  evidence: {
    findFirst: async (args: { where: unknown }) => {
      db.evidenceWhere = args.where;
      return { id: "ev-1", deletedAt: null };
    },
  },
  discussionThread: model(() => db.threads),
  discussionParticipant: model(() => db.participants),
  discussionMessage: model(() => db.messages, {
    onCreate: () => {
      if (db.failMessageCreate) throw new Error("db fault");
    },
  }),
  evidenceReviewerAuditEvent: model(() => db.audits),
  teamMember: { findMany: async () => [] },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = { t: [...db.threads], p: [...db.participants], a: [...db.audits] };
    try {
      return await fn(client);
    } catch (err) {
      db.threads = snapshot.t;
      db.participants = snapshot.p;
      db.audits = snapshot.a;
      throw err;
    }
  },
};

const input = (over: Record<string, unknown> = {}) => ({
  teamId: "team-1",
  evidenceId: "ev-1",
  kind: "QUESTION" as never,
  visibility: "INTERNAL" as never,
  title: "A question",
  createdByUserId: "u1",
  ...over,
});

beforeEach(() => {
  db.threads = [];
  db.participants = [];
  db.messages = [];
  db.audits = [];
  db.failMessageCreate = false;
});

describe("PRO-K2-20 discussion thread creation", () => {
  it("thread, participant and audit row are written together", async () => {
    const t = await createDiscussionThread(input(), client as never);
    expect(db.threads).toHaveLength(1);
    expect(db.participants).toHaveLength(1);
    expect(db.audits.filter((a) => a.eventType === "DISCUSSION_THREAD_CREATED" && (a.metadata as { threadId: string }).threadId === t.id)).toHaveLength(1);
  });

  it("a refused first message (nothing left after sanitising) writes nothing", async () => {
    await expect(createDiscussionThread(input({ initialBody: "" }), client as never)).rejects.toBeInstanceOf(DiscussionError);
    expect(db.threads).toHaveLength(0);
    expect(db.participants).toHaveLength(0);
  });

  it("a first message that fails after the thread committed leaves no empty thread", async () => {
    db.failMessageCreate = true;
    await expect(createDiscussionThread(input({ initialBody: "hello" }), client as never)).rejects.toThrow("db fault");
    expect(db.threads).toHaveLength(0);
    expect(db.participants).toHaveLength(0);
  });

  it("the record is looked up through the canonical workspace predicate", async () => {
    await createDiscussionThread(input(), client as never);
    expect(JSON.stringify(db.evidenceWhere)).toContain("\"teamId\":null");
  });

  it("a member creating threads past the per-minute cap is refused rate_limited", async () => {
    for (let i = 0; i < 20; i += 1) await createDiscussionThread(input(), client as never);
    await expect(createDiscussionThread(input(), client as never)).rejects.toMatchObject({ code: "rate_limited" });
    expect(db.threads).toHaveLength(20);
  });
});
