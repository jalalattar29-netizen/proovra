# Integration Logos

Drop official brand SVG (preferred) or PNG files here. The `/platform`
Integrations grid will automatically render an `<img>` when the file exists
and fall back to a colored wordmark when it doesn't.

## Required filenames

Use kebab-case, no spaces. The component maps each integration to its
filename via `logoSrc` in `apps/web/app/platform/page.tsx`.

| Filename                  | Brand            | Source                                  |
| ------------------------- | ---------------- | --------------------------------------- |
| microsoft-365.svg         | Microsoft 365    | brand.microsoft.com                     |
| google-workspace.svg      | Google Workspace | about.google/brand-resource-center      |
| aws.svg                   | AWS              | aws.amazon.com/architecture/icons       |
| azure.svg                 | Microsoft Azure  | brand.microsoft.com                     |
| okta.svg                  | Okta             | okta.com/press-room/media-assets        |
| onelogin.svg              | OneLogin         | onelogin.com/company/press              |
| openai.svg                | OpenAI           | openai.com/brand                        |
| sentry.svg                | Sentry           | sentry.io/branding                      |
| grafana.svg               | Grafana          | grafana.com/about/brand-guidelines      |
| upstash.svg               | Upstash          | upstash.com (press kit)                 |
| resend.svg                | Resend           | resend.com/brand                        |
| twilio.svg                | Twilio           | twilio.com/company/news/press-resources |
| stripe.svg                | Stripe           | stripe.com/newsroom/brand-assets        |
| paypal.svg                | PayPal           | newsroom.paypal-corp.com/media-resources|
| box.svg                   | Box              | box.com/about-us/press                  |
| opentimestamps.svg        | OpenTimestamps   | opentimestamps.org                      |

Items rendered with built-in PROOVRA outline icons (no asset needed):
SFTP, Webhook, Custom API, + More.

## Sizing

Render box is `48 × 28 px`. Logos should be SVG with `viewBox="0 0 _ _"`
so they scale cleanly. Crop tight to mark + wordmark, no surrounding padding.
