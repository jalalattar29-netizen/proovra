/**
 * B1-F-004 (free-audit 0ea0) — ONE PERSON, ONE SELF-SERVE ACCOUNT PER VERIFIED ADDRESS.
 *
 * Sign-in resolves by the provider-verified subject only (anti-takeover): an
 * email match never authenticates, merges or links. What it may do is REFUSE TO
 * OPEN A SECOND account for an address an existing personal account already
 * holds verified — a Google/Apple sign-in for a password account's address, or a
 * password registration for a Google/Apple account's address. Each would
 * otherwise be a second identity with its own personal workspace and Free
 * allowance (D-03). The person is told to sign in to the account they have and
 * connect the other method there (identity-links.routes.ts, step-up gated).
 *
 * WHICH ACCOUNTS HOLD AN ADDRESS (all must hold):
 *   - the address is VERIFIED on the account (`emailVerifiedAt`). An unverified
 *     row proves nothing about the mailbox (PROV-001): a stranger's unfinished
 *     password registration must not lock the mailbox owner out of Google;
 *   - a self-serve identity: provider EMAIL / GOOGLE / APPLE, identity mode
 *     STANDARD. A MANAGED_ENTERPRISE identity is org-controlled and SSO-only,
 *     and a row an Organization's directory or IdP created (`scim-` / `sso-` /
 *     `saml-` provider id, enterprise-account-linking.service.ts) is the
 *     Organization's, not the mailbox owner's (IDENT-013) — neither blocks a
 *     personal account and neither is ever linked or repaired here;
 *   - not closed (`closed:` provider id, account-closed.ts): a closed account
 *     cannot be signed in to, and a password registration for its address is
 *     already allowed.
 *
 * Callers that CREATE an account take {@link lockAccountAddress} first, inside
 * the creating transaction, so a concurrent password registration and a
 * first-time Google/Apple sign-in for one address serialise and the second
 * sees the first.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type UserReader = Pick<PrismaClient, "user"> | Pick<Prisma.TransactionClient, "user">;
type RawExecutor = Pick<Prisma.TransactionClient, "$executeRaw">;

export function normalizeAccountAddress(email: string): string {
  return email.trim().toLowerCase();
}

/** The per-address lock both account-creating paths take (pg_advisory_xact_lock). */
export async function lockAccountAddress(tx: RawExecutor, email: string): Promise<void> {
  const key = `account-address:${normalizeAccountAddress(email)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export type AddressHolder = { id: string; provider: "EMAIL" | "GOOGLE" | "APPLE" };

/** The existing self-serve account holding `email` verified, or null. */
export async function findSelfServeAccountHoldingAddress(
  client: UserReader,
  email: string,
): Promise<AddressHolder | null> {
  const address = normalizeAccountAddress(email);
  if (!address) return null;
  const row = await (client.user as PrismaClient["user"]).findFirst({
    where: {
      email: { equals: address, mode: "insensitive" },
      emailVerifiedAt: { not: null },
      identityMode: "STANDARD",
      provider: { in: ["EMAIL", "GOOGLE", "APPLE"] },
      NOT: [
        { providerUserId: { startsWith: "closed:" } },
        { providerUserId: { startsWith: "scim-" } },
        { providerUserId: { startsWith: "sso-" } },
        { providerUserId: { startsWith: "saml-" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, provider: true },
  });
  return row ? { id: row.id, provider: row.provider as AddressHolder["provider"] } : null;
}

/**
 * Thrown by the Google/Apple sign-in when a first-time provider subject carries
 * a VERIFIED address an existing personal account holds. Nothing was created.
 * The route answers 409 with this code; no account id or sign-in method is
 * disclosed (the person proved the mailbox, but nothing more is needed).
 */
export class ExistingAccountSignInRequiredError extends Error {
  readonly code = "EXISTING_ACCOUNT_SIGN_IN_REQUIRED" as const;
  constructor() {
    super("An account already holds this verified address");
    this.name = "ExistingAccountSignInRequiredError";
  }
}

export const EXISTING_ACCOUNT_SIGN_IN_REQUIRED = "EXISTING_ACCOUNT_SIGN_IN_REQUIRED" as const;
