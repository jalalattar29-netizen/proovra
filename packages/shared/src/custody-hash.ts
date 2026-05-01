import { createHash } from "node:crypto";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizePayload(value: unknown): unknown {
  return value === undefined || value === null ? null : value;
}

export function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJsonValue: non-finite number is not allowed");
    }
    return JSON.stringify(value);
  }

  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonValue(item)).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(obj[key])}`)
      .join(",")}}`;
  }

  throw new Error(`canonicalJsonValue: unsupported value type "${t}"`);
}

export function buildCustodyEventHash(params: {
  evidenceId: string;
  sequence: number;
  eventType: string;
  atUtc: Date;
  payload?: unknown;
  prevEventHash?: string | null;
}): string {
  const canonical = canonicalJsonValue({
    v: 1,
    evidenceId: params.evidenceId,
    sequence: params.sequence,
    eventType: params.eventType,
    atUtc: params.atUtc.toISOString(),
    payload: normalizePayload(params.payload),
    prevEventHash: params.prevEventHash ?? null,
  });

  return sha256Hex(canonical);
}
