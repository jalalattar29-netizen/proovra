/**
 * A link this app has no screen for. The router's default page says "Unmatched
 * Route", which on a product about evidence reads as something being wrong with
 * the evidence (MOBILE-004).
 */
import { useRouter } from "expo-router";

import { ProovraButton, ProovraCard, ProovraScreen, ProovraText } from "../src/ui";

export default function NotFoundRoute() {
  const router = useRouter();
  return (
    <ProovraScreen width="form" testID="not-found">
      <ProovraCard>
        <ProovraText variant="h2" weight="semibold" accessibilityRole="header">This link does not open in the app</ProovraText>
        <ProovraText variant="body">Nothing is wrong with your records. Try the link in a web browser, or go to your home screen.</ProovraText>
        <ProovraButton label="Go to home" onPress={() => router.replace("/")} />
      </ProovraCard>
    </ProovraScreen>
  );
}