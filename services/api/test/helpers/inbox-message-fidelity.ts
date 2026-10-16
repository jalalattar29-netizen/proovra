/**
 * Every inbox item the live route returns says the same thing in its English
 * `title` / `body` and in its structured `message` rendered in English, and
 * the message is complete in German and Arabic: no unfilled placeholder, no
 * raw code, and not the English text again. A history row written before
 * messages existed carries none and is left to its stored text.
 */
import { expect } from "vitest";
import { renderNotificationMessage, readNotificationMessage } from "@proovra/shared/i18n";

type Row = { itemKey: string; title: string; body: string | null; message?: unknown };

const RAW_CODE = /\b[A-Z]{2,}(?:_[A-Z0-9]{2,})+\b/;

export function expectFaithfulInboxMessages(items: ReadonlyArray<Row>, opts: { allowMissing?: boolean } = {}): void {
  for (const item of items) {
    const message = readNotificationMessage(item.message);
    if (!message) {
      expect(opts.allowMissing, `${item.itemKey} carries no message`).toBe(true);
      continue;
    }
    const en = renderNotificationMessage("en", message);
    if (en === null) {
      // The one documented fallback: a collaboration notification of a type
      // the shared vocabulary does not name keeps the server's text.
      expect(message.key, `${item.itemKey}: unknown message key ${message.key}`).toBe("collaboration");
      continue;
    }
    expect(en!.title, `${item.itemKey} title`).toBe(item.title);
    expect(en!.body, `${item.itemKey} body`).toBe(item.body ?? "");
    for (const locale of ["de", "ar"] as const) {
      const said = renderNotificationMessage(locale, message)!;
      expect(said.title, `${item.itemKey} ${locale} title`).not.toMatch(/\{\w+\}/);
      expect(said.body, `${item.itemKey} ${locale} body`).not.toMatch(/\{\w+\}/);
      expect(said.title, `${item.itemKey} ${locale} title leaks a code`).not.toMatch(RAW_CODE);
      expect(said.title, `${item.itemKey} ${locale} title is still English`).not.toBe(en!.title);
    }
  }
}
