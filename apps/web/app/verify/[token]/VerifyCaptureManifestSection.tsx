/**
 * UC-PROV-003 — what the capture client REPORTED about a direct capture, as
 * validated at seal: the page's domain (never its private URL or title on this
 * public page), the client and its version, the client-reported capture
 * window, completeness and the limitations the client detected. Every line is
 * labelled as reported by the capture client — none of it is proven by
 * PROOVRA. Renders nothing when the record has no manifest facts.
 */
import type { PublicCaptureManifestFacts } from "@proovra/shared";

function humanise(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function readPublicCaptureManifest(data: unknown): PublicCaptureManifestFacts | null {
  const v = (data as { captureManifest?: unknown } | null)?.captureManifest;
  if (!v || typeof v !== "object") return null;
  const f = v as PublicCaptureManifestFacts;
  return typeof f.kind === "string" && f.clientCaptureWindow ? f : null;
}

export function VerifyCaptureManifestSection({ facts }: { facts: PublicCaptureManifestFacts | null }) {
  if (!facts) return null;
  const rows: Array<[string, string]> = [];
  if (facts.web?.domain) rows.push(["Captured site (domain)", facts.web.domain]);
  const client = [facts.client.browserName, facts.client.browserVersion].filter(Boolean).join(" ");
  rows.push([
    "Capture client",
    `${facts.client.kind === "BROWSER_EXTENSION" ? "PROOVRA browser extension" : "PROOVRA app"} ${facts.client.appVersion}${client ? ` · ${client}` : ""}`,
  ]);
  rows.push([
    "Capture window",
    `${facts.clientCaptureWindow.startedAtUtc}${facts.clientCaptureWindow.endedAtUtc ? ` – ${facts.clientCaptureWindow.endedAtUtc}` : ""}`,
  ]);
  rows.push(["Completeness", facts.reportedComplete ? "Reported complete" : `Not complete (${humanise(facts.completeness)})`]);
  if (facts.web?.pageMutatedDuringCapture) rows.push(["Page changed during capture", "Yes"]);
  if (facts.limitations.length > 0) rows.push(["Limitations detected", facts.limitations.map(humanise).join(", ")]);
  return (
    <section data-verify-capture-manifest={facts.reportedComplete ? "complete" : "partial"} style={{ margin: "16px 0" }}>
      <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>Capture details reported by the capture client</h2>
      <p style={{ color: "#475569", margin: "0 0 8px", fontSize: 14 }}>
        These details were reported by the capture client and checked for shape when the record was sealed. PROOVRA
        does not independently prove them.
      </p>
      {!facts.reportedComplete ? (
        <p data-verify-capture-partial style={{ color: "#b45309", margin: "0 0 8px", fontSize: 14 }}>
          The capture client reported this capture as not complete.
        </p>
      ) : null}
      <dl style={{ margin: 0 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 8, fontSize: 14 }}>
            <dt style={{ fontWeight: 600 }}>{k}:</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
