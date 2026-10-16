import test from "node:test";
import assert from "node:assert/strict";

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_READ_VIEWS,
  NOTIFICATIONS_HOME_PATH,
  isNotificationReadView,
  notificationCategoryLabel,
  notificationLocale,
  notificationReadStateLabel,
  notificationReadStateParam,
  notificationReadViewExplanation,
  notificationReadViewLabel,
  notificationSourceLabel,
  notificationSourceLabels,
  notificationToneLabel,
  safeNotificationHref,
} from "../dist/i18n.js";
import * as root from "../dist/index.js";

const LOCALES = ["en", "de", "ar"];
// A raw identifier: SCREAMING_SNAKE, snake_case, or a bare category code.
const RAW = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z]+_[a-z_]+\b/;

test("the presentation authority is reachable from both the root and the i18n entry", () => {
  assert.equal(root.notificationCategoryLabel, notificationCategoryLabel);
});

test("every category has a reviewed, non-raw label in EN, DE and AR — and they differ per locale", () => {
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const locale of LOCALES) {
      const label = notificationCategoryLabel(locale, category);
      assert.ok(label.trim().length > 0, `${locale}/${category} empty`);
      assert.doesNotMatch(label, RAW, `${locale}/${category} raw: ${label}`);
      assert.notEqual(label, category);
    }
    // EN and AR always differ; DE may legitimately share a loanword with EN
    // (e.g. "Info"), so only AR is required to be distinct from both.
    assert.notEqual(notificationCategoryLabel("ar", category), notificationCategoryLabel("en", category));
  }
});

test("Arabic labels are Arabic script", () => {
  for (const category of NOTIFICATION_CATEGORIES) {
    assert.match(notificationCategoryLabel("ar", category), /[؀-ۿ]/);
  }
});

test("an unknown future category renders a neutral generic label — never the code", () => {
  for (const locale of LOCALES) {
    const label = notificationCategoryLabel(locale, "quantum_entanglement_failure");
    assert.doesNotMatch(label, RAW);
    assert.ok(!label.includes("quantum"));
  }
  assert.equal(notificationCategoryLabel("en", undefined), "Notification");
  assert.equal(notificationCategoryLabel("en", ""), "Notification");
});

test("source labels never leak identifiers and are de-duplicated", () => {
  const labels = notificationSourceLabels("en", ["discussion_mention", "made_up_source", "another_unknown"]);
  assert.deepEqual(labels, ["Mention", "Other notifications"]);
  for (const locale of LOCALES) {
    assert.doesNotMatch(notificationSourceLabel(locale, "made_up_source"), RAW);
  }
});

test("locale resolution: region tags collapse, unsupported locales fall back to English", () => {
  assert.equal(notificationLocale("de-AT"), "de");
  assert.equal(notificationLocale("ar-SA"), "ar");
  assert.equal(notificationLocale("fr"), "en");
  assert.equal(notificationLocale(null), "en");
  assert.equal(notificationCategoryLabel("fr", "discussion_mention"), "Mention");
});

test("All / Unread / Read: three views, each with copy in every locale and a wire value", () => {
  assert.deepEqual([...NOTIFICATION_READ_VIEWS], ["all", "unread", "read"]);
  assert.equal(notificationReadStateParam("all"), "any");
  assert.equal(notificationReadStateParam("unread"), "unread");
  assert.equal(notificationReadStateParam("read"), "read");
  assert.ok(isNotificationReadView("read"));
  assert.ok(!isNotificationReadView("archived"));
  for (const locale of LOCALES) {
    for (const view of NOTIFICATION_READ_VIEWS) {
      assert.ok(notificationReadViewLabel(locale, view).length > 0);
      assert.ok(notificationReadViewExplanation(locale, view).length > 0);
    }
    assert.notEqual(notificationReadStateLabel(locale, true), notificationReadStateLabel(locale, false));
  }
  assert.equal(notificationReadViewLabel("de", "read"), "Gelesen");
});

test("tones have labels; an unknown tone reads as the quietest one", () => {
  assert.equal(notificationToneLabel("en", "critical"), "Critical");
  assert.equal(notificationToneLabel("de", "high"), "Hoch");
  assert.equal(notificationToneLabel("en", "EXTREME"), "Info");
});

test("deep links: only internal app paths survive; everything else opens the Notifications page", () => {
  assert.equal(safeNotificationHref("/evidence/abc?tab=discussion&thread=t1"), "/evidence/abc?tab=discussion&thread=t1");
  for (const bad of ["", "https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evidence/abc", "/a b", null, undefined]) {
    assert.equal(safeNotificationHref(bad), NOTIFICATIONS_HOME_PATH, String(bad));
  }
});
