import * as FileSystem from "expo-file-system";
import { Buffer } from "buffer";

function cachePath(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${FileSystem.cacheDirectory ?? ""}${prefix}-${stamp}`;
}

function ensureWebCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available on this device/runtime");
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buffer)).toString("base64");
}

export async function ensureFileUri(uri: string) {
  if (uri.startsWith("content://") || uri.startsWith("ph://")) {
    const target = cachePath("proovra-upload");
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  }
  return uri;
}

export async function computeFileChecksumSha256Base64(uri: string) {
  ensureWebCrypto();

  const fileUri = await ensureFileUri(uri);
  const base64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const bytes = Buffer.from(base64, "base64");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);

  return {
    fileUri,
    checksumSha256Base64: arrayBufferToBase64(digest),
  };
}

export async function uploadWithPut(params: {
  putUrl: string;
  uri: string;
  mimeType: string;
  checksumSha256Base64?: string;
}) {
  const prepared = params.checksumSha256Base64
    ? {
        fileUri: await ensureFileUri(params.uri),
        checksumSha256Base64: params.checksumSha256Base64,
      }
    : await computeFileChecksumSha256Base64(params.uri);

  const result = await FileSystem.uploadAsync(params.putUrl, prepared.fileUri, {
    httpMethod: "PUT",
    headers: {
      "content-type": params.mimeType,
      "x-amz-checksum-sha256": prepared.checksumSha256Base64,
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
  };
}