import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  endpoint: must("S3_ENDPOINT"),
  credentials: {
    accessKeyId: must("S3_ACCESS_KEY"),
    secretAccessKey: must("S3_SECRET_KEY"),
  },
  forcePathStyle: true,
});

export async function presignPutObject(params: {
  bucket: string;
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ContentType: params.contentType,
  });

  return getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 600 });
}

export async function presignGetObject(params: {
  bucket: string;
  key: string;
  expiresInSeconds?: number;
}) {
  const cmd = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
  });

  return getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 600 });
}

export async function headObject(params: { bucket: string; key: string }) {
  const res = await s3.send(
    new HeadObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
    })
  );
  return {
    sizeBytes: res.ContentLength ?? null,
    contentType: res.ContentType ?? null,
    etag: res.ETag ?? null,
  };
}

export async function getObjectStream(params: { bucket: string; key: string }) {
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
    })
  );
  if (!res.Body) throw new Error("S3 returned empty body");
  return res.Body; // Node.js Readable
}
