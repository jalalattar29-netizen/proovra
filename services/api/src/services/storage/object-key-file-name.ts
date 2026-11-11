/**
 * THE file-name fragment that goes into an evidence object key.
 *
 * Object stores bound each path SEGMENT to 255 BYTES (MinIO answers
 * `XMinioInvalidObjectName`; S3 bounds the whole key to 1024 bytes). The last
 * segment of an evidence key is `000-<name>` or `original-<name>`, and names
 * were bounded in CHARACTERS: 180 Arabic or Hebrew characters are 360 bytes,
 * so such a name passed creation and failed only at the storage PUT, leaving
 * the record UPLOADING (AUD-0054).
 *
 * The key does not need the whole name. It is unique without it (the evidence
 * id and part index guarantee that) and only has to be recognisable in a bucket
 * listing. The DISPLAY name stays whole in its column; only the key fragment is
 * bounded — in UTF-8 bytes, cut at a character boundary, keeping the extension.
 */
export const OBJECT_KEY_FILE_NAME_MAX_BYTES = 120;

const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Longest prefix of `s` (whole code points) within `maxBytes` UTF-8 bytes. */
function truncateUtf8(s: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

export function objectKeyFileNameFragment(
  fileName: string | null | undefined,
  maxBytes: number = OBJECT_KEY_FILE_NAME_MAX_BYTES,
): string | null {
  if (!fileName) return null;
  if (utf8Bytes(fileName) <= maxBytes) return fileName;
  const dot = fileName.lastIndexOf(".");
  const rawExt = dot > 0 && fileName.length - dot <= 12 ? fileName.slice(dot) : "";
  const ext = utf8Bytes(rawExt) < maxBytes / 2 ? rawExt : "";
  const stem = ext ? fileName.slice(0, dot) : fileName;
  const cut = truncateUtf8(stem, maxBytes - utf8Bytes(ext)).trim();
  return cut ? cut + ext : null;
}
