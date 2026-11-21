/**
 * PRO-G2-01 — GROUND-TRUTH SAMPLE: what an issued verification package's
 * `intelligence/*.json` trust manifests actually carry. Pure (no I/O).
 *
 * A minimal, read-only ZIP reader (central directory; stored or deflated
 * entries; ZIP64 sizes refused) extracts ONLY the four trust manifests the old
 * builder wrote. Nothing else in the package is decompressed or returned:
 * no evidence, report or signature bytes leave this function.
 */
import { inflateRawSync } from "node:zlib";

export const TRUST_MANIFEST_PATHS = [
  "intelligence/trust-manifest.json",
  "intelligence/methodology-manifest.json",
  "intelligence/ai-disclosure-manifest.json",
  "intelligence/subprocessor-manifest.json",
] as const;

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export class ZipReadError extends Error {}

/** Reads bytes [start, end] (inclusive) of the archive. */
export type RangeReader = { size: number; read: (start: number, endInclusive: number) => Promise<Buffer> };

export function bufferRangeReader(zip: Buffer): RangeReader {
  return { size: zip.length, read: async (a, b) => zip.subarray(a, b + 1) };
}

/**
 * Extract the named entries from a ZIP through RANGE reads: the tail (end of
 * central directory), the central directory, then only the wanted entries.
 * A multi-gigabyte package is never read whole. Unknown entries are skipped unread.
 */
export async function extractZipEntries(src: RangeReader, wanted: readonly string[]): Promise<Map<string, Buffer>> {
  const want = new Set(wanted);
  if (src.size < 22) throw new ZipReadError("not a zip archive (too small)");
  const tailStart = Math.max(0, src.size - 65_557);
  const tail = await src.read(tailStart, src.size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError("not a zip archive (no end-of-central-directory record)");
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
    throw new ZipReadError("zip64 archives are not supported by this inspector");
  }
  const cd = await src.read(cdOffset, cdOffset + cdSize - 1);
  const out = new Map<string, Buffer>();
  let p = 0;
  for (let n = 0; n < entries; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipReadError("corrupt central directory");
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!want.has(name)) continue;
    if (size > MAX_MANIFEST_BYTES || compressedSize > MAX_MANIFEST_BYTES) throw new ZipReadError(`${name} is larger than a manifest can be`);
    const local = await src.read(localOffset, localOffset + 29);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipReadError("corrupt local header");
    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = compressedSize > 0 ? await src.read(dataStart, dataStart + compressedSize - 1) : Buffer.alloc(0);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES });
    else throw new ZipReadError(`${name}: unsupported compression method ${method}`);
    out.set(name, data);
  }
  return out;
}

export type ManifestArticle = { kind: "TRUST_CENTER" | "METHODOLOGY" | "AI_DISCLOSURE"; section: string; slug: string; title: string | null };
export type ManifestSubprocessor = { rowId: string; name: string | null; category: string | null; country: string | null };
export type PackageTrustManifests = {
  present: string[];
  articles: ManifestArticle[];
  subprocessors: ManifestSubprocessor[];
  activeSubprocessorCount: number | null;
};

function parse(buf: Buffer | undefined): Record<string, unknown> | null {
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>) : [];

/** Read the four trust manifests of one package ZIP (absent manifests are reported absent). */
export async function readPackageTrustManifests(src: RangeReader): Promise<PackageTrustManifests> {
  const files = await extractZipEntries(src, TRUST_MANIFEST_PATHS);
  const trust = parse(files.get(TRUST_MANIFEST_PATHS[0]));
  const methodology = parse(files.get(TRUST_MANIFEST_PATHS[1]));
  const ai = parse(files.get(TRUST_MANIFEST_PATHS[2]));
  const sub = parse(files.get(TRUST_MANIFEST_PATHS[3]));
  const articles: ManifestArticle[] = [
    ...arr(trust?.trustArticles).map((r) => ({ kind: "TRUST_CENTER" as const, section: str(r.section) ?? "", slug: str(r.slug) ?? "", title: str(r.title) })),
    ...arr(methodology?.sections).map((r) => ({ kind: "METHODOLOGY" as const, section: str(r.section) ?? "", slug: str(r.slug) ?? "", title: null })),
    ...arr(ai?.sections).map((r) => ({ kind: "AI_DISCLOSURE" as const, section: str(r.section) ?? "", slug: str(r.slug) ?? "", title: null })),
  ];
  const subprocessors = arr(sub?.subprocessors).map((r) => ({
    rowId: str(r.slug) ?? "",
    name: str(r.name),
    category: str(r.vendor),
    country: str(r.region),
  }));
  const count = trust?.activeSubprocessorCount;
  return {
    present: TRUST_MANIFEST_PATHS.filter((p) => files.has(p)),
    articles,
    subprocessors,
    activeSubprocessorCount: typeof count === "number" ? count : null,
  };
}
