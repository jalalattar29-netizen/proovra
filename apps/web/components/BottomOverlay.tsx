"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * PRO-PW-08 — ONE STACK FOR THE BOTTOM-OF-SCREEN NOTICES.
 *
 * The contract-skew notice, the service-worker update prompt and the
 * sign-out-incomplete notice were each `position: fixed; bottom: 16px;
 * z-index: 1000`, rendered from three different trees, so whichever mounted
 * last covered the others. Each now renders into one fixed, column container
 * (created on first use, appended to <body>), so two or three of them are
 * visible together, one above the other. Only the stack is fixed; the notices
 * inside it lay out normally.
 */
const STACK_ID = "proovra-bottom-overlay-stack";

function stackElement(): HTMLElement {
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STACK_ID;
    el.setAttribute("data-overlay-stack", "");
    Object.assign(el.style, {
      position: "fixed",
      left: "16px",
      right: "16px",
      bottom: "16px",
      zIndex: "1000",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "8px",
      pointerEvents: "none",
    });
    document.body.appendChild(el);
  }
  return el;
}

export default function BottomOverlay({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(stackElement());
  }, []);
  if (!host) return null;
  return createPortal(<div style={{ pointerEvents: "auto", width: "100%", maxWidth: 720 }}>{children}</div>, host);
}
