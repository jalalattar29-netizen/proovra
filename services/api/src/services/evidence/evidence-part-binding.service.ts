/**
 * F-03 (Free-user audit, 2026-11-13) — WHICH FILE A PART INDEX IS BOUND TO.
 *
 * A web capture reserves its record before any byte moves, then presigns one
 * part per staged file. A retry after a failed finalize used to resume into
 * the same record whatever the staged set had become: the parts route returned
 * the row already issued for an index (its name, private note, role and
 * checklist step) and signed the NEW file's checksum into its URL, so one
 * file's bytes were sealed under another file's metadata, and a removed file's
 * row stayed at the tail and was sealed too.
 *
 * A part row is bound, from its first presign, to the file declared for it:
 * its sanitised name, its normalised type and — when the client stated one —
 * the SHA-256 it hashed when the file was staged (web capture's
 * `clientSignals.clientHintSha256Base64`). These pure checks are the one rule
 * for that binding:
 *   - a repeated presign for an index is the SAME file or it is refused;
 *   - a draft's reserved record is resumed only while every part it holds is
 *     still the file the new Finish declares at that index;
 *   - at the seal, the bytes the server hashed must be the bytes the part was
 *     bound to (the declared digest is a claim to check, never a substitute
 *     for the server hash).
 * Callers normalise names and types with their own route helpers first.
 */

export type DeclaredPartFile = {
  originalFileName: string | null;
  mimeType: string | null;
  /** Standard base64 SHA-256 of the file's bytes, when the client stated one. */
  sha256Base64: string | null;
};

export type BoundPartRow = {
  partIndex: number;
  originalFileName: string | null;
  mimeType: string | null;
  clientSignals: unknown;
};

/** Hex of a base64 SHA-256 digest, or null when it is not a 32-byte digest. */
export function sha256Base64ToHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.length === 32 ? bytes.toString("hex") : null;
}

/** The staged-file digest a part row was bound with, as hex; null when none was stated. */
export function boundPartDigestHex(clientSignals: unknown): string | null {
  if (!clientSignals || typeof clientSignals !== "object" || Array.isArray(clientSignals)) return null;
  return sha256Base64ToHex((clientSignals as { clientHintSha256Base64?: unknown }).clientHintSha256Base64 as string);
}

/** True when `declared` is the file the row was bound to. */
export function isSameBoundFile(row: Omit<BoundPartRow, "partIndex">, declared: DeclaredPartFile): boolean {
  if ((row.originalFileName ?? null) !== (declared.originalFileName ?? null)) return false;
  if ((row.mimeType ?? null) !== (declared.mimeType ?? null)) return false;
  const bound = boundPartDigestHex(row.clientSignals);
  // A row bound to a digest is the same file only when the same digest is
  // declared again: a name and a size do not identify bytes.
  if (bound) return sha256Base64ToHex(declared.sha256Base64) === bound;
  return true;
}

/**
 * True when a reserved record may be resumed for `manifest` (the files of the
 * new Finish, in part-index order): every part the record already holds is the
 * file now declared at its index. Appending files keeps the record; removing,
 * reordering or replacing one does not.
 */
export function boundPartsMatchManifest(rows: readonly BoundPartRow[], manifest: readonly DeclaredPartFile[]): boolean {
  return rows.every((row) => {
    const declared = manifest[row.partIndex];
    return declared !== undefined && isSameBoundFile(row, declared);
  });
}

/** True unless the row was bound to a digest the stored bytes (server hash, hex) do not have. */
export function storedBytesMatchBoundDigest(clientSignals: unknown, serverSha256Hex: string): boolean {
  const bound = boundPartDigestHex(clientSignals);
  return bound === null || bound === serverSha256Hex.trim().toLowerCase();
}
