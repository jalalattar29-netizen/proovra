/**
 * THE IMMUTABLE-PUBLICATION BOUNDARY, MODELLED (2026-09-29).
 *
 * Reports and packages are no longer written through `putObjectBuffer` /
 * `putObjectFromFile` + `copyObject`: `publishImmutableArtifact` sends ONE
 * `PutObjectCommand` (ChecksumSHA256 + IfNoneMatch "*") and reads the exact
 * version back with a checksum-enabled `HeadObjectCommand`, straight on the
 * worker's S3 client. A suite that doubles `storage.js` must therefore double
 * that client too, or publication reaches ambient infrastructure.
 *
 * This models the store the suite already keeps, with the rules the real
 * boundary enforces (the ones MinIO and AWS enforce the same way):
 *   - a conditional PUT to an occupied key answers 412 PreconditionFailed;
 *   - a body whose SHA-256 differs from ChecksumSHA256 answers 400 BadDigest;
 *   - every accepted PUT gets a fresh VersionId;
 *   - HEAD returns the stored length and checksum (Object Lock off, as the
 *     fixture environment declares).
 * `onPut` / `onHead` let a suite inject a failure before the write, or after
 * it and before the read-back proves it.
 */
import { createHash, randomUUID } from "node:crypto";

type StoredObject = {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string> | null;
  checksumSha256?: string | null;
  versionId?: string;
  [extra: string]: unknown;
};

export type PublicationStore = {
  objects: Map<string, StoredObject>;
  served: string[];
  at(bucket: string, key: string): string;
};

function s3Error(name: string, status: number, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    Code: name,
    $metadata: { httpStatusCode: status },
  });
}

async function readBody(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("publication double: unsupported body");
}

export function publicationS3Double(
  store: PublicationStore,
  hooks: {
    onPut?: (key: string) => void | Promise<void>;
    /** Runs before the read-back HEAD: a failure here is "uploaded, not yet proven". */
    onHead?: (key: string) => void | Promise<void>;
  } = {},
) {
  return {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const input = command.input;
      const bucket = String(input.Bucket);
      const key = String(input.Key);
      const id = store.at(bucket, key);
      if (name === "PutObjectCommand") {
        store.served.push("publishImmutableArtifact.put");
        await hooks.onPut?.(key);
        if (input.IfNoneMatch === "*" && store.objects.has(id)) {
          throw s3Error("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold");
        }
        const body = await readBody(input.Body);
        if (body.length <= 0) throw s3Error("InvalidRequest", 400, "empty body");
        const checksum = createHash("sha256").update(body).digest("base64");
        if (input.ChecksumSHA256 && input.ChecksumSHA256 !== checksum) {
          throw s3Error("BadDigest", 400, "The SHA256 you specified did not match the calculated checksum");
        }
        const versionId = randomUUID();
        store.objects.set(id, {
          body,
          contentType: String(input.ContentType ?? "application/octet-stream"),
          metadata: (input.Metadata as Record<string, string>) ?? null,
          checksumSha256: checksum,
          versionId,
          immutable: true,
        });
        return { VersionId: versionId, ETag: `"${body.length}"` };
      }
      if (name === "HeadObjectCommand") {
        store.served.push("publishImmutableArtifact.head");
        await hooks.onHead?.(key);
        const o = store.objects.get(id);
        if (!o || (input.VersionId && o.versionId && input.VersionId !== o.versionId)) {
          throw s3Error("NotFound", 404, `NotFound: ${key}`);
        }
        return {
          VersionId: o.versionId,
          ContentLength: o.body.length,
          ContentType: o.contentType,
          ChecksumSHA256: o.checksumSha256 ?? createHash("sha256").update(o.body).digest("base64"),
          Metadata: o.metadata ?? undefined,
        };
      }
      throw new Error(`publication double: ${name} is not part of this suite's storage boundary`);
    },
  };
}
