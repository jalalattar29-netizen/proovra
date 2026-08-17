/**
 * PHASE 13 — the ONE genuinely-signed SAML fixture in this repository.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `phase-8-saml-signed-fixture.test.ts` proved the PRODUCTION validator
 * (`validateSamlResponse`) against real signed XML. The Phase-13 runtime
 * mandate additionally requires the same forgery classes to be driven through
 * the REGISTERED ACS ROUTE against a real database — a validator call and an
 * HTTP request are different proofs, and only the second one shows what the
 * deployed service does.
 *
 * Two suites therefore need the same keypair and the same builder. Copying it
 * would create a second SAML fixture authority that could drift from the
 * first, so the builder was EXTRACTED here and both suites import it. Nothing
 * about the fixture changed in the move: same key, same certificate, same
 * signing algorithm, same element ordering.
 *
 * TEST-ONLY. This keypair is generated for the suite, is committed
 * deliberately, and signs nothing outside it. It is not a credential: it
 * grants access to no system, and the API only trusts it because a test
 * fixture row pins this exact certificate on an `SsoConnection` inside a
 * disposable database.
 */

import { Buffer } from "node:buffer";

import { SignedXml } from "xml-crypto";

// Static test IdP keypair + self-signed cert (generated once; test-only).
const IDP_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDOaxkVivPEQMxR
mtrqElrAxd9Hfg6IvrnmmDeUTosU6TCXPeOShwVb2I4B48+dib1l6GwSUC1ejLKw
w/EHdb/ImfYWYvNh1NyVcNAhj+kfMKDYEVJqlLIIcnREUgPX3BFIIgtzEn0iEz7V
4bAfQd85P+vIbUV5yjQqJjFRiGUoDwOZLEgds7rs3+7OSYNjbOCfGhdcPGJt6RJ1
vaGnvZrzuI22Q4l72WuYrT48/8oca9Y3oKRk+IS5VIMXlkhmsj0NmuyS2SCbdmXg
3y2GdGjiohDGkaxleXTRW7rDmB6/vEenthWgJqbJYGYpp8se12CRgUMcQZzdT1Dk
hZM/nTrLAgMBAAECggEAFfbMaP/rl1bjxs0o/R4t3PRRIVzW9BMDWfeZdmTzJKr5
eiZiOD24wsCkv6u7dEJrTlQwZ7RzV2u2OdvnokkTuqczSceGqULKo/Yol2GmRyTY
AJW7RM8EsKRpHbnyYb4vcpL4z+pIOV994KlOoczTEVbtYlrKOT7cVR3SQqA2T1A0
pMxNE70sp4t5Tmo76NnbySgfutGLNdDlt/cJoanXZZZOIO6Oz43P9H48uu8yKKhP
CUah2oGa4JyxigrmSjTIYXv0CjibP5LrBtbjBh+zvtGvW9hIpoNXld4C8b7kc2Dt
KnUbgLKkUEqcK0p1gokD8wbzA5e29GufzAS4nk4g7QKBgQD1sljXXkljTfuckc95
ufvvSWQIhFjzgVQln6Ulp9lmjgAle69IAYDPA1QVHEpgrCYmtp0s6zxtfWwj5s2T
wK35liSLJ4pjLq+0s4HyWeHi6g9bI8eR1X9/lssll8/ancMneKu64w0IxnQzhvaG
br+ybXyyFrfwPTU0rUsHfWfK9wKBgQDXExUVTPYjr42+xk3vxyX+T7ZbF8qK5xI8
HhNJS410rgz/k73pxczDVp8aqFaDFg69x/ym9JG7MWydkjvot+RXNQEbt9M15t5r
80Xs0LukzpQ1RuE2j8Gj+yAp/E2qH2O7KTY5j0MGsY6NDo+vg+3QBdh5zP7Qwwdv
XAxuwaYlzQKBgBulG5XwB/XiemMdjOi3Yn+EFHtY2OFdNeid0+kuv6loZN/S0OAb
OzEPwNA3RK8n74r/lSPOvBfduuM3Pv5W+bxRhn8ZzdpnEGIWqJJqRp5Pk7a/id8A
1L24a9cpA7wncCPq0ffPQFIycjSyBN8PawZah2NKZxvi5y+sJ/sJwzn1AoGBAKRd
g/5MW8t37aa/XG6Dzshk2OMS8opm/2uMPIcGQ2vJXEux+DCBJvSd7WftAHib0dY9
0Rsyy3C4294sFLbMWqg+7MLnIHYQIylyuJy8BLt12JRCv/j3sjAEylbr59q8tHYj
j7o7fyjNZzjryOmEtKkG3qJvBMo8UiFLwoCeY8B9AoGAJ+P2gnKdM7/+ABPxJzjp
9iBkDwwnW9n1nFywBeszly0p4pqCZ+VGZ15T8XK/T3dT59RWGMFGVjligXjETvia
pw/XYwjGVvf0SXbPfo6ICCIrg6T3Ixl6kbfwxoYXInSijBC82TCEvBf4pBp/b/Hf
8pOgyUboLFx8D/fdWki2YdQ=
-----END PRIVATE KEY-----`;

// The IdP X.509 cert as base64 DER (no PEM headers) — the exact shape
// SsoConnection.samlCertificate stores and validateSamlResponse expects.
export const IDP_CERT_B64 =
  "MIIDIzCCAgugAwIBAgIUOVQwR07Q2m8qrx0tkNNHWa6aK+8wDQYJKoZIhvcNAQELBQAwIDEeMBwGA1UEAwwVcHJvb3ZyYS1zYW1sLXRlc3QtaWRwMCAXDTI2MDcyMjA4MjQ1MVoYDzIxMjYwNjI4MDgyNDUxWjAgMR4wHAYDVQQDDBVwcm9vdnJhLXNhbWwtdGVzdC1pZHAwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDOaxkVivPEQMxRmtrqElrAxd9Hfg6IvrnmmDeUTosU6TCXPeOShwVb2I4B48+dib1l6GwSUC1ejLKww/EHdb/ImfYWYvNh1NyVcNAhj+kfMKDYEVJqlLIIcnREUgPX3BFIIgtzEn0iEz7V4bAfQd85P+vIbUV5yjQqJjFRiGUoDwOZLEgds7rs3+7OSYNjbOCfGhdcPGJt6RJ1vaGnvZrzuI22Q4l72WuYrT48/8oca9Y3oKRk+IS5VIMXlkhmsj0NmuyS2SCbdmXg3y2GdGjiohDGkaxleXTRW7rDmB6/vEenthWgJqbJYGYpp8se12CRgUMcQZzdT1DkhZM/nTrLAgMBAAGjUzBRMB0GA1UdDgQWBBRKgJwQogazEHBQhoYNNKQGsN1phjAfBgNVHSMEGDAWgBRKgJwQogazEHBQhoYNNKQGsN1phjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCR2p5mQH84lbczWqtYY6mnYiKNW8zTN3OX4sJewfjNGN34szlgA5KMKl3uTp5goJMwXqRmhgdhQwfTKlZtsaCAHxdT+dnDyRo/TvRgBceBi8gRH4pbx1QjxvIxyjoO/vn5oS0gktCbMkcdTtPTfYnSMqCpCMNG4gCkqF6r8MHOAnEFMha2yF60wZre9ZUxc8mOT4Vfs/cVgL/cCP72vxD7i8hu1vCYJln0ULpPzrvFRNFkf/cBQE/v7h4zzUgAiy0QUXM5BAWTU+yJ4+LvTIWZRZeJSvxKjgc/dnNAYSuengbw6P3Dg/YrXENe7Q/+jOU9YoP+ZGdDFLAXMv7BMh2W";

export const SP_ENTITY_ID = "https://app.proovra.com/saml/metadata/conn-1";
export const IDP_ISSUER = "https://idp.example.com/entity";
export const ACS_URL = "https://app.proovra.com/v1/auth/saml/acs";

export type SignedSamlOpts = {
  audience?: string | null; // null → omit AudienceRestriction entirely
  notBefore?: Date;
  notOnOrAfter?: Date;
  issuer?: string;
  inResponseTo?: string;
  destination?: string | null; // null → omit Response @Destination
  recipient?: string | null; // null → omit SubjectConfirmationData @Recipient
};

export function buildSignedSamlResponse(o: SignedSamlOpts = {}): string {
  const now = Date.now();
  const nb = (o.notBefore ?? new Date(now - 60_000)).toISOString();
  const noa = (o.notOnOrAfter ?? new Date(now + 5 * 60_000)).toISOString();
  const issuer = o.issuer ?? IDP_ISSUER;
  const inResponseTo = o.inResponseTo ?? "authn-req-1";
  const audienceXml =
    o.audience === null
      ? ""
      : `<saml:AudienceRestriction><saml:Audience>${o.audience ?? SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>`;
  const destination = o.destination === null ? "" : ` Destination="${o.destination ?? ACS_URL}"`;
  const recipient = o.recipient === null ? "" : ` Recipient="${o.recipient ?? ACS_URL}"`;
  const scdXml = `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${recipient} NotOnOrAfter="${new Date(now + 300000).toISOString()}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation>`;

  const assertionId = "_assertion1";
  const responseXml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response1"${destination} InResponseTo="${inResponseTo}" Version="2.0" IssueInstant="${new Date(now).toISOString()}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${new Date(now).toISOString()}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID>${scdXml}</saml:Subject><saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}">${audienceXml}</saml:Conditions><saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;

  const sig = new SignedXml({
    privateKey: IDP_PRIVATE_KEY_PEM,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: `//*[local-name(.)='Assertion']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(responseXml, {
    location: {
      reference: `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`,
      action: "after",
    },
  });
  return Buffer.from(sig.getSignedXml(), "utf8").toString("base64");
}
