"use client";

import "../globals.css";

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppShellV2 } from "../../components/app-shell-v2/AppShellV2";
import { ProovraChatWidget } from "../../components/ai/ProovraChatWidget";
import { useAuth } from "../providers";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const {
    user,
    authReady,
    hasSession,
    setToken,
    updateUser,
  } = useAuth();

  const isPlatformAdmin =
    user?.platformRole === "OWNER" ||
    user?.platformRole === "ADMIN";

  const hideAiWidget = useMemo(() => {
    if (!pathname) return false;

    return (
      pathname.startsWith("/admin") ||
      pathname.startsWith("/verify")
    );
  }, [pathname]);

  const handleLogout = () => {
    try {
      localStorage.removeItem("proovra-token");
    } catch {
      //
    }

    setToken(null);
    updateUser(null);

    router.push("/login");
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#f3f5f7]" />
    );
  }

  return (
    <AppShellV2
      user={
        user
          ? {
              displayName:
                user.displayName ||
                `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() ||
                user.email ||
                "Workspace User",
              email: user.email ?? "",
              avatarUrl: user.avatarUrl ?? undefined,
            }
          : null
      }
      onLogout={handleLogout}
      isPlatformAdmin={isPlatformAdmin}
    >
      {children}

      {hasSession && !hideAiWidget ? (
        <ProovraChatWidget />
      ) : null}
    </AppShellV2>
  );
}