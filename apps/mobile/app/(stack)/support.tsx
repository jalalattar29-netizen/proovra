/**
 * SUPPORT — the native port of `apps/web/app/support/page.tsx`.
 *
 * The authenticated app routes users here from five call sites — the app error
 * boundary, not-found, Search and billing — so until this existed a phone user
 * who hit an error had nowhere to go.
 *
 * Every section of the web page is here, in the web's order, with the web's
 * copy (src/product/support.ts). The layout is re-flowed for a phone: the
 * web's four-up grids become stacked cards, the routing diagram becomes three
 * stacked step cards, and the response-expectations table becomes one card
 * per request type, because a three-column table does not fit a phone.
 *
 * Every reference document opens in the canonical legal reader rather than a
 * browser, and the Trust Center link is the IN-APP one. The only departures
 * from the app are an email client (where a human reply comes back from) and
 * the sales form, which has no native counterpart and opens on the public web
 * origin — hidden when no origin is configured.
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
  ProovraPageHeader,
  ProovraDetailRows,
} from "../../src/ui";
import { webOrigin } from "../../src/product/intake-create";
import {
  ENTERPRISE_EVALUATION,
  HELPFUL_RESOURCES,
  RESPONSE_EXPECTATIONS,
  SECURITY_REVIEWS,
  SENSITIVE_REQUESTS,
  SUPPORT_FINAL_CTA,
  SUPPORT_HERO,
  SUPPORT_PATHS_SECTION,
  SUPPORT_ROUTES,
  SUPPORT_ROUTING,
  SUPPORT_SCOPE,
  SUPPORT_VS_POLICY,
  destinationPath,
  mailtoUrl,
  webUrl,
  type SupportDestination,
  type SupportLink,
} from "../../src/product/support";

type Variant = "primary" | "secondary" | "ghost";

/** A section's eyebrow, heading and optional lead — the web's SectionEyebrow + h2 + p. */
function SectionHead({ eyebrow, heading, body }: { eyebrow: string; heading: string; body?: string }) {
  return (
    <View style={{ gap: theme.space.s1, marginTop: theme.space.s4 }}>
      <ProovraText variant="label" weight="bold" color={theme.color.accent.a500}>
        {eyebrow}
      </ProovraText>
      <ProovraText variant="h3" weight="semibold" accessibilityRole="header">
        {heading}
      </ProovraText>
      {body ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {body}
        </ProovraText>
      ) : null}
    </View>
  );
}

function Bullets({ items }: { items: ReadonlyArray<string> }) {
  return (
    <View style={{ gap: theme.space.s1 }}>
      {items.map((item) => (
        <ProovraText key={item} variant="bodySm">
          {`• ${item}`}
        </ProovraText>
      ))}
    </View>
  );
}

