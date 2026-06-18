import type { SVGProps } from "react";

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  size?: number;
};

/**
 * Shared marketing glyphs that mirror the hero lifecycle rail's icon
 * treatment. Every glyph renders as a bold, fully-rendered shape so it
 * holds the same visual weight as the hero icons when dropped onto the
 * colored circular badges (`color: white` + `fill: currentColor`).
 *
 * Use these in place of the equivalent thin-stroke lucide icons inside
 * homepage feature/workflow/capability badges to keep the icon system
 * consistent end-to-end.
 */

const sizeFor = (size?: number) => {
  const dim = size ?? 24;
  return { width: dim, height: dim };
};

export function CameraGlyph({ size, ...rest }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      {...sizeFor(size)}
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <path d="M8.2 6.5 9.5 4.8h5l1.3 1.7H18a3 3 0 0 1 3 3v6.7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9.5a3 3 0 0 1 3-3h2.2Zm3.8 10a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4Zm0-2.1a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z" />
    </svg>
  );
}

export function LockGlyph({ size, ...rest }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      {...sizeFor(size)}
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <path d="M7 10V8a5 5 0 0 1 10 0v2h1.2A1.8 1.8 0 0 1 20 11.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19.2v-7.4A1.8 1.8 0 0 1 5.8 10H7Zm2.5 0h5V8a2.5 2.5 0 0 0-5 0v2Z" />
    </svg>
  );
}

export function ShieldCheckGlyph({ size, ...rest }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      {...sizeFor(size)}
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 13.4-3.1-3.1 1.4-1.4 1.7 1.7 4-4 1.4 1.4-5.4 5.4Z" />
    </svg>
  );
}

export function ProveGlyph({ size, ...rest }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      {...sizeFor(size)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      aria-hidden="true"
      {...rest}
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M4.5 12h15" strokeLinecap="round" />
      <path
        d="M12 4c2.2 2.2 3.3 4.9 3.3 8s-1.1 5.8-3.3 8c-2.2-2.2-3.3-4.9-3.3-8s1.1-5.8 3.3-8Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
