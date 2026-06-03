/**
 * Phase P1.1 — SSO health snapshot service.
 *
 * Aggregates the existing SsoConnection + SsoCallbackAttempt fields
 * into an operator-readable snapshot. No new persistence; we read
 * the same columns the SAML hardening service writes (R8.2.x).
 *
 * Failure reason taxonomy is bounded; every reason maps to one of:
 *
 *   invalid_signature       — assertion signature did not validate
 *   expired_certificate     — IdP signing cert is past `samlCertNotAfter`
 *   audience_mismatch       — Audience element does not match SP entity id
 *   acs_mismatch            — Destination/Recipient doesn't match the ACS URL
 *   missing_nameid          — assertion lacks a Subject/NameID
 *   missing_email           — assertion lacks a usable email attribute
 *   clock_skew              — NotBefore / NotOnOrAfter window violation
 *   replay_detected         — SsoCallbackAttempt already CONSUMED
 *   idp_unreachable         — TCP-level / metadata fetch failure
 *   metadata_invalid        — IdP metadata parse failure
 *   unknown                 — fallback when the failure category is
 *                              not yet classified (operator-safe)
 */
import { prisma as defaultPrisma } from "../../db.js";
const DAY_MS = 86_400_000;
const CERT_EXPIRY_WARN_DAYS = 90;
const CERT_EXPIRY_CRITICAL_DAYS = 30;
const OUTAGE_THRESHOLD = 5;
const DEGRADED_THRESHOLD = 1;
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function buildSsoHealthSnapshot(input, client = defaultPrisma) {
    const now = Date.now();
    const since24h = new Date(now - DAY_MS);
    const since7d = new Date(now - 7 * DAY_MS);
    const connections = await client.ssoConnection.findMany({
        where: { teamId: input.teamId },
        select: {
            id: true,
            provider: true,
            status: true,
            lastUsedAtUtc: true,
            consecutiveFailureCount: true,
            outageDetectedAtUtc: true,
            outageClearedAtUtc: true,
            samlCertFingerprint: true,
            samlCertNotAfter: true,
        },
        orderBy: { createdAt: "asc" },
    });
    const out = [];
    let aggregatedDegraded = false;
    let aggregatedOutage = false;
    let aggregatedAnyEnabled = false;
    for (const conn of connections) {
        if (conn.status !== "DISABLED" && conn.status !== "REVOKED") {
            aggregatedAnyEnabled = true;
        }
        const attempts = await client.ssoCallbackAttempt.findMany({
            where: {
                ssoConnectionId: conn.id,
                issuedAtUtc: { gte: since7d },
            },
            select: {
                issuedAtUtc: true,
                status: true,
                failureReason: true,
                replayDetectedAtUtc: true,
                consumedAtUtc: true,
            },
            take: 1000,
        });
        let total24 = 0, failed24 = 0, replayed24 = 0;
        let total7 = 0, failed7 = 0, replayed7 = 0;
        let lastSuccess = null;
        let lastFailure = null;
        const reason24 = new Map();
        const reason7 = new Map();
        for (const a of attempts) {
            total7++;
            const recent24 = a.issuedAtUtc >= since24h;
            if (recent24)
                total24++;
            if (a.status === "FAILED") {
                failed7++;
                if (recent24)
                    failed24++;
                if (a.issuedAtUtc > (lastFailure ?? new Date(0)))
                    lastFailure = a.issuedAtUtc;
                const r = classifyFailure(a.failureReason);
                reason7.set(r, (reason7.get(r) ?? 0) + 1);
                if (recent24)
                    reason24.set(r, (reason24.get(r) ?? 0) + 1);
            }
            else if (a.status === "CONSUMED") {
                if (a.consumedAtUtc && a.consumedAtUtc > (lastSuccess ?? new Date(0)))
                    lastSuccess = a.consumedAtUtc;
            }
            else if (a.status === "REPLAYED") {
                replayed7++;
                if (recent24)
                    replayed24++;
                reason7.set("replay_detected", (reason7.get("replay_detected") ?? 0) + 1);
                if (recent24)
                    reason24.set("replay_detected", (reason24.get("replay_detected") ?? 0) + 1);
            }
        }
        // Cert expiry projection
        const cert = computeCertExpiry(conn.samlCertNotAfter, now);
        // Connection health classification
        let health;
        if (conn.status === "DISABLED" || conn.status === "REVOKED") {
            health = "DISABLED";
        }
        else if (!conn.samlCertFingerprint ||
            conn.status === "PENDING") {
            health = "UNCONFIGURED";
        }
        else if (cert.expiryBand === "expired") {
            health = "OUTAGE";
        }
        else if (conn.outageDetectedAtUtc && !conn.outageClearedAtUtc) {
            health = "OUTAGE";
        }
        else if ((conn.consecutiveFailureCount ?? 0) >= OUTAGE_THRESHOLD ||
            cert.expiryBand === "expiring") {
            health = "DEGRADED";
        }
        else if ((conn.consecutiveFailureCount ?? 0) >= DEGRADED_THRESHOLD ||
            cert.expiryBand === "warning") {
            health = "DEGRADED";
        }
        else {
            health = "HEALTHY";
        }
        if (health === "DEGRADED")
            aggregatedDegraded = true;
        if (health === "OUTAGE")
            aggregatedOutage = true;
        // Failure breakdown
        const reasons = [
            "invalid_signature",
            "expired_certificate",
            "audience_mismatch",
            "acs_mismatch",
            "missing_nameid",
            "missing_email",
            "clock_skew",
            "replay_detected",
            "idp_unreachable",
            "metadata_invalid",
            "unknown",
        ];
        const breakdown = reasons
            .map((r) => ({
            reason: r,
            count24h: reason24.get(r) ?? 0,
            count7d: reason7.get(r) ?? 0,
        }))
            .filter((b) => b.count7d > 0);
        out.push({
            connectionId: conn.id,
            provider: conn.provider,
            status: conn.status,
            health,
            lastSuccessAtUtc: lastSuccess
                ? lastSuccess.toISOString()
                : conn.lastUsedAtUtc
                    ? conn.lastUsedAtUtc.toISOString()
                    : null,
            lastFailureAtUtc: lastFailure ? lastFailure.toISOString() : null,
            consecutiveFailureCount: conn.consecutiveFailureCount ?? 0,
            outageDetectedAtUtc: conn.outageDetectedAtUtc
                ? conn.outageDetectedAtUtc.toISOString()
                : null,
            outageClearedAtUtc: conn.outageClearedAtUtc
                ? conn.outageClearedAtUtc.toISOString()
                : null,
            cert,
            attemptCounts: {
                last24h: { total: total24, failed: failed24, replayed: replayed24 },
                last7d: { total: total7, failed: failed7, replayed: replayed7 },
            },
            failureBreakdown: breakdown,
            recommendedAction: pickRecommendedAction(health, cert, breakdown),
        });
    }
    const overallStatus = !aggregatedAnyEnabled
        ? "DISABLED"
        : aggregatedOutage
            ? "OUTAGE"
            : aggregatedDegraded
                ? "DEGRADED"
                : "HEALTHY";
    return {
        teamId: input.teamId,
        generatedAtUtc: new Date(now).toISOString(),
        overallStatus,
        connections: out,
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function classifyFailure(raw) {
    if (!raw)
        return "unknown";
    const r = raw.toLowerCase();
    if (r.includes("signature"))
        return "invalid_signature";
    if (r.includes("cert") || r.includes("expired"))
        return "expired_certificate";
    if (r.includes("audience"))
        return "audience_mismatch";
    if (r.includes("acs") || r.includes("destination") || r.includes("recipient"))
        return "acs_mismatch";
    if (r.includes("nameid") || r.includes("subject"))
        return "missing_nameid";
    if (r.includes("email"))
        return "missing_email";
    if (r.includes("clock") || r.includes("notbefore") || r.includes("notonorafter"))
        return "clock_skew";
    if (r.includes("replay") || r.includes("nonce"))
        return "replay_detected";
    if (r.includes("unreachable") || r.includes("timeout") || r.includes("connect"))
        return "idp_unreachable";
    if (r.includes("metadata"))
        return "metadata_invalid";
    return "unknown";
}
function computeCertExpiry(notAfter, nowMs) {
    if (!notAfter) {
        return {
            fingerprint: null,
            notAfterUtc: null,
            expiryBand: "ok",
            daysUntilExpiry: null,
        };
    }
    const notAfterIso = notAfter instanceof Date ? notAfter.toISOString() : notAfter;
    const ts = Date.parse(notAfterIso);
    if (Number.isNaN(ts)) {
        return {
            fingerprint: null,
            notAfterUtc: notAfterIso,
            expiryBand: "ok",
            daysUntilExpiry: null,
        };
    }
    const days = Math.floor((ts - nowMs) / DAY_MS);
    let band;
    if (days < 0)
        band = "expired";
    else if (days < CERT_EXPIRY_CRITICAL_DAYS)
        band = "expiring";
    else if (days < CERT_EXPIRY_WARN_DAYS)
        band = "warning";
    else
        band = "ok";
    return {
        fingerprint: null,
        notAfterUtc: notAfterIso,
        expiryBand: band,
        daysUntilExpiry: days,
    };
}
function pickRecommendedAction(health, cert, breakdown) {
    if (health === "DISABLED")
        return "Connection is disabled. Re-activate to allow SSO logins.";
    if (health === "UNCONFIGURED")
        return "Connection has no signing certificate. Ingest IdP metadata to configure.";
    if (cert.expiryBand === "expired")
        return "IdP signing certificate has expired. Rotate via the certificate rotation panel.";
    if (cert.expiryBand === "expiring")
        return "IdP signing certificate expires soon. Stage a rotation certificate before the IdP rotates.";
    const dominant = [...breakdown].sort((a, b) => b.count7d - a.count7d)[0];
    if (dominant && dominant.count7d > 0) {
        switch (dominant.reason) {
            case "invalid_signature":
                return "Assertion signatures are failing — verify the IdP's signing cert matches the PROOVRA-side fingerprint.";
            case "audience_mismatch":
                return "Audience element does not match the SP entity id. Confirm the IdP's audience configuration.";
            case "acs_mismatch":
                return "Destination/Recipient does not match the ACS URL. Confirm the IdP's ACS configuration.";
            case "missing_email":
                return "Assertions arrive without a usable email attribute. Update the SAML attribute mapping or IdP attribute release.";
            case "missing_nameid":
                return "Assertions arrive without a NameID. Confirm the IdP's NameID release.";
            case "clock_skew":
                return "Assertion validity window is rejected. Check NTP sync on both PROOVRA and the IdP.";
            case "replay_detected":
                return "Replay attempts detected. Investigate the audit timeline; assertions may be re-submitted by a misconfigured client.";
            case "idp_unreachable":
                return "IdP endpoint is unreachable. Verify outbound network policy or IdP availability.";
            case "metadata_invalid":
                return "IdP metadata is invalid. Re-ingest from the IdP team.";
            default:
                return null;
        }
    }
    return null;
}
