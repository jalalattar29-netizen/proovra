import { createHash } from "crypto";
import type { Readable } from "stream";

export async function sha256HexFromStream(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
