"use client";

import { TopBar } from "../../components/ui";

export default function SupportPage() {
  return (
    <div className="page">
      <TopBar title="Proovra" right={<a href="/">Home</a>} />
      <section className="section container">
        <h1 style={{ marginTop: 0 }}>Support</h1>
        <p className="page-subtitle">
          For help, billing, or security issues, contact the Proovra team.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          <a href="mailto:support@proovra.com">support@proovra.com</a>
          <a href="mailto:legal@proovra.com">legal@proovra.com</a>
          <a href="mailto:admin@proovra.com">admin@proovra.com</a>
          <a href="mailto:security@proovra.com">security@proovra.com</a>
        </div>
      </section>
    </div>
  );
}