export default function SupportScreen() {
  const router = useRouter();
  const origin = webOrigin();

  /** Opens a destination; returns false when it has nowhere to go on this build. */
  const open = (destination: SupportDestination) => {
    const path = destinationPath(destination);
    if (path) {
      router.push(path);
      return;
    }
    if (destination.kind === "email") {
      // An email client is where a human reply comes back from.
      void Linking.openURL(mailtoUrl(destination.address));
      return;
    }
    if (destination.kind === "web") {
      const url = webUrl(origin, destination.path);
      if (url) void Linking.openURL(url);
    }
  };
  /** A web-only destination with no configured origin would go nowhere, so it is not rendered. */
  const reachable = (destination: SupportDestination) =>
    destination.kind !== "web" || webUrl(origin, destination.path) !== null;

  const linkButton = (link: SupportLink, variant: Variant = "ghost") =>
    reachable(link.destination) ? (
      <ProovraButton
        key={link.label}
        label={link.label}
        variant={variant}
        fullWidth={false}
        onPress={() => open(link.destination)}
      />
    ) : null;

  return (
    <ProovraScreen testID="support">
      {/* 1 — Hero */}
      <ProovraPageHeader
        title={SUPPORT_HERO.title}
        eyebrow={SUPPORT_HERO.eyebrow}
        subtitle={SUPPORT_HERO.body}
        contextStrip={
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            {SUPPORT_HERO.chips.map((chip) => (
              <ProovraBadge key={chip} label={chip} tone="neutral" />
            ))}
          </View>
        }
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        {SUPPORT_HERO.actions.map((a, i) => (
          linkButton(a, i === 0 ? "primary" : "secondary")
        ))}
      </View>

      {/* 2 — Support paths */}
      <SectionHead {...SUPPORT_PATHS_SECTION} />
      {SUPPORT_ROUTES.map((route) => (
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
          <ProovraButton label={route.cta} variant="secondary" onPress={() => open(route.destination)} />
        </ProovraCard>
      ))}

      {/* 3 — Support routing */}
      <SectionHead {...SUPPORT_ROUTING} />
      {SUPPORT_ROUTING.steps.map((step) => (
        <ProovraCard key={step.step}>
          <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>
            {step.step}
          </ProovraText>
          <ProovraText variant="body" weight="semibold">
            {step.title}
          </ProovraText>
          {step.body ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {step.body}
            </ProovraText>
          ) : null}
          {step.items.length > 0 ? <Bullets items={step.items} /> : null}
        </ProovraCard>
      ))}

      {/* 4 — Support scope */}
      <SectionHead eyebrow={SUPPORT_SCOPE.eyebrow} heading={SUPPORT_SCOPE.heading} />
      <ProovraCard>
        <ProovraText variant="label" weight="bold">
          {SUPPORT_SCOPE.canHelpTitle}
        </ProovraText>
        <Bullets items={SUPPORT_SCOPE.canHelp} />
      </ProovraCard>
      <ProovraCard>
        <ProovraText variant="label" weight="bold">
          {SUPPORT_SCOPE.cannotDoTitle}
        </ProovraText>
        <Bullets items={SUPPORT_SCOPE.cannotDo} />
      </ProovraCard>

      {/* 5 — Response expectations: one card per row instead of a table */}
      <SectionHead {...RESPONSE_EXPECTATIONS} />
      <ProovraCard>
        {RESPONSE_EXPECTATIONS.rows.map((row) => (
          <View key={row.type} style={{ gap: theme.space.s1, paddingVertical: theme.space.s2 }}>
            <ProovraText variant="body" weight="semibold">
              {row.type}
            </ProovraText>
            <ProovraDetailRows
              rows={[
                { label: RESPONSE_EXPECTATIONS.columns.path, value: row.path },
                { label: RESPONSE_EXPECTATIONS.columns.expectation, value: row.expectation },
              ]}
            />
          </View>
        ))}
      </ProovraCard>

      {/* 6 — Enterprise evaluation */}
      <SectionHead {...ENTERPRISE_EVALUATION} />
      <ProovraCard>
        <ProovraText variant="label" weight="bold" color={theme.color.ink.secondary}>
          {ENTERPRISE_EVALUATION.checklistTitle}
        </ProovraText>
        <Bullets items={ENTERPRISE_EVALUATION.checklist} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          {ENTERPRISE_EVALUATION.actions.map((a, i) => (
            linkButton(a, i === 0 ? "primary" : "secondary")
          ))}
        </View>
      </ProovraCard>
      <ProovraCard>
        <ProovraText variant="label" weight="bold" color={theme.color.ink.secondary}>
          {ENTERPRISE_EVALUATION.packetTitle}
        </ProovraText>
        {ENTERPRISE_EVALUATION.packet.map((link) => (
          linkButton(link)
        ))}
      </ProovraCard>

      {/* 7 — Security reviews */}
      <SectionHead {...SECURITY_REVIEWS} />
      {SECURITY_REVIEWS.cards.map((card) => (
        <ProovraCard key={card.title}>
          <ProovraText variant="body" weight="semibold">
            {card.title}
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {card.body}
          </ProovraText>
          <ProovraButton label={card.cta} variant="secondary" onPress={() => open(card.destination)} />
        </ProovraCard>
      ))}
      <ProovraCard>
        {[SECURITY_REVIEWS.vulnerability, SECURITY_REVIEWS.questionnaire].map((note) => (
          <View key={note.title} style={{ gap: theme.space.s1 }}>
            <ProovraText variant="bodySm" weight="semibold">
              {note.title}
            </ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {note.text}
            </ProovraText>
            {linkButton(note.link)}
          </View>
        ))}
      </ProovraCard>

      {/* 8 — Sensitive or legal requests */}
      <SectionHead {...SENSITIVE_REQUESTS} />
      {SENSITIVE_REQUESTS.cards.map((card) => (
        <ProovraCard key={card.title}>
          <ProovraText variant="body" weight="semibold">
            {card.title}
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {card.body}
          </ProovraText>
          <ProovraButton label={card.cta} variant="secondary" onPress={() => open(card.destination)} />
        </ProovraCard>
      ))}

      {/* 9 — Support vs policy */}
      <SectionHead eyebrow={SUPPORT_VS_POLICY.eyebrow} heading={SUPPORT_VS_POLICY.heading} />
      <ProovraCard>
        <View style={{ flexDirection: "row" }}>
          <ProovraBadge label={SUPPORT_VS_POLICY.here.badge} tone="neutral" />
        </View>
        <ProovraText variant="body" weight="semibold">
          {SUPPORT_VS_POLICY.here.title}
        </ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {SUPPORT_VS_POLICY.here.body}
        </ProovraText>
        <View style={{ flexDirection: "row" }}>
          <ProovraBadge label={SUPPORT_VS_POLICY.here.marker} tone="neutral" />
        </View>
      </ProovraCard>
      <ProovraCard>
        <View style={{ flexDirection: "row" }}>
          <ProovraBadge label={SUPPORT_VS_POLICY.policy.badge} tone="neutral" />
        </View>
        <ProovraText variant="body" weight="semibold">
          {SUPPORT_VS_POLICY.policy.title}
        </ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {SUPPORT_VS_POLICY.policy.body}
        </ProovraText>
        <ProovraButton
          label={SUPPORT_VS_POLICY.policy.cta}
          variant="secondary"
          onPress={() => open(SUPPORT_VS_POLICY.policy.destination)}
        />
      </ProovraCard>

      {/* 10 — Helpful resources */}
      <SectionHead eyebrow={HELPFUL_RESOURCES.eyebrow} heading={HELPFUL_RESOURCES.heading} />
      {HELPFUL_RESOURCES.groups.map((group) => (
        <ProovraCard key={group.title}>
          <ProovraText variant="label" weight="bold" color={theme.color.accent.a500}>
            {group.title}
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {group.subtitle}
          </ProovraText>
          {group.links.map((link) => (
            linkButton(link)
          ))}
        </ProovraCard>
      ))}

      {/* 11 — Final CTA */}
      <SectionHead {...SUPPORT_FINAL_CTA} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        {SUPPORT_FINAL_CTA.actions.map((a, i) => (
          linkButton(a, i === 0 ? "primary" : "secondary")
        ))}
      </View>
    </ProovraScreen>
  );
}
