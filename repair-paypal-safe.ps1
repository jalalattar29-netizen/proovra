# PROOVRA PayPal: targeted source-only patch. No backup, Git, push, deploy or Stripe changes.
# Run from D:\digital-witness in PowerShell: powershell -ExecutionPolicy Bypass -File .\repair-paypal-safe.ps1
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$paypal = Join-Path $root 'services/api/src/services/paypal.service.ts'
$webhook = Join-Path $root 'services/api/src/routes/webhooks.routes.ts'
$drawer = Join-Path $root 'apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx'
foreach ($p in @($paypal,$webhook,$drawer)) { if (-not (Test-Path -LiteralPath $p)) { throw "Missing $p. Run from project root." } }
$utf8 = [System.Text.UTF8Encoding]::new($false)
$lineEndings = @{}
function Read-Source($p) {
  $value = [System.IO.File]::ReadAllText($p)
  $lineEndings[$p] = if ($value.Contains("`r`n")) { "`r`n" } else { "`n" }
  return $value.Replace("`r`n", "`n")
}
function Restore-Source($p, $value) {
  if ($lineEndings[$p] -eq "`r`n") { return $value.Replace("`n", "`r`n") }
  return $value
}
function Replace-Once([string]$source,[string]$before,[string]$after,[string]$label) {
  $pos = $source.IndexOf($before,[StringComparison]::Ordinal)
  if ($pos -lt 0) { throw "PRECONDITION FAILED: $label. No files changed. Check local code before applying." }
  if ($source.IndexOf($before,$pos+$before.Length,[StringComparison]::Ordinal) -ge 0) { throw "AMBIGUOUS: $label. No files changed." }
  return $source.Substring(0,$pos)+$after+$source.Substring($pos+$before.Length)
}
$p = Read-Source $paypal
$w = Read-Source $webhook
$d = Read-Source $drawer
$oldStorage = @'
  return JSON.stringify({
    userId: params.userId,
    teamId: params.teamId ?? null,
    storageAddonKey: params.addonKey,
    billingCycle: params.billingCycle,
    workspacePlan: params.workspacePlan,
  });
'@
$newStorage = @'
  // PayPal subscription custom_id has a 127-byte limit. Compact v1 wire format:
  // sa1|user UUID|team UUID or -|addon code. Cycle is MONTHLY by contract;
  // workspace plan is resolved from the authoritative billing account on receipt.
  const codes: Record<prismaPkg.StorageAddonKey, string> = {
    PERSONAL_10_GB: "p10", PERSONAL_50_GB: "p50", PERSONAL_200_GB: "p200",
    TEAM_100_GB: "t100", TEAM_500_GB: "t500", TEAM_1_TB: "t1t",
  };
  const value = `sa1|${params.userId}|${params.teamId ?? "-"}|${codes[params.addonKey]}`;
  if (Buffer.byteLength(value, "utf8") > 127) {
    throw new Error("PayPal storage checkout context exceeds 127 bytes");
  }
  return value;
'@
$p = Replace-Once $p $oldStorage $newStorage 'storage custom_id builder'
$oldParser = @'
  const text = raw.trim();

  try {
'@
$newParser = @'
  const text = raw.trim();

  // Compact v1 context; legacy JSON and key=value formats remain supported.
  if (text.startsWith("sa1|")) {
    const parts = text.split("|");
    const keys: Record<string, prismaPkg.StorageAddonKey> = {
      p10: prismaPkg.StorageAddonKey.PERSONAL_10_GB,
      p50: prismaPkg.StorageAddonKey.PERSONAL_50_GB,
      p200: prismaPkg.StorageAddonKey.PERSONAL_200_GB,
      t100: prismaPkg.StorageAddonKey.TEAM_100_GB,
      t500: prismaPkg.StorageAddonKey.TEAM_500_GB,
      t1t: prismaPkg.StorageAddonKey.TEAM_1_TB,
    };
    if (parts.length !== 4 || !/^[0-9a-f-]{36}$/i.test(parts[1] ?? "") ||
        !keys[parts[3] ?? ""] ||
        (parts[2] !== "-" && !/^[0-9a-f-]{36}$/i.test(parts[2] ?? ""))) return {};
    return {
      userId: parts[1], teamId: parts[2] === "-" ? null : parts[2],
      storageAddonKey: keys[parts[3]!],
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    };
  }

  try {
'@
# Ensure the parser edit applies only inside the named function.
$parserStart = $w.IndexOf('function tryParseAddonContextFromCustomId(')
if ($parserStart -lt 0) { throw 'PRECONDITION FAILED: webhook parser' }
$parserEnd = $w.IndexOf('function parseAmountCents(', $parserStart)
if ($parserEnd -lt 0) { throw 'PRECONDITION FAILED: webhook parser end' }
$beforeParser = $w.Substring($parserStart,$parserEnd-$parserStart)
$afterParser = Replace-Once $beforeParser $oldParser $newParser 'webhook compact parser'
$w = $w.Substring(0,$parserStart)+$afterParser+$w.Substring($parserEnd)
# PayPal-only fallback for stale web projection: preserve Stripe routing.
$oldPlan = @'
      : send(() =>
          apiFetch("/v1/billing/checkout/paypal", {
            method: "POST",
            body: planBody,
          }),
        );
'@
$newPlan = @'
      : send(async () => {
          try {
            return await apiFetch("/v1/billing/checkout/paypal", {
              method: "POST", body: planBody,
            });
          } catch (err) {
            // A stale projection may have opened BUY for an existing subscriber.
            // Only retry the explicit server-owned duplicate-subscription response.
            const failure = err as { code?: string; error?: { code?: string } };
            if (failure.code !== "SUBSCRIPTION_ALREADY_ACTIVE" &&
                failure.error?.code !== "SUBSCRIPTION_ALREADY_ACTIVE") throw err;
            return apiFetch("/v1/billing/subscription/plan", {
              method: "POST", body: planBody,
            });
          }
        });
'@
$d = Replace-Once $d $oldPlan $newPlan 'PayPal web upgrade routing'
# The plan transition API returns an outcome (sometimes no approval URL), not always a checkout session.
$oldLinks = @'
      const stripeUrl = (data as { session?: { url?: string } })?.session?.url;
'@
$newLinks = @'
      const transition = data as { outcome?: string; approvalUrl?: string | null };
      if (transition?.outcome === "NO_CHANGE" ||
          transition?.outcome === "PROVIDER_TRANSITION_IN_PROGRESS" ||
          (transition?.outcome && !transition.approvalUrl)) {
        // Reconciliation and webhooks, not browser redirects, confirm entitlement.
        return;
      }
      if (transition?.approvalUrl) {
        const url = new URL(transition.approvalUrl);
        if (url.protocol !== "https:" ||
            !["paypal.com", "www.paypal.com", "sandbox.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname)) {
          throw new Error("Unexpected PayPal plan-transition approval URL");
        }
        window.location.href = url.toString();
        return;
      }
      const stripeUrl = (data as { session?: { url?: string } })?.session?.url;
'@
$d = Replace-Once $d $oldLinks $newLinks 'plan transition response handling'
# All preconditions passed: only now write exactly three changed files.
[System.IO.File]::WriteAllText($paypal,(Restore-Source $paypal $p),$utf8)
[System.IO.File]::WriteAllText($webhook,(Restore-Source $webhook $w),$utf8)
[System.IO.File]::WriteAllText($drawer,(Restore-Source $drawer $d),$utf8)
Write-Host 'Applied three targeted PayPal edits. NO push/deploy. Run typecheck and focused tests.' -ForegroundColor Green
