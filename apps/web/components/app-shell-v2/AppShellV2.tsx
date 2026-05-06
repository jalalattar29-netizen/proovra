"use client";

import type { ReactNode } from "react";
import { AppSidebarV2 } from "./AppSidebarV2";
import { AppTopbarV2, type AppShellUserV2 } from "./AppTopbarV2";
import { AppFooterV2 } from "./AppFooterV2";

type AppShellV2Props = {
  children: ReactNode;
  user: AppShellUserV2 | null;
  onLogout: () => void;
  isPlatformAdmin?: boolean;
};

export function AppShellV2({
  children,
  user,
  onLogout,
  isPlatformAdmin = false,
}: AppShellV2Props) {
  return (
    <div className="app-shell-v2">
      <AppTopbarV2
        user={user}
        onLogout={onLogout}
        isPlatformAdmin={isPlatformAdmin}
      />

      <div className="app-shell-v2-main">
        <AppSidebarV2 isPlatformAdmin={isPlatformAdmin} />

        <main className="app-shell-v2-content">{children}</main>
      </div>

      <AppFooterV2 />
    </div>
  );
}