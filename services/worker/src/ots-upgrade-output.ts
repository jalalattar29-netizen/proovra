function normalizeOutput(stdout?: string, stderr?: string): string {
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

function normalizeTxid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function hasBitcoinContext(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("bitcoin") ||
    lower.includes("blockchain") ||
    lower.includes("block explorer") ||
    lower.includes("blockstream") ||
    lower.includes("mempool") ||
    lower.includes("txid") ||
    lower.includes("transaction id") ||
    lower.includes("transaction:")
  );
}

function parseTxid(text: string): string | null {
  const contextualPatterns = [
    /bitcoin transaction(?: id)?[^a-f0-9]*([a-f0-9]{64})/i,
    /\btxid[^a-f0-9]*([a-f0-9]{64})\b/i,
    /\btransaction id[^a-f0-9]*([a-f0-9]{64})\b/i,
    /\btransaction[^a-f0-9]+([a-f0-9]{64})\b/i,
    /https?:\/\/[^\s]*\/tx\/([a-f0-9]{64})(?:\b|[/?#])/i,
    /https?:\/\/[^\s]*\/([a-f0-9]{64})(?:\b|[/?#])/i,
  ];

  for (const pattern of contextualPatterns) {
    const match = text.match(pattern);
    const candidate = normalizeTxid(match?.[1] ?? match?.[0] ?? null);
    if (candidate) return candidate;
  }

  if (hasBitcoinContext(text)) {
    const genericMatch = text.match(/\b([a-f0-9]{64})\b/i);
    const candidate = normalizeTxid(genericMatch?.[1] ?? null);
    if (candidate) return candidate;
  }

  return null;
}

function isAnchoredOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("success! timestamp complete") ||
    lower.includes("timestamp complete") ||
    lower.includes("bitcoin transaction")
  );
}

function isPendingOutput(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("pending confirmation in bitcoin blockchain") ||
    lower.includes("pending confirmations") ||
    lower.includes("still waiting") ||
    lower.includes("waiting for 6 confirmations") ||
    lower.includes("timestamp not complete") ||
    lower.includes("not yet anchored") ||
    lower.includes("cannot be greater than available calendar") ||
    lower.includes("available calendar")
  );
}

export type OtsUpgradeOutput = {
  raw: string;
  txid: string | null;
  anchoredOutput: boolean;
  pendingOutput: boolean;
};

export function parseOtsUpgradeOutput(
  stdout?: string,
  stderr?: string
): OtsUpgradeOutput {
  const raw = normalizeOutput(stdout, stderr);
  return {
    raw,
    txid: parseTxid(raw),
    anchoredOutput: isAnchoredOutput(raw),
    pendingOutput: isPendingOutput(raw),
  };
}

export function shouldTreatOtsAsAnchored(result: OtsUpgradeOutput): boolean {
  return result.anchoredOutput && !result.pendingOutput;
}
