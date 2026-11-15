/**
 * F-P1-08 (Free-user audit of 4d9b78963) — the web capture's single-PUT part
 * upload follows THE shared storage-PUT retry rule (@proovra/shared
 * storage-put-retry), as native and the extension do.
 *
 * Before: 3 attempts at 500/1000 ms, 429 terminal like every 4xx, an expired
 * URL (403) never re-presigned, and `xhr.status === 0` in onload read as
 * success — a PUT that never reached storage was reported uploaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const presigns: Array<Record<string, unknown>> = [];
vi.mock("../../lib/api", () => ({
  apiFetch: async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    presigns.push(body);
    return { part: { id: "p-0" }, upload: { putUrl: `https://s3.test/put?n=${presigns.length}` } };
  },
  readApiToken: () => null,
}));
vi.mock("../../app/(app)/capture/_lib/hash-utils", () => ({
  computeIntegrityFromBlob: async () => ({
    checksumSha256Base64: "c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2g=",
    contentMd5Base64: "bWQ1bWQ1bWQ1bWQ1bWQ1bQ==",
  }),
}));

import { uploadLegacyPart } from "../../app/(app)/capture/_hooks/legacy-part-upload";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

type Answer = { status: number; retryAfter?: string; event?: "error" | "timeout" };
let answers: Answer[] = [];
const putUrls: string[] = [];

class ScriptedXhr {
  status = 0;
  timeout = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private retryAfter: string | null = null;
  open(_m: string, url: string) {
    putUrls.push(url);
  }
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return name.toLowerCase() === "retry-after" ? this.retryAfter : null;
  }
  send() {
    const a = answers.shift() ?? { status: 200 };
    this.status = a.status;
    this.retryAfter = a.retryAfter ?? null;
    queueMicrotask(() => {
      if (a.event === "error") this.onerror?.();
      else if (a.event === "timeout") this.ontimeout?.();
      else this.onload?.();
    });
  }
}

const item = {
  id: "1",
  file: new File(["x".repeat(10)], "a.pdf", { type: "application/pdf" }),
  previewUrl: null,
  mimeType: "application/pdf",
  relativePath: null,
  uploadProgress: 0,
  uploading: false,
  error: null,
  checklistStepId: null,
} as SessionItem;

const waits: number[] = [];
const run = () =>
  uploadLegacyPart({
    evidenceId: "ev-1",
    index: 0,
    item,
    locationIncluded: false,
    onProgress: () => {},
    deps: { sleep: async (ms) => void waits.push(ms), random: () => 0 },
  });

beforeEach(() => {
  answers = [];
  putUrls.length = 0;
  presigns.length = 0;
  waits.length = 0;
  vi.stubGlobal("XMLHttpRequest", ScriptedXhr as unknown as typeof XMLHttpRequest);
});
afterEach(() => vi.unstubAllGlobals());

describe("F-P1-08 — web legacy storage PUT retry", () => {
  it("408 / 425 / 429 / 5xx are retried with backoff, on the same URL", async () => {
    answers = [{ status: 429 }, { status: 503 }, { status: 425 }];
    await run();
    expect(putUrls).toHaveLength(4);
    expect(new Set(putUrls).size).toBe(1);
    expect(presigns).toHaveLength(1);
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it("403 (the URL expired) presigns the same part again, then PUTs to the new URL", async () => {
    answers = [{ status: 403 }];
    await run();
    expect(presigns).toHaveLength(2);
    expect(presigns[1]).toMatchObject({ partIndex: 0, originalFileName: "a.pdf", sizeBytes: 10 });
    expect(putUrls).toEqual(["https://s3.test/put?n=1", "https://s3.test/put?n=2"]);
  });

  it("status 0 is never success: no answer (onload 0, error, timeout) is retried", async () => {
    answers = [{ status: 0 }, { status: 0, event: "error" }, { status: 0, event: "timeout" }];
    await run();
    expect(putUrls).toHaveLength(4);
  });

  it("status 0 on every attempt fails the item instead of reporting it uploaded", async () => {
    answers = [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }];
    await expect(run()).rejects.toThrow(/Upload failed/);
    expect(putUrls).toHaveLength(4);
  });

  it("Retry-After is honoured as the floor, and a longer ask than 60 s is not waited for", async () => {
    answers = [{ status: 503, retryAfter: "7" }];
    await run();
    expect(waits).toEqual([7000]);

    waits.length = 0;
    answers = [{ status: 429, retryAfter: "120" }];
    await expect(run()).rejects.toThrow(/Upload failed \(429\)/);
    expect(waits).toEqual([]);
  });

  it("a refusal of the bytes (400) is final at once", async () => {
    answers = [{ status: 400 }];
    await expect(run()).rejects.toThrow(/Upload failed \(400\)/);
    expect(putUrls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});
