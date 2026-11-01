/**
 * IDENT-003, IDENT-004 — what a person and an administrator are told about SSO.
 */
import { describe, expect, it } from "vitest";

import {
  samlAcsUrl,
  samlLoginUrl,
  samlSpMetadataUrl,
  ssoSignInFailureMessage,
} from "../../lib/identity/ssoSignIn";

const params = (query: string) => new URLSearchParams(query);

describe("a failed SSO sign-in says why", () => {
  it("names the cases a person can act on", () => {
    expect(ssoSignInFailureMessage(params("saml_error=saml_browser_mismatch"))).toMatch(/different browser/);
    expect(ssoSignInFailureMessage(params("sso_error=sso_state_replayed"))).toMatch(/already been used/);
    expect(ssoSignInFailureMessage(params("saml_error=seat_limit_reached"))).toMatch(/no seats/);
    expect(ssoSignInFailureMessage(params("sso_error=sso_connection_unavailable"))).toMatch(/not available/);
  });

  it("never echoes a code it does not know, and stays quiet with none", () => {
    const unknown = ssoSignInFailureMessage(params("sso_error=<script>"));
    expect(unknown).not.toContain("<script>");
    expect(unknown).toMatch(/could not be completed/);
    expect(ssoSignInFailureMessage(params("next=/home"))).toBeNull();
  });
});

describe("the URLs an administrator copies into an IdP", () => {
  it("are on the API host, not the page they are read on", () => {
    const api = "https://api.proovra.com";
    expect(samlAcsUrl(api)).toBe("https://api.proovra.com/v1/auth/saml/acs");
    expect(samlSpMetadataUrl(api, "conn 1")).toBe("https://api.proovra.com/v1/auth/saml/metadata/conn%201");
    expect(samlLoginUrl(api, "c1")).toBe("https://api.proovra.com/v1/auth/saml/c1/login");
  });
});
