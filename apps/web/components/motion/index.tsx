"use client";

// Shared scroll-reveal motion primitives used across the PROOVRA marketing
// surface. Built on the browser's IntersectionObserver and CSS transitions —
// no external animation library dependency. Single source of truth so
// heading, body, section, and stagger reveals look identical on every page.
//
// All primitives respect `prefers-reduced-motion` via window.matchMedia.
// When reduced motion is active they render in a non-animated fallback
// (instant final state).
//
// Re-trigger behavior: reveals replay when an element leaves and re-enters
// the viewport on both scroll-down and scroll-up. Pass amount={...} to
// tune the IntersectionObserver threshold per surface.

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

// Eased curve shared across reveals. Kept as a tuple so existing callers
// that destructured it still typecheck; the runtime uses the matching
// CSS cubic-bezier string below.
export const REVEAL_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const REVEAL_EASE_CSS = "cubic-bezier(0.22, 1, 0.36, 1)";

const SECTION_DURATION_MS = 650;
const HEADING_WORD_DURATION_MS = 450;
const HEADING_WORD_STAGGER_MS = 45;
const PARAGRAPH_DURATION_MS = 500;
const REVEAL_ITEM_DURATION_MS = 550;
const STAGGER_CHILD_MS = 80;
const STAGGER_INITIAL_DELAY_MS = 100;

/* ─── hooks ─────────────────────────────────────────────────────────── */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange);
    } else {
      // Safari < 14 fallback
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mql as any).addListener?.(onChange);
    }
    return () => {
      if (mql.removeEventListener) {
        mql.removeEventListener("change", onChange);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mql as any).removeListener?.(onChange);
      }
    };
  }, []);
  return reduced;
}

function useInView(
  ref: RefObject<Element | null>,
  amount: number,
  once: boolean,
): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    // Trust Center fix (2026-06-23): the previous implementation passed
    // `{ threshold: amount }` (default 0.18). IntersectionObserver
    // thresholds are computed as the fraction of the OBSERVED ELEMENT
    // that is visible inside the viewport. For sections taller than
    // ~5.5× the viewport height (multi-column documentation hubs,
    // multi-card foundation grids, mapped TRUST_CENTER_SECTIONS bands)
    // that fraction can NEVER reach 18% no matter how the user scrolls,
    // because at most `viewportHeight / sectionHeight` of the element
    // is visible at once. The observer never fired, the wrapper stayed
    // at `opacity: 0`, and the section appeared to "disappear" on long
    // pages. Switching to `{ threshold: 0, rootMargin: '0px 0px -X% 0px' }`
    // is the standard scroll-reveal pattern: the reveal fires when the
    // element's bounding box touches a viewport that has been shrunk by
    // `amount × 100%` from the bottom — robust for elements of any
    // height, and matches the pre-fix trigger timing for normal-sized
    // sections.
    const offsetPct = Math.round(
      Math.min(Math.max(amount, 0), 0.95) * 100,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      {
        threshold: 0,
        rootMargin: `0px 0px -${offsetPct}% 0px`,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, amount, once]);
  return inView;
}

/* ─── Section scene — enters from up / left / right on scroll ───────── */

const SECTION_HIDDEN_TRANSFORM: Record<"up" | "left" | "right", string> = {
  up: "translateY(36px)",
  left: "translateX(-48px)",
  right: "translateX(48px)",
};

