/**
 * SUPPORT — the native port of `apps/web/app/support/page.tsx`.
 *
 * The authenticated app routes users here from five call sites — the app error
 * boundary, not-found, Search and billing — so until this existed a phone user
 * who hit an error had nowhere to go.
 *
 * Every reference document opens in the canonical legal reader rather than a
 * browser, and the Trust Center link is the IN-APP one. A support screen that
 * ejects the user into a browser is the handoff this conversion removed.
 */
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";

import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
} from "../../src/ui";
import {
  SUPPORT_REFERENCES,
  SUPPORT_ROUTES,
  destinationPath,
  mailtoUrl,
} from "../../src/product/support";

export default function SupportScreen() {
  const router = useRouter();

  return (
    <ProovraScreen testID="support">
      <ProovraPageHeader
        title="Support"
        eyebrow="Help"
        subtitle="Pick the route that matches your request."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {SUPPORT_ROUTES.map((route) => {
        const path = destinationPath(route.destination);
        return (
          <ProovraCard key={route.key}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
              <ProovraBadge label={route.label} tone="neutral" />
            </View>
            <ProovraText variant="body" weight="semibold">
              {route.title}
            </ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {route.body}
            </ProovraText>
            <ProovraButton
              label={route.cta}
              variant="secondary"
              onPress={() => {
                if (path) {
                  router.push(path);
                  return;
                }
                if (route.destination.kind === "email") {
                  // The one legitimate departure from the app: an email client
                  // is where a human reply comes back from.
                  void Linking.openURL(mailtoUrl(route.destination.address));
                }
              }}
            />
          </ProovraCard>
        );
      })}

      <ProovraPageSection title="Reference">
        <ProovraCard>
          {/*
            Named by slug, rendered by the canonical legal reader. A second
            copy of a DPA or a security overview inside the app is exactly the
            drift the legal delivery exists to prevent.
          */}
          {SUPPORT_REFERENCES.map((ref) => (
            <ProovraListRow
              key={ref.slug}
              title={ref.label}
              onPress={() => router.push(`/legal/${ref.slug}`)}
            />
          ))}
        </ProovraCard>
      </ProovraPageSection>
    </ProovraScreen>
  );
}
