/**
 * COPY — the one clipboard control (expo-clipboard). The web's copy buttons
 * (MetadataRow "Copy to clipboard", "Copy SHA-256", "Copy coordinates",
 * "Copy link", "Copy verification link", "Copy JSON", "Copy case ID",
 * "Copy support reference") all swap their label to "Copied" for a moment;
 * this does the same, and says so when the device refuses the write.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";

import { ProovraButton } from "./index";

/** Write text to the device clipboard; false when the platform refused. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    return (await Clipboard.setStringAsync(text)) !== false;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  accessibilityLabel,
  variant = "ghost",
  testID,
}: {
  value: string;
  label?: string;
  accessibilityLabel?: string;
  variant?: "ghost" | "secondary";
  testID?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onPress = useCallback(async () => {
    const ok = await copyToClipboard(value);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, [value]);
  return (
    <ProovraButton
      label={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      accessibilityLabel={accessibilityLabel ?? label}
      variant={variant}
      fullWidth={false}
      onPress={() => void onPress()}
      testID={testID}
    />
  );
}
