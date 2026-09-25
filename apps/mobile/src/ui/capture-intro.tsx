/**
 * CAPTURE INTRO — the web capture hero (capture/page.tsx:748-777) and its
 * `CaptureTrustStrip`.
 *
 * The web's browser-extension card is deliberately NOT ported: the extension
 * channel is desktop-web only, and test/mobile-boot-contract.test.mjs pins that
 * the native app never renders that surface.
 *
 * The trust strip is explanatory copy and nothing else: no verdict, no session
 * state, no admissibility or authenticity claim.
 */
import React from "react";
import { View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraText } from "./index";
import { ProovraPageHeader } from "./patterns";

const TRUST_ITEMS = [
  { id: "integrity", title: "Integrity by design", detail: "Hash, map, and verify automatically" },
  { id: "protected", title: "End-to-end protected", detail: "Encrypted storage and verifiable audit trail" },
  { id: "audit", title: "Verifiable audit trail", detail: "Recorded evidence operations and preservation history" },
] as const;

export function CaptureHero() {
  return (
    <View style={{ gap: theme.space.s3, marginBottom: theme.space.s3 }} testID="capture-hero">
      <ProovraPageHeader
        title="Capture Evidence"
        subtitle="Collect, map, fingerprint, and prepare evidence materials before Review & Sign. Drafts save metadata only — file contents are not stored until finalization."
      />
      <View style={{ gap: theme.space.s2 }} testID="capture-trust-strip">
        {TRUST_ITEMS.map((t) => (
          <View
            key={t.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space.s2,
              borderWidth: 1,
              borderColor: theme.color.border.subtle,
              borderRadius: theme.radius.md,
              backgroundColor: theme.color.surface.card,
              paddingHorizontal: theme.space.s3,
              paddingVertical: theme.space.s2,
            }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent.a500 }} />
            <View style={{ flex: 1 }}>
              <ProovraText variant="bodySm" weight="semibold">{t.title}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{t.detail}</ProovraText>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
