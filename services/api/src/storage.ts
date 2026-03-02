import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function clean(v: string | undefined | null): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t ? t : null;
}

function requireTls(endpoint: string, name: string) {
  const allowInsecure = process.env.S3_ALLOW_INSECURE === "true";
  if (process.env.NODE_ENV === "production" && endpoint.startsWith("http://") && !allowInsecure) {
    throw new Error(`${name} must use https in production`);
  }
}

/**
 * Cloudflare R2 / S3 endpoints:
 * - S3_ENDPOINT: what the server uses to talk to storage (must be reachable from API container).
 * - S3_PUBLIC_ENDPOINT (optional): what browsers should open (must be publicly reachable https).
 *
 * If S3_PUBLIC_ENDPOINT is set, we will rewrite the returned presigned URL origin to it,
 * while keeping path + query (signature) intact.
 */
const endpoint = must("S3_ENDPOINT");
requireTls(endpoint, "S3_ENDPOINT");

const publicEndpoint = clean(process.env.S3_PUBLIC_ENDPOINT);
if (publicEndpoint) requireTls(publicEndpoint, "S3_PUBLIC_ENDPOINT");

const region = clean(process.env.S3_REGION) ?? "auto";

// NOTE:
// - Cloudflare R2 usually works with forcePathStyle: true (bucket in path).
// - Keep it configurable.
const forcePathStyle =
  clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase() === "false" ? false : true;

export const s3 = new S3Client({
  region,
  endpoint,
  credentials: {
    accessKeyId: must("S3_ACCESS_KEY"),
    secretAccessKey: must("S3_SECRET_KEY"),
  },
  forcePathStyle,
});

function rewriteToPublicEndpointIfNeeded(signedUrl: string): string {
  if (!publicEndpoint) return signedUrl;

  // Ensure both URLs parse
  const signed = new URL(signedUrl);
  const pub = new URL(publicEndpoint);

  // Replace scheme/host/port to public endpoint, keep pathname + search from signed URL
  signed.protocol = pub.protocol;
  signed.username = pub.username;
  signed.password = pub.password;
  signed.host = pub.host; // includes hostname:port

  return signed.toString();
}

export async function presignPutObject(params: {
  bucket: string;
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);
  const contentType = clean(params.contentType);

  if (!bucket || !key || !contentType) {
    throw new Error("presignPutObject: bucket/key/contentType are required");
  }

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const signed = await getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 600 });
  return rewriteToPublicEndpointIfNeeded(signed);
}

export async function presignGetObject(params: {
  bucket: string;
  key: string;
  expiresInSeconds?: number;

  /**
   * If provided, we will force the browser to download with this filename.
   * Example: "report-<evidenceId>.pdf"
   */
  downloadName?: string;

  /**
   * If provided, we will hint content-type for browsers.
   * Example: "application/pdf"
   */
  responseContentType?: string;
}) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("presignGetObject: bucket/key are required");
  }

  // Force download if asked (important for PDFs)
  const disposition = params.downloadName
    ? `attachment; filename="${params.downloadName.replace(/"/g, "")}"`
    : undefined;

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: disposition,
    ResponseContentType: params.responseContentType ?? undefined,
  });

  const signed = await getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 600 });
  return rewriteToPublicEndpointIfNeeded(signed);
}

export async function headObject(params: { bucket: string; key: string }) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("headObject: bucket/key are required");
  }

  const res = await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return {
    sizeBytes: res.ContentLength ?? null,
    contentType: res.ContentType ?? null,
    etag: res.ETag ?? null,
  };
}

export async function getObjectStream(params: {
  bucket: string;
  key: string;
}): Promise<NodeJS.ReadableStream> {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("getObjectStream: bucket/key are required");
  }

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!res.Body) throw new Error("S3 returned empty body");
  return res.Body as unknown as NodeJS.ReadableStream;
}