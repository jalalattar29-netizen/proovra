/**
 * TechnicalDisclosure — the ONE disclosure anatomy for the Technical
 * Appendix.
 *
 * The tab previously carried five hand-rolled `<details>` blocks plus a
 * sixth inside FullExifAccordion, each with its own summary styling and a
 * text-glyph chevron ("▸" / "▾"). A glyph is content: it reflows, it is read
 * out, and it cannot mirror reliably in Arabic. This consolidates them into
 * one component with an SVG chevron that rotates on state.
 *
 * Native `<details>`/`<summary>` is kept, so Enter/Space activation, focus
 * and the expanded state are the browser's rather than a reimplementation.
 * `aria-expanded` and an `aria-controls`/`id` pair onto a labelled region are
 * added on top, so assistive technology gets the relationship spelled out.
 */

"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function TechnicalDisclosure({
  title,
  children,
  defaultOpen = false,
  leading,
  trailing,
  ...rest
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /**
   * Optional semantic state icon, in its OWN leading column.
   *
   * It used to sit inside the status badge, so the badge's width varied with
   * it while the label's width varied with the text — and the summary row was
   * `display: flex`, which pushed every later column out of line behind the
   * longest label. The five parts each have their own grid track now.
   */
  leading?: ReactNode;
  /** Optional content pinned to the logical end of the summary row. */
  trailing?: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <details
      className="ta-accordion"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
      {...rest}
    >
      <summary
        className="ta-accordion-summary"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="ta-accordion-summary__lead" aria-hidden="true">
          {leading}
        </span>
        <span className="ta-accordion-summary__text">{title}</span>
        {trailing}
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          className="ta-accordion-chevron"
        />
      </summary>
      <div
        id={panelId}
        role="region"
        aria-label={title}
        className="ta-accordion-body"
      >
        {children}
      </div>
    </details>
  );
}
