import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "./config";

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

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

export async function putObjectBuffer(params: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}) {
  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    })
  );
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
