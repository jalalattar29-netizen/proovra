"use client";

import { useEffect } from "react";
import { initCookieConsent } from "../lib/cookieConsent";

export default function CookieConsentInit() {
  useEffect(() => {
    initCookieConsent();
  }, []);

  return null;
}