function env(name: string): string | undefined {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function webBaseUrl(): string {
  return env("WEB_BASE_URL") ?? "https://www.proovra.com";
}

export type DemoRequestQuickLinks = {
  replyToLeadMailto: string;
  sampleReportUrl: string;
  verificationDemoUrl: string;
  methodologyUrl: string;
  pricingUrl: string;
  bookingUrl: string | null;
  requestDemoUrl: string;
  contactSalesUrl: string;
};

export function getDemoRequestQuickLinks(email: string): DemoRequestQuickLinks {
  const base = webBaseUrl().replace(/\/+$/, "");

  const rawBooking =
    env("BOOKING_URL") ?? env("NEXT_PUBLIC_BOOKING_URL") ?? null;

  const bookingUrl =
    rawBooking && rawBooking.startsWith("http")
      ? rawBooking
      : rawBooking
      ? `${base}/${rawBooking.replace(/^\/+/, "")}`
      : null;

  const subject = encodeURIComponent("Re: Your PROOVRA demo request");
  const body = encodeURIComponent(
    "Thank you for your interest in PROOVRA.\n\nI’m following up on your request and sharing a few resources below."
  );

  return {
    replyToLeadMailto: `mailto:${encodeURIComponent(
      email
    )}?subject=${subject}&body=${body}`,
    sampleReportUrl: `${base}/brand/sample-report.pdf`,
    verificationDemoUrl: `${base}/verify/demo`,
    methodologyUrl: `${base}/legal/verification-methodology`,
    pricingUrl: `${base}/pricing`,
    bookingUrl,
    requestDemoUrl: `${base}/request-demo`,
    contactSalesUrl: `${base}/contact-sales`,
  };
}