import * as FileSystem from "expo-file-system/legacy";

function cachePath(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${FileSystem.cacheDirectory ?? ""}${prefix}-${stamp}`;
}

export async function ensureFileUri(uri: string) {
  if (uri.startsWith("content://") || uri.startsWith("ph://")) {
    const target = cachePath("proovra-upload");
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  }
  return uri;
}

export async function uploadWithPut(params: {
  putUrl: string;
  uri: string;
  mimeType: string;
}) {
  const fileUri = await ensureFileUri(params.uri);
  const result = await FileSystem.uploadAsync(params.putUrl, fileUri, {
    httpMethod: "PUT",
    headers: { "content-type": params.mimeType },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT
  });
  if (![200, 201, 204].includes(result.status)) {
    throw new Error(`Upload failed (${result.status})`);
  }
  return { status: result.status, fileUri };
}
