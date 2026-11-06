/**
 * PRO-074 (UI-03) — recent searches and "preferences" consent.
 *
 * Reproduced by the audit: (A) Accept all, search, Reject all: the legacy key
 * and chat hint were removed, but `proovra:tenant:<ws>:search:recent` stayed,
 * because the purge listed only the pre-canonical `proovra:search:recent:`
 * prefix. (B) Reject all first, then search: the key was written anyway.
 *
 * Runs against the real consent store, the real purge and the real storage
 * authority the search page uses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONSENT_VERSION, clearNonEssentialStorage, saveConsentState } from "../../lib/consent";
import {
  clearRecentSearches,
  readRecentSearches,
  recentSearchesKey,
  writeRecentSearches,
} from "../../lib/search/recent-searches";

const WS = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "33333333-3333-4333-8333-333333333333";

function consent(preferences: boolean) {
  saveConsentState({
    necessary: true,
    preferences,
    analytics: false,
    marketing: false,
    consentVersion: CONSENT_VERSION,
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("PRO-074: recent searches follow preferences consent", () => {
  it("canonical key is the tenant namespace", () => {
    expect(recentSearchesKey(WS)).toBe(`proovra:tenant:${WS}:search:recent`);
  });

  it("(B) without consent a search is not written to the device", () => {
    consent(false);
    expect(writeRecentSearches(WS, ["UIA-CONSENT-PROBE-B"])).toBe(false);
    expect(window.localStorage.getItem(recentSearchesKey(WS))).toBeNull();
    expect(readRecentSearches(WS)).toEqual([]);
  });

  it("positive control: with consent it is written and read back", () => {
    consent(true);
    expect(writeRecentSearches(WS, ["a", "b"])).toBe(true);
    expect(readRecentSearches(WS)).toEqual(["a", "b"]);
  });

  it("(A) withdrawing consent purges every workspace's recent searches", () => {
    consent(true);
    writeRecentSearches(WS, ["UIA-CONSENT-PROBE-A"]);
    writeRecentSearches(OTHER_WS, ["other"]);
    window.localStorage.setItem(`proovra:search:recent:${WS}`, JSON.stringify(["legacy"]));
    window.localStorage.setItem("proovra-chat-hint-seen", "1");
    // Necessary storage that must survive the purge.
    window.localStorage.setItem(`proovra:tenant:${WS}:capture:draft`, "keep");

    consent(false);
    clearNonEssentialStorage({ preferences: true, analytics: false, marketing: false });

    expect(window.localStorage.getItem(recentSearchesKey(WS))).toBeNull();
    expect(window.localStorage.getItem(recentSearchesKey(OTHER_WS))).toBeNull();
    expect(window.localStorage.getItem(`proovra:search:recent:${WS}`)).toBeNull();
    expect(window.localStorage.getItem("proovra-chat-hint-seen")).toBeNull();
    expect(window.localStorage.getItem(`proovra:tenant:${WS}:capture:draft`)).toBe("keep");
  });

  it("a value written before consent was refused does not survive a read without consent", () => {
    window.localStorage.setItem(recentSearchesKey(WS), JSON.stringify(["stale"]));
    consent(false);
    expect(readRecentSearches(WS)).toEqual([]);
    expect(window.localStorage.getItem(recentSearchesKey(WS))).toBeNull();
  });

  it("the legacy key migrates on a consented read and is removed", () => {
    consent(true);
    window.localStorage.setItem(`proovra:search:recent:${WS}`, JSON.stringify(["old"]));
    expect(readRecentSearches(WS)).toEqual(["old"]);
    expect(window.localStorage.getItem(`proovra:search:recent:${WS}`)).toBeNull();
    clearRecentSearches(WS);
    expect(window.localStorage.getItem(recentSearchesKey(WS))).toBeNull();
  });
});
