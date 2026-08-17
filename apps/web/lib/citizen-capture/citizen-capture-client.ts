/**
 * Phase 1B Closure — Citizen capture client (browser).
 *
 * Runs entirely in the browser. Uses:
 *   * Web Crypto API (`crypto.subtle.digest("SHA-256")`) for hashing.
 *   * `@noble/ed25519` for session-ephemeral Ed25519 key + signing.
 *   * Shared `canonicalJson()` from `@proovra/shared`.
 *
 * Lifecycle:
 *   1. `openCitizenSession(intakeTokenId)` — generates ephemeral key,
 *      POSTs to `/v1/intake/citizen/sessions`, returns descriptor +
 *      deviceId.
 *   2. `captureAndSubmit({ file })` — reads file bytes, SHA-256,
 *      builds canonical CaptureSignaturePayload (Class B), signs,
 *      POSTs to `/v1/intake/citizen/sessions/:id/capture`.
 *
 * Hard rules:
 *   * Session-ephemeral key NEVER persisted to localStorage — held
 *     in-memory for the session.
 *   * Class B clamping is server-side; the client claims B honestly.
 *   * Bounded denial reasons surface verbatim.
 */

import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  canonicalJson,
  type CaptureSignaturePayload,
} from "@proovra/shared";

// AUDIT-002 (2026-08-15): these calls were RELATIVE (`/v1/...`), so the
// browser resolved them against the WEB origin. There is no `/v1` rewrite in
// next.config, so the citizen capture flow 404'd against Next and never
// reached the API. The origin now comes from the ONE authority in lib/api.
import { apiBaseUrl } from "../api";

// Inject SHA-512 (noble/ed25519 dependency).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ed: any = ed25519;
if (ed.etc) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const part of m) h.update(part);
    return h.digest();
  };
  ed.etc.sha512Async = async (...m: Uint8Array[]) => ed.etc.sha512Sync(...m);
}

export type CitizenSession = {
  descriptor: {
    captureSessionId: string;
    teamId: string;
    captureMode: "CITIZEN_PWA";
    provenanceClassCeiling: "B";
    ttlSeconds: number;
    expiresAtUtc: string;
  };
  deviceId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
};

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 1) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return bytesToHex(new Uint8Array(buf));
}

/**
 * Open a citizen capture session.
 */
export async function openCitizenSession(
  intakeTokenId: string,
): Promise<CitizenSession> {
  const priv = randomBytes(32);
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubHex = bytesToHex(pub);

  const res = await fetch(`${apiBaseUrl()}/v1/intake/citizen/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intakeTokenId,
      publicKeyHex: pubHex,
      userAgent: navigator.userAgent.slice(0, 180),
    }),
  });
  if (!res.ok) {
    const denial = await res.json().catch(() => ({}));
    throw Object.assign(new Error("Citizen session open failed"), {
      denial,
      status: res.status,
    });
  }
  const json = (await res.json()) as {
    descriptor: CitizenSession["descriptor"];
    deviceId: string;
  };
  return {
    descriptor: json.descriptor,
    deviceId: json.deviceId,
    privateKey: priv,
    publicKey: pub,
    publicKeyHex: pubHex,
  };
}

export type CitizenCaptureInput = {
  session: CitizenSession;
  file: File;
};

export type CitizenCaptureResult =
  | {
      kind: "OK";
      provenanceClass: "B" | "C";
      signatureVerdict: string;
      attestationVerdict: "NOT_ATTEMPTED";
      assetHash: string;
    }
  | {
      kind: "DENIED";
      reason: string;
    };

/**
 * Sign and submit a citizen capture.
 */
export async function captureAndSubmit(
  input: CitizenCaptureInput,
): Promise<CitizenCaptureResult> {
  const fileBytes = new Uint8Array(await input.file.arrayBuffer());
  const assetHash = await sha256Hex(fileBytes);

  const nonceHex = bytesToHex(randomBytes(32));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const performanceNow =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const monotonicNs = Math.round(performanceNow * 1_000_000).toString();

  const payload: CaptureSignaturePayload = {
    schemaVersion: "PROOVRA_CAPTURE_SIG_V1",
    assetHash,
    captureMode: "CITIZEN_PWA",
    provenanceClass: "B",
    deviceKeyId: input.session.deviceId,
    algorithm: "Ed25519",
    captureSessionId: input.session.descriptor.captureSessionId,
    signedAtUtc: new Date().toISOString(),
    signedAtMonotonicNs: monotonicNs,
    nonceHex,
    metadata: {
      deviceModel: "browser",
      osVersion: "web",
      appVersion: "pwa-1.0",
      networkState: "ONLINE",
      locationPolicy: "OFF",
      location: null,
      camera: null,
      sensor: null,
      operatorContext: null,
    },
  };

  const canonical = canonicalJson(payload);
  const canonicalBytes = new TextEncoder().encode(canonical);
  const signature = await ed25519.signAsync(canonicalBytes, input.session.privateKey);
  const signatureHex = bytesToHex(signature);

  const assetBase64 = await fileToBase64(input.file);

  const res = await fetch(
    `${apiBaseUrl()}/v1/intake/citizen/sessions/${input.session.descriptor.captureSessionId}/capture`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload,
        signatureHex,
        assetBase64,
      }),
    },
  );

  if (!res.ok) {
    let reason = "UNKNOWN";
    try {
      const body = await res.json();
      reason = body?.denial ?? body?.receipt?.denialReason ?? "UNKNOWN";
    } catch {
      /* keep UNKNOWN */
    }
    return { kind: "DENIED", reason };
  }

  const body = (await res.json()) as {
    receipt: {
      provenanceClass: "B" | "C";
      signatureVerdict: string;
      attestationVerdict: "NOT_ATTEMPTED";
    };
  };
  return {
    kind: "OK",
    provenanceClass: body.receipt.provenanceClass,
    signatureVerdict: body.receipt.signatureVerdict,
    attestationVerdict: "NOT_ATTEMPTED",
    assetHash,
  };
}

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}
