/**
 * Typed access to the chain-record fixture helpers of
 * packages/shared/tests/helpers/ots-fixtures.mjs (its .d.mts does not declare
 * `chainRecordFor` / `chainColumnsFor`). Test-only; no behaviour of its own.
 */
import * as fixtures from "../../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import type { UpgradedProof } from "../../../../packages/shared/tests/helpers/ots-fixtures.mjs";

export type ChainFixtureOptions = {
  status?: "NOT_CONFIGURED" | "UNAVAILABLE" | "INSUFFICIENT_CONFIRMATIONS" | "FAILED" | "VERIFIED";
  checkedAtUtc?: string;
  verifiedAtUtc?: string;
  blockHeight?: number;
  blockHash?: string;
  blockTimeUtc?: string;
  confirmations?: number;
  verifier?: string;
  min?: number;
  proofSha256?: string;
  failureCode?: string;
};

export type ChainFixtureRecord = {
  status: string;
  checkedAtUtc: string;
  verifiedAtUtc: string | null;
  blockHeight: number | null;
  blockHash: string | null;
  blockTimeUtc: string | null;
  confirmations: number | null;
  verifier: string;
  failureCode: string | null;
};

export type ChainFixtureColumns = {
  otsChainVerificationStatus: string;
  otsChainCheckedAtUtc: string;
  otsChainVerifiedAtUtc: string | null;
  otsChainBlockHeight: number | null;
  otsChainBlockHash: string | null;
  otsChainBlockTimeUtc: string | null;
  otsChainConfirmations: number | null;
  otsChainVerifier: string;
  otsChainFailureCode: string | null;
};

const untyped = fixtures as unknown as {
  chainRecordFor: (up: UpgradedProof, o?: ChainFixtureOptions) => ChainFixtureRecord;
  chainColumnsFor: (up: UpgradedProof, o?: ChainFixtureOptions) => ChainFixtureColumns;
};

export const chainRecordFor = untyped.chainRecordFor;
export const chainColumnsFor = untyped.chainColumnsFor;
