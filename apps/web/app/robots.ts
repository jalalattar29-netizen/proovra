import type { MetadataRoute } from "next";

/**
 * PRO-PW-06 — crawlers are asked to stay out of every capability URL family
 * (the middleware also sends `X-Robots-Tag: noindex, nofollow, noarchive` on
 * them). Marketing pages stay crawlable. robots.txt is advisory; the header
 * and the tokens' own expiry/revocation are the controls.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/verify/",
          "/share/",
          "/intake/",
          "/invite/",
          "/portal",
          "/org-invites/",
          "/collaboration-teams/invites/",
          "/reset-password",
          "/auth/",
          "/step-up/",
        ],
      },
    ],
  };
}
