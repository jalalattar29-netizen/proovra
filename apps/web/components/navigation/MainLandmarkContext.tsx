"use client";

import { createContext, useContext } from "react";

/** The shell owns the primary landmark, including loading and refusal states. */
export const MainLandmarkContext = createContext(false);
export function useMainLandmarkOwned(): boolean {
  return useContext(MainLandmarkContext);
}
