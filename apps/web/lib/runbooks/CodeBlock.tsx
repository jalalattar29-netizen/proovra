"use client";

/**
 * A FENCED BLOCK AN OPERATOR CAN ACTUALLY USE.
 *
 * =============================================================================
 * WHY THIS IS NOT JUST A <pre>
 * =============================================================================
 * Runbook code fences are commands, and a command in an incident gets RUN. It
 * was rendered as a plain `<pre>`, so using one meant selecting text out of a
 * dark block that scrolls horizontally — at 3am, with a shell already open,
 * and with a `psql` invocation that wraps. Selecting the wrong half of a
 * destructive statement is a real failure mode and it is entirely avoidable.
 *
 * =============================================================================
 * WHY THE LANGUAGE LABEL IS SHOWN
 * =============================================================================
 * The corpus fences `bash`, `sql`, `json` and a few others. Whether a block is
 * a shell command or a JSON payload changes what an operator does with it, and
 * the fence already carries that fact — it simply was not rendered.
 *
 * A11Y: the control is a real button with an accessible name that changes on
 * success, and the result is announced through a live region rather than only
 * drawn. The `<pre>` keeps its own tab stop because it scrolls: a scrollable
 * region that cannot be reached by keyboard has unreachable content.
 */

import { useCallback, useState } from "react";

export function RunbookCodeBlock({
  body,
  lang,
}: {
  body: string;
  lang?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(body)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_800);
      })
      .catch(() => {
        /* A clipboard the browser refuses is not worth a banner: the text is
           still selectable, which is exactly where this started. */
      });
  }, [body]);

  return (
    <div className="rb-codeblock">
      <div className="rb-codeblock__bar">
        <span className="rb-codeblock__lang">{lang || "text"}</span>
        <button
          type="button"
          className="rb-codeblock__copy"
          onClick={copy}
          aria-label={copied ? "Command copied" : "Copy command"}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="rb-pre" data-lang={lang || undefined} tabIndex={0}>
        <code>{body}</code>
      </pre>
      <span role="status" aria-live="polite" className="app-visually-hidden">
        {copied ? "Command copied to the clipboard" : ""}
      </span>
    </div>
  );
}

export default RunbookCodeBlock;
