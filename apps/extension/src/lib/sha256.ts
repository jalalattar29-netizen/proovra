/** SHA-256 (lowercase hex) via Web Crypto — the digest the client declares. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  let buf: ArrayBuffer;
  if (typeof bytes === "string") {
    buf = new TextEncoder().encode(bytes).buffer as ArrayBuffer;
  } else if (bytes instanceof Uint8Array) {
    buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } else {
    buf = bytes;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
