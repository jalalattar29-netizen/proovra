"use client";

import type { ReactNode } from "react";
import AdminConsoleNav from "../../../components/admin/AdminConsoleNav";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="section app-section admin-premium-shell">
      <div className="container" style={{ paddingTop: 32, paddingBottom: 56 }}>
        <AdminConsoleNav />
        {children}
      </div>
    </div>
  );
}