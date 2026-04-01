import * as FileSystem from "expo-file-system";

function cachePath(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${FileSystem.cacheDirectory ?? ""}${prefix}-${stamp}`;
}

function ensureWebCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available on this device/runtime");
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return globalThis.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");

  if (clean.length % 4 !== 0) {
    throw new Error("Invalid base64 input");
  }

  let padding = 0;
  if (clean.endsWith("==")) padding = 2;
  else if (clean.endsWith("=")) padding = 1;

  const outputLength = (clean.length / 4) * 3 - padding;
  const out = new Uint8Array(outputLength);

  let outIndex = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c1 = clean[i];
    const c2 = clean[i + 1];
    const c3 = clean[i + 2];
    const c4 = clean[i + 3];

    const e1 = chars.indexOf(c1);
    const e2 = chars.indexOf(c2);
    const e3 = c3 === "=" ? 0 : chars.indexOf(c3);
    const e4 = c4 === "=" ? 0 : chars.indexOf(c4);

    if (e1 < 0 || e2 < 0 || (c3 !== "=" && e3 < 0) || (c4 !== "=" && e4 < 0)) {
      throw new Error("Invalid base64 input");
    }

    const triple = (e1 << 18) | (e2 << 12) | (e3 << 6) | e4;

    if (outIndex < outputLength) out[outIndex++] = (triple >> 16) & 0xff;
    if (outIndex < outputLength) out[outIndex++] = (triple >> 8) & 0xff;
    if (outIndex < outputLength) out[outIndex++] = triple & 0xff;
  }

  return out;
}

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function md5ArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(buffer);
  const originalLength = input.length;
  const bitLength = originalLength * 8;

  const paddedLength = (((originalLength + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[originalLength] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(
    paddedLength - 4,
    Math.floor(bitLength / 0x100000000) >>> 0,
    true
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const k = new Array<number>(64)
    .fill(0)
    .map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const m = new Array<number>(16);
    for (let i = 0; i < 16; i += 1) {
      m[i] = view.getUint32(offset + i * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const tmp = d;
      d = c;
      c = b;

      const sum = (((a + f) >>> 0) + ((k[i] + m[g]) >>> 0)) >>> 0;
      b = (b + leftRotate(sum, s[i])) >>> 0;
      a = tmp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new ArrayBuffer(16);
  const outView = new DataView(out);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

export async function ensureFileUri(uri: string) {
  if (uri.startsWith("content://") || uri.startsWith("ph://")) {
    const target = cachePath("proovra-upload");
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  }
  return uri;
}

export async function computeFileIntegrityBase64(uri: string) {
  ensureWebCrypto();

  const fileUri = await ensureFileUri(uri);
  const base64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const bytes = base64ToBytes(base64);
  const exactBuffer = bytesToArrayBuffer(bytes);

  const sha256Digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    exactBuffer
  );

  const md5Digest = md5ArrayBuffer(exactBuffer);

  return {
    fileUri,
    checksumSha256Base64: arrayBufferToBase64(sha256Digest),
    contentMd5Base64: arrayBufferToBase64(md5Digest),
  };
}

export async function uploadWithPut(params: {
  putUrl: string;
  uri: string;
  mimeType: string;
  checksumSha256Base64?: string;
  contentMd5Base64?: string;
}) {
  const prepared =
    params.checksumSha256Base64 && params.contentMd5Base64
      ? {
          fileUri: await ensureFileUri(params.uri),
          checksumSha256Base64: params.checksumSha256Base64,
          contentMd5Base64: params.contentMd5Base64,
        }
      : await computeFileIntegrityBase64(params.uri);

  const result = await FileSystem.uploadAsync(params.putUrl, prepared.fileUri, {
    httpMethod: "PUT",
    headers: {
      "content-type": params.mimeType,
      "x-amz-checksum-sha256": prepared.checksumSha256Base64,
      "Content-MD5": prepared.contentMd5Base64,
    },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  if (![200, 201, 204].includes(result.status)) {
    throw new Error(`Upload failed (${result.status})`);
  }

  return {
    status: result.status,
    fileUri: prepared.fileUri,
    checksumSha256Base64: prepared.checksumSha256Base64,
    contentMd5Base64: prepared.contentMd5Base64,
  };
}