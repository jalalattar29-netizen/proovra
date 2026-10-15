/**
 * AUD-011 — THE ONE STORAGE-FAILURE CLASSIFIER, by HTTP status and error name
 * (never by message text). The behaviour against a real store — an
 * unreachable endpoint, wrong credentials, a removed version — is proven in
 * legacy-package-recovery.integration.test.ts; this pins the table.
 */
import { describe, expect, it } from "vitest";

import { StorageReadError, classifyStorageFailure } from "../src/storage.js";

const sdk = (name: string, httpStatusCode?: number, message = "") =>
  Object.assign(new Error(message), { name, $metadata: httpStatusCode ? { httpStatusCode } : {} });

describe("classifyStorageFailure", () => {
  it("a gone key or version is NOT_FOUND (404, NoSuchKey/NoSuchVersion, 405 delete marker)", () => {
    expect(classifyStorageFailure(sdk("NotFound", 404))).toBe("NOT_FOUND");
    expect(classifyStorageFailure(sdk("NoSuchKey", 404))).toBe("NOT_FOUND");
    expect(classifyStorageFailure(sdk("NoSuchVersion", 404))).toBe("NOT_FOUND");
    expect(classifyStorageFailure(sdk("MethodNotAllowed", 405))).toBe("NOT_FOUND");
    expect(classifyStorageFailure(sdk("Unknown", 404))).toBe("NOT_FOUND");
  });

  it("refusals and mis-addressing are ACCESS_DENIED, never missing", () => {
    expect(classifyStorageFailure(sdk("AccessDenied", 403))).toBe("ACCESS_DENIED");
    expect(classifyStorageFailure(sdk("Forbidden", 403))).toBe("ACCESS_DENIED");
    expect(classifyStorageFailure(sdk("InvalidAccessKeyId", 403))).toBe("ACCESS_DENIED");
    expect(classifyStorageFailure(sdk("SignatureDoesNotMatch", 403))).toBe("ACCESS_DENIED");
    expect(classifyStorageFailure(sdk("NoSuchBucket", 404))).toBe("ACCESS_DENIED");
    expect(classifyStorageFailure(sdk("InvalidArgument", 400))).toBe("ACCESS_DENIED");
    expect(classifyStorageFailure(sdk("PermanentRedirect", 301))).toBe("ACCESS_DENIED");
  });

  it("everything else is TRANSIENT — including a message that merely MENTIONS 404 or NotFound", () => {
    expect(classifyStorageFailure(sdk("InternalError", 500))).toBe("TRANSIENT");
    expect(classifyStorageFailure(sdk("SlowDown", 503))).toBe("TRANSIENT");
    expect(classifyStorageFailure(sdk("ThrottlingException", 429))).toBe("TRANSIENT");
    expect(classifyStorageFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))).toBe("TRANSIENT");
    expect(classifyStorageFailure(sdk("TimeoutError", undefined, "socket hang up after NotFound 404 retry"))).toBe("TRANSIENT");
    expect(classifyStorageFailure(null)).toBe("TRANSIENT");
  });

  it("a classified read error keeps its class (bucket-confirmed)", () => {
    expect(classifyStorageFailure(new StorageReadError("ACCESS_DENIED", 404))).toBe("ACCESS_DENIED");
  });
});
