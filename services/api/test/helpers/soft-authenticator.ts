/**
 * A SOFTWARE WEBAUTHN AUTHENTICATOR for integration tests (2026-10-28).
 *
 * Produces exactly what a browser hands the server — a registration response
 * (attestation "none", COSE EC2 P-256 key, flags UP|UV|AT) and assertions
 * (ECDSA-SHA256 over authenticatorData || SHA-256(clientDataJSON)) — from a
 * real node:crypto key pair, so the server's REAL verification path runs end
 * to end. Knobs exist only for the negative cases a test must be able to
 * build: drop the UV flag, force a sign counter, sign a different challenge,
 * claim a different origin.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// -----------------------------------------------------------------------------
// Minimal CBOR encoder (major types 0,1,2,3,5 — all COSE / attestation needs)
// -----------------------------------------------------------------------------

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, len: number): Buffer {
  const m = major << 5;
  if (len < 24) return Buffer.from([m | len]);
  if (len < 0x100) return Buffer.from([m | 24, len]);
  if (len < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(len, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(len, 1);
  return b;
}

export function cborEncode(value: Cbor): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("cbor: integers only");
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  }
  const entries: Array<[Cbor, Cbor]> =
    value instanceof Map ? Array.from(value.entries()) : Object.entries(value);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cborEncode(k), cborEncode(v)]),
  ]);
}

// -----------------------------------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64u = (b: Uint8Array | string) =>
  (typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b)).toString("base64url");

export type SoftAssertionOptions = {
  /** Default true. False clears the UV flag. */
  userVerified?: boolean;
  /** Use this counter instead of advancing the internal one. */
  counter?: number;
  /** Sign this challenge instead of the one in the options. */
  challenge?: string;
  /** Claim this origin instead of the authenticator's own. */
  origin?: string;
};

export class SoftAuthenticator {
  readonly credentialId: Buffer;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  counter = 0;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    opts: { counterStart?: number } = {},
  ) {
    this.credentialId = randomBytes(32);
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.counter = opts.counterStart ?? 0;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return cborEncode(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
  }

  private authData(flags: number, counter: number, attested: boolean): Buffer {
    const rpIdHash = createHash("sha256").update(this.rpId, "utf8").digest();
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(counter >>> 0, 0);
    const parts: Buffer[] = [rpIdHash, Buffer.from([flags]), cnt];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length, 0);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create(), as @simplewebauthn/browser returns it. */
  register(
    optionsJSON: { challenge: string },
    opts: { userVerified?: boolean; origin?: string } = {},
  ): Record<string, unknown> {
    const flags = FLAG_UP | FLAG_AT | (opts.userVerified === false ? 0 : FLAG_UV);
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge: optionsJSON.challenge,
      origin: opts.origin ?? this.origin,
      crossOrigin: false,
    });
    const attestationObject = cborEncode({
      fmt: "none",
      attStmt: {},
      authData: this.authData(flags, this.counter, true),
    });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get(), as @simplewebauthn/browser returns it. */
  assert(optionsJSON: { challenge: string }, opts: SoftAssertionOptions = {}): Record<string, unknown> {
    let counter: number;
    if (opts.counter !== undefined) {
      counter = opts.counter;
    } else {
      this.counter += 1;
      counter = this.counter;
    }
    const flags = FLAG_UP | (opts.userVerified === false ? 0 : FLAG_UV);
    const authenticatorData = this.authData(flags, counter, false);
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: opts.challenge ?? optionsJSON.challenge,
      origin: opts.origin ?? this.origin,
      crossOrigin: false,
    });
    const clientDataHash = createHash("sha256").update(clientDataJSON, "utf8").digest();
    const signature = sign("sha256", Buffer.concat([authenticatorData, clientDataHash]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
