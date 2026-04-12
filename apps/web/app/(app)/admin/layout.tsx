"use client";

import type { ReactNode } from "react";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="admin-premium-shell">{children}</div>;
}