/**
 * Minimal ZIP reader for test assertions on verification packages.
 *
 * Reads the central directory (so data-descriptor entries written by a
 * streaming archiver are sized correctly) and inflates stored (0) or deflated
 * (8) entries. Test-only: no ZIP64, no encryption, no multi-disk.
 */
import { inflateRawSync } from "node:zlib";

export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("readZipEntries: end of central directory not found");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("readZipEntries: bad central header");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    if (!name.endsWith("/")) {
      out.set(name, method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
