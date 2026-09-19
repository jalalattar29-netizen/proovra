/**
 * NetworkProvider (Phase 3) — the single React owner of network status,
 * subscribing to the dependency-free network-state signal the API layer feeds.
 * Consumed by ProovraShell (offline banner) and any surface that needs a
 * truthful offline state.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getNetworkStatus, subscribeNetwork, type NetworkStatus } from "./network-state";

interface NetworkValue {
  status: NetworkStatus;
  isOffline: boolean;
}

const NetworkContext = createContext<NetworkValue | null>(null);

export function useNetwork(): NetworkValue {
  return useContext(NetworkContext) ?? { status: "unknown", isOffline: false };
}

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<NetworkStatus>(getNetworkStatus());
  useEffect(() => subscribeNetwork(setStatus), []);
  const value = useMemo<NetworkValue>(() => ({ status, isOffline: status === "offline" }), [status]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}
