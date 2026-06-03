/**
 * Section-scoped loading skeleton for /evidence-lifecycle/*.
 *
 * Next.js automatically shows this while a server component or the
 * client-side route segment is loading. It removes the brief flash of
 * an empty page and gives the operator immediate visual feedback that
 * a lifecycle surface is opening.
 *
 * Pure server component — no client JS, no data fetch.
 */

export default function EvidenceLifecycleSegmentLoading() {
  const card = {
    background: "#fff",
    border: "1px solid rgba(15,23,42,0.08)",
    borderRadius: 10,
    padding: 10,
    height: 78,
  } as const;
  const bar = {
    background: "linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 37%, #f1f5f9 63%)",
    backgroundSize: "400% 100%",
    animation: "pulse 1.4s ease infinite",
    borderRadius: 6,
    height: 10,
  } as const;
  return (
    <main
      data-evidence-lifecycle-loading
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Lifecycle Operations</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Loading lifecycle console…
        </p>
      </header>

      <section
        style={{
          padding: 12,
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
          }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={card}>
              <div style={{ ...bar, width: "60%", marginBottom: 8 }} />
              <div style={{ ...bar, width: "40%", height: 18 }} />
            </div>
          ))}
        </div>
      </section>

      <section
        style={{
          padding: 12,
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
        }}
      >
        <div style={{ ...bar, width: "30%", marginBottom: 10 }} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={card}>
              <div style={{ ...bar, width: "70%", marginBottom: 8 }} />
              <div style={{ ...bar, width: "30%", height: 18 }} />
            </div>
          ))}
        </div>
      </section>

      <style>{`
        @keyframes pulse {
          0%   { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
    </main>
  );
}
