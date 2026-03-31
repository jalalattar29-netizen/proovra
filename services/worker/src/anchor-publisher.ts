type AnchorPayload = {
  version: 1;
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  anchorHash: string;
  generatedAtUtc: string;
};

type PublishedAnchorResult = {
  published: true;
  provider: string;
  receiptId: string | null;
  transactionId: string | null;
  publicUrl: string | null;
  anchoredAtUtc: string;
};

type UnpublishedAnchorResult = {
  published: false;
  provider: string | null;
  reason: string;
};

type PublishAnchorResult = PublishedAnchorResult | UnpublishedAnchorResult;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getAnchorMode(): "off" | "ready" | "active" {
  const raw = String(process.env.ANCHOR_MODE ?? "ready")
    .trim()
    .toLowerCase();

  if (raw === "off" || raw === "active") return raw;
  return "ready";
}

function normalizeUrl(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  return cleaned.replace(/\/+$/, "");
}

export async function publishAnchorIfConfigured(params: {
  anchor: AnchorPayload;
}): Promise<PublishAnchorResult> {
  const mode = getAnchorMode();
  const provider = clean(process.env.ANCHOR_PROVIDER);
  const publishUrl = normalizeUrl(process.env.ANCHOR_PUBLISH_URL);
  const apiKey = clean(process.env.ANCHOR_API_KEY);
  const publicBaseUrl = normalizeUrl(process.env.ANCHOR_PUBLIC_BASE_URL);

  if (mode === "off") {
    return {
      published: false,
      provider,
      reason: "ANCHOR_MODE_OFF",
    };
  }

  if (mode === "ready") {
    return {
      published: false,
      provider,
      reason: "ANCHOR_MODE_READY",
    };
  }

  if (!provider) {
    return {
      published: false,
      provider: null,
      reason: "ANCHOR_PROVIDER_NOT_SET",
    };
  }

  if (!publishUrl) {
    return {
      published: false,
      provider,
      reason: "ANCHOR_PUBLISH_URL_NOT_SET",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(publishUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        provider,
        anchor: params.anchor,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsed: Record<string, unknown> | null = null;

    try {
      parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new Error(
        parsed && typeof parsed.message === "string"
          ? parsed.message
          : `ANCHOR_PUBLISH_HTTP_${response.status}`
      );
    }

    const receiptId =
      typeof parsed?.receiptId === "string" && parsed.receiptId.trim()
        ? parsed.receiptId.trim()
        : null;

    const transactionId =
      typeof parsed?.transactionId === "string" && parsed.transactionId.trim()
        ? parsed.transactionId.trim()
        : typeof parsed?.txId === "string" && parsed.txId.trim()
          ? parsed.txId.trim()
          : null;

    const anchoredAtUtc =
      typeof parsed?.anchoredAtUtc === "string" && parsed.anchoredAtUtc.trim()
        ? parsed.anchoredAtUtc.trim()
        : new Date().toISOString();

    const publicUrl =
      typeof parsed?.publicUrl === "string" && parsed.publicUrl.trim()
        ? parsed.publicUrl.trim()
        : publicBaseUrl && (receiptId || transactionId)
          ? `${publicBaseUrl}/${encodeURIComponent(
              receiptId ?? transactionId ?? params.anchor.anchorHash
            )}`
          : null;

    return {
      published: true,
      provider,
      receiptId,
      transactionId,
      publicUrl,
      anchoredAtUtc,
    };
  } finally {
    clearTimeout(timeout);
  }
}