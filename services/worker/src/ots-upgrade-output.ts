function normalizeOutput(stdout?: string, stderr?: string): string {
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

function parseTxid(text: string): string | null {
  const patterns = [
    /bitcoin transaction[^a-f0-9]*([a-f0-9]{64})/i,
    /\btxid[^a-f0-9]*([a-f0-9]{64})\b/i,
    /\btransaction id[^a-f0-9]*([a-f0-9]{64})\b/i,
    /\b([a-f0-9]{64})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
    if (match?.[0] && /^[a-f0-9]{64}$/i.test(match[0])) {
      return match[0].toLowerCase();
    }
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
  return Boolean(result.txid) && !result.pendingOutput;
}
