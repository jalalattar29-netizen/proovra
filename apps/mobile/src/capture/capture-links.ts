/**
 * LINKED RECORDS — separate evidence captured together (product decision 3).
 *
 * A screen recording is sealed as its own evidence record: its session states
 * one origin, and a photo taken with the camera cannot honestly share it. When
 * the person adds a photo or file beside a staged recording, it is staged into
 * a NEW record, and the two are tied together here. Once BOTH have sealed, the
 * link is created through the existing evidence relationships API
 * (`POST /v1/evidence/:id/relationships`, evidence.routes.ts) — never before,
 * so a discarded half never leaves a relationship to a record that does not
 * exist.
 *
 * The pending links are durable and per user, like every other capture record:
 * the two records may seal minutes or a restart apart.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiFetch } from "../api";
import { getCaptureSessionOwner } from "./capture-session-store";

const KEY_PREFIX = "proovra.capture.links.v1:";

/** The relationship the server records between records captured together. */
export const CAPTURED_TOGETHER_RELATIONSHIP = "SAME_INCIDENT";
export const CAPTURED_TOGETHER_NOTE =
  "Captured together in one PROOVRA mobile capture session; kept as separate records because each states its own capture origin.";

export type LinkMember = {
  /** The record's identity in the capture store (draft id, else session id). */
  key: string;
  /** Set once the record is SEALED. */
  evidenceId: string | null;
};

export type LinkGroup = { id: string; members: LinkMember[] };

export function captureLinksKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function newLinkGroupId(): string {
  return `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ pure -- */

export function addLinkMember(groups: readonly LinkGroup[], groupId: string, key: string): LinkGroup[] {
  const found = groups.find((g) => g.id === groupId);
  if (!found) return [...groups, { id: groupId, members: [{ key, evidenceId: null }] }];
  if (found.members.some((m) => m.key === key)) return [...groups];
  return groups.map((g) => (g.id === groupId ? { ...g, members: [...g.members, { key, evidenceId: null }] } : g));
}

export function markLinkMemberSealed(
  groups: readonly LinkGroup[],
  groupId: string,
  key: string,
  evidenceId: string,
): LinkGroup[] {
  return groups.map((g) =>
    g.id === groupId ? { ...g, members: g.members.map((m) => (m.key === key ? { ...m, evidenceId } : m)) } : g,
  );
}

/** A discarded record leaves its group; a group of one links nothing and goes. */
export function dropLinkMember(groups: readonly LinkGroup[], groupId: string, key: string): LinkGroup[] {
  return groups
    .map((g) => (g.id === groupId ? { ...g, members: g.members.filter((m) => m.key !== key) } : g))
    .filter((g) => g.members.length >= 2 || (g.members.length === 1 && g.id !== groupId));
}

/**
 * The relationship requests a fully sealed group makes: the FIRST member (the
 * record the others were added beside) to each of the others. Null until
 * every member has sealed.
 */
export function linkRequestsFor(group: LinkGroup): Array<{ sourceEvidenceId: string; targetEvidenceId: string }> | null {
  if (group.members.length < 2) return null;
  if (group.members.some((m) => !m.evidenceId)) return null;
  const [first, ...rest] = group.members as Array<{ key: string; evidenceId: string }>;
  return rest.map((m) => ({ sourceEvidenceId: first.evidenceId, targetEvidenceId: m.evidenceId }));
}

export function parseLinkGroups(raw: unknown): LinkGroup[] {
  const rows = raw && typeof raw === "object" ? (raw as { groups?: unknown }).groups : null;
  if (!Array.isArray(rows)) return [];
  const out: LinkGroup[] = [];
  for (const r of rows) {
    const g = r && typeof r === "object" ? (r as Record<string, unknown>) : null;
    if (!g || typeof g.id !== "string" || !Array.isArray(g.members)) continue;
    const members = g.members
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : null))
      .filter((m): m is Record<string, unknown> => !!m && typeof m.key === "string" && !!m.key)
      .map((m) => ({ key: m.key as string, evidenceId: typeof m.evidenceId === "string" && m.evidenceId ? m.evidenceId : null }));
    out.push({ id: g.id, members });
  }
  return out;
}

/* -------------------------------------------------------------------- IO -- */

async function readGroups(owner: string): Promise<LinkGroup[]> {
  try {
    const raw = await AsyncStorage.getItem(captureLinksKey(owner));
    return raw ? parseLinkGroups(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

async function writeGroups(owner: string, groups: readonly LinkGroup[]): Promise<void> {
  try {
    await AsyncStorage.setItem(captureLinksKey(owner), JSON.stringify({ groups }));
  } catch {
    // Best-effort: the records themselves are unaffected.
  }
}

/** Record that `key` belongs to a group of records captured together. */
export async function registerLinkedRecord(groupId: string, key: string): Promise<void> {
  const owner = getCaptureSessionOwner();
  if (!owner) return;
  await writeGroups(owner, addLinkMember(await readGroups(owner), groupId, key));
}

/** A linked record was discarded before it sealed. */
export async function forgetLinkedRecord(groupId: string, key: string): Promise<void> {
  const owner = getCaptureSessionOwner();
  if (!owner) return;
  await writeGroups(owner, dropLinkMember(await readGroups(owner), groupId, key));
}

export type LinkOutcome = "LINKED" | "WAITING" | "FAILED" | "NONE";

/**
 * A linked record SEALED: remember it and, when every record of its group has
 * sealed, create the relationship(s). A failed request keeps the group, so the
 * next seal (or a later call) tries again; it never blocks the seal itself.
 */
export async function recordSealedAndLink(
  groupId: string,
  key: string,
  evidenceId: string,
  post: (sourceEvidenceId: string, targetEvidenceId: string) => Promise<unknown> = postCapturedTogether,
): Promise<LinkOutcome> {
  const owner = getCaptureSessionOwner();
  if (!owner) return "NONE";
  let groups = markLinkMemberSealed(await readGroups(owner), groupId, key, evidenceId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) return "NONE";
  const requests = linkRequestsFor(group);
  if (!requests) {
    await writeGroups(owner, groups);
    return "WAITING";
  }
  try {
    for (const r of requests) await post(r.sourceEvidenceId, r.targetEvidenceId);
  } catch {
    await writeGroups(owner, groups);
    return "FAILED";
  }
  groups = groups.filter((g) => g.id !== groupId);
  await writeGroups(owner, groups);
  return "LINKED";
}

export async function postCapturedTogether(sourceEvidenceId: string, targetEvidenceId: string): Promise<unknown> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(sourceEvidenceId)}/relationships`, {
    method: "POST",
    body: JSON.stringify({
      targetEvidenceId,
      relationshipType: CAPTURED_TOGETHER_RELATIONSHIP,
      note: CAPTURED_TOGETHER_NOTE,
    }),
  });
}
