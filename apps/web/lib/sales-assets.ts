export type SalesAssetConfig = {
  sampleReportUrl: string;
  verificationDemoUrl: string;
  methodologyUrl: string;
  pricingUrl: string;
  requestDemoUrl: string;
  requestDemoSuccessUrl: string;
  contactSalesUrl: string;
  bookingUrl: string | null;
  expectedResponseWindowText: string;
  expectedEnterpriseResponseWindowText: string;
};

export const SALES_ASSETS: SalesAssetConfig = {
  sampleReportUrl: "/brand/sample-report.pdf",
  verificationDemoUrl: "/verify/demo",
  methodologyUrl: "/legal/verification-methodology",
  pricingUrl: "/pricing",
  requestDemoUrl: "/request-demo",
  requestDemoSuccessUrl: "/request-demo/success",
  contactSalesUrl: "/contact-sales",
  bookingUrl: process.env.NEXT_PUBLIC_BOOKING_URL?.trim() || null,
  expectedResponseWindowText: "within 1 business day",
  expectedEnterpriseResponseWindowText: "within 4 business hours",
};

function readPublicWebBase(): string {
  return (
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ||
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ||
    "https://www.proovra.com"
  );
}

export function absoluteWebUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const base = readPublicWebBase();
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function getAbsoluteSalesAssets() {
  return {
    sampleReportUrl: absoluteWebUrl(SALES_ASSETS.sampleReportUrl),
    verificationDemoUrl: absoluteWebUrl(SALES_ASSETS.verificationDemoUrl),
    methodologyUrl: absoluteWebUrl(SALES_ASSETS.methodologyUrl),
    pricingUrl: absoluteWebUrl(SALES_ASSETS.pricingUrl),
    requestDemoUrl: absoluteWebUrl(SALES_ASSETS.requestDemoUrl),
    requestDemoSuccessUrl: absoluteWebUrl(SALES_ASSETS.requestDemoSuccessUrl),
    contactSalesUrl: absoluteWebUrl(SALES_ASSETS.contactSalesUrl),
    bookingUrl: SALES_ASSETS.bookingUrl
      ? absoluteWebUrl(SALES_ASSETS.bookingUrl)
      : null,
  };
}