export function RevealSection({
  children,
  direction = "up",
  className,
  amount = 0.18,
}: {
  children: ReactNode;
  direction?: "up" | "left" | "right";
  className?: string;
  amount?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(ref, amount, false);
  const visible = reduced || inView;

  const style: CSSProperties = {
    transition: reduced
      ? "none"
      : `opacity ${SECTION_DURATION_MS}ms ${REVEAL_EASE_CSS}, transform ${SECTION_DURATION_MS}ms ${REVEAL_EASE_CSS}`,
    opacity: visible ? 1 : 0,
    transform: visible ? "none" : SECTION_HIDDEN_TRANSFORM[direction],
    willChange: "opacity, transform",
  };

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}

/* ─── Animated heading — word-by-word reveal ────────────────────────── */

type HeadingTag = "h1" | "h2" | "h3" | "h4";

export function AnimatedHeading({
  children,
  as = "h2",
  className,
  style,
  amount = 0.4,
}: {
  children: ReactNode;
  as?: HeadingTag;
  className?: string;
  style?: CSSProperties;
  amount?: number;
}) {
  // Observer attaches to a transparent wrapper div so we can keep the
  // semantic <h1>/<h2>/<h3>/<h4> at the outer level without fighting React's
  // polymorphic ref typing.
  const observerRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(observerRef, amount, false);
  const visible = reduced || inView;
  const Tag = as;

  if (reduced) {
    return (
      <div ref={observerRef} style={{ display: "contents" }}>
        <Tag className={className} style={style}>
          {children}
        </Tag>
      </div>
    );
  }

  let wordIndex = 0;
  const parts: ReactNode[] = [];
  Children.forEach(children, (child, ci) => {
    if (typeof child === "string") {
      const tokens = child.split(/(\s+)/);
      tokens.forEach((tok, ti) => {
        if (/^\s+$/.test(tok)) {
          parts.push(<span key={`s-${ci}-${ti}`}>{tok}</span>);
          return;
        }
        if (tok.length === 0) return;
        const i = wordIndex++;
        const delay = i * HEADING_WORD_STAGGER_MS;
        parts.push(
          <span
            key={`w-${ci}-${ti}`}
            className="inline-block"
            style={{
              transition: `opacity ${HEADING_WORD_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delay}ms, transform ${HEADING_WORD_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delay}ms`,
              opacity: visible ? 1 : 0,
              transform: visible ? "translateY(0)" : "translateY(16px)",
              willChange: "opacity, transform",
            }}
          >
            {tok}
          </span>,
        );
      });
    } else if (isValidElement(child)) {
      const i = wordIndex++;
      const delay = i * HEADING_WORD_STAGGER_MS;
      parts.push(
        <span
          key={`c-${ci}`}
          className="inline-block"
          style={{
            transition: `opacity ${HEADING_WORD_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delay}ms, transform ${HEADING_WORD_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delay}ms`,
            opacity: visible ? 1 : 0,
            transform: visible ? "translateY(0)" : "translateY(16px)",
            willChange: "opacity, transform",
          }}
        >
          {child}
        </span>,
      );
    } else {
      parts.push(child);
    }
  });

  return (
    <div ref={observerRef} style={{ display: "contents" }}>
      <Tag className={className} style={style}>
        {parts}
      </Tag>
    </div>
  );
}

/* ─── RevealText — paragraph / eyebrow fade+slide ───────────────────── */

type TextTag = "p" | "span" | "div";

export function RevealText({
  children,
  as = "p",
  className,
  style,
  delay = 0.1,
  amount = 0.4,
}: {
  children: ReactNode;
  as?: TextTag;
  className?: string;
  style?: CSSProperties;
  delay?: number;
  amount?: number;
}) {
  const observerRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(observerRef, amount, false);
  const visible = reduced || inView;
  const delayMs = Math.max(0, Math.round(delay * 1000));
  const Tag = as;

  const combined: CSSProperties = {
    ...style,
    transition: reduced
      ? "none"
      : `opacity ${PARAGRAPH_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delayMs}ms, transform ${PARAGRAPH_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delayMs}ms`,
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(14px)",
    willChange: "opacity, transform",
  };

  return (
    <div ref={observerRef} style={{ display: "contents" }}>
      <Tag className={className} style={combined}>
        {children}
      </Tag>
    </div>
  );
}

/* ─── StaggerGroup + RevealCard / RevealItem ────────────────────────── */

type StaggerCtx = { active: boolean; reduced: boolean };
const StaggerContext = createContext<StaggerCtx | null>(null);

type GroupTag = "div" | "ul" | "ol" | "section";

export function StaggerGroup({
  children,
  className,
  amount = 0.18,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  amount?: number;
  as?: GroupTag;
}) {
  const observerRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(observerRef, amount, false);
  const active = reduced || inView;
  const Tag = as;

  const cloned = Children.map(children, (child, idx) => {
    if (isValidElement(child)) {
      return cloneElement(child as ReactElement<{ __staggerIndex?: number }>, {
        __staggerIndex: idx,
      });
    }
    return child;
  });

  return (
    <div ref={observerRef} style={{ display: "contents" }}>
      <Tag className={className}>
        <StaggerContext.Provider value={{ active, reduced }}>
          {cloned}
        </StaggerContext.Provider>
      </Tag>
    </div>
  );
}

type ItemTag = "div" | "li" | "article";

export function RevealItem({
  children,
  className,
  style,
  as = "div",
  __staggerIndex,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: ItemTag;
  __staggerIndex?: number;
}) {
  const ctx = useContext(StaggerContext);
  const localRef = useRef<HTMLDivElement | null>(null);
  const localInView = useInView(localRef, 0.18, false);
  const localReducedFallback = usePrefersReducedMotion();
  const reduced = ctx ? ctx.reduced : localReducedFallback;

  const inStagger = ctx !== null && typeof __staggerIndex === "number";
  const visible = reduced || (inStagger ? (ctx as StaggerCtx).active : localInView);
  const delayMs = inStagger
    ? STAGGER_INITIAL_DELAY_MS + (__staggerIndex as number) * STAGGER_CHILD_MS
    : 0;

  const combined: CSSProperties = {
    ...style,
    transition: reduced
      ? "none"
      : `opacity ${REVEAL_ITEM_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delayMs}ms, transform ${REVEAL_ITEM_DURATION_MS}ms ${REVEAL_EASE_CSS} ${delayMs}ms`,
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(24px)",
    willChange: "opacity, transform",
  };

  const Tag = as;

  return (
    <div ref={localRef} style={{ display: "contents" }}>
      <Tag className={className} style={combined}>
        {children}
      </Tag>
    </div>
  );
}

// RevealCard is an alias for RevealItem to match the spec naming.
export const RevealCard = RevealItem;
