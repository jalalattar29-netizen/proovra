/**
 * WCAG AA CONTRAST, MEASURED IN THE RENDERED PAGE.
 *
 * The first version of this reported 31 failures on /admin/dashboard that were
 * all its own fault: it read `backgroundColor` and treated `rgba(36,55,59,0.06)`
 * as an opaque dark slate, so near-black text on a 6%-tinted white card came
 * out at 1.43:1. The product's surface hierarchy is deliberately translucent
 * (see --surface-translucent-* in the token file), so ANY instrument that does
 * not composite alpha will condemn most of the app.
 *
 * This one walks up the ancestor chain compositing every semi-transparent
 * layer onto the next until it reaches an opaque one, which is what the eye
 * actually receives.
 */
import { open, signIn, visit } from "./lib.mjs";

const srgb = (v) => {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const routes = process.argv.slice(2);
const { browser, page } = await open();
await signIn(page);

let grand = 0;
for (const r of routes) {
  await visit(page, r, 3000);
  const samples = await page.evaluate(() => {
    const parse = (c) => {
      const n = (c.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      if (n.length < 3) return null;
      return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
    };
    /** Composite this element's effective background, alpha included. */
    const effectiveBg = (el) => {
      const stack = [];
      let p = el;
      while (p) {
        const cs = getComputedStyle(p);
        /*
         * A GRADIENT IS A BACKGROUND TOO.
         * The first version of this read only `backgroundColor`, and the
         * canonical primary Button paints
         * `linear-gradient(135deg, rgb(124,58,237) ...)` with a TRANSPARENT
         * background-color. So white button text was measured against the page
         * ground and reported at 1.06:1 -- three of seven "failures" were this
         * instrument, not the product. The first colour stop is a sound
         * approximation of what sits behind the label.
         */
        const img = cs.backgroundImage;
        if (img && img !== "none") {
          // parse() reads the first four numbers, and in a gradient the
          // fourth is the stop POSITION ("0%") not an alpha -- so the alpha
          // guard used below for real colours must not be applied here.
          const first = parse(img.slice(img.indexOf("rgb")));
          if (first) {
            stack.push({ ...first, a: 1 });
            break;
          }
        }
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) {
          stack.push(c);
          if (c.a >= 0.999) break;
        }
        p = p.parentElement;
      }
      // Nothing opaque found: the page ground is white.
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const t = stack[i];
        base = {
          r: t.r * t.a + base.r * (1 - t.a),
          g: t.g * t.a + base.g * (1 - t.a),
          b: t.b * t.a + base.b * (1 - t.a),
          a: 1,
        };
      }
      return [base.r, base.g, base.b];
    };

    const out = [];
    const walk = (el) => {
      for (const n of el.children) {
        const cs = getComputedStyle(n);
        const hasText = [...n.childNodes].some(
          (c) => c.nodeType === 3 && c.textContent.trim().length > 1,
        );
        const visible =
          cs.visibility !== "hidden" &&
          cs.display !== "none" &&
          parseFloat(cs.opacity) > 0.05 &&
          n.getBoundingClientRect().width > 0;
        if (hasText && visible) {
          const fg = parse(cs.color);
          if (fg && fg.a > 0.05) {
            out.push({
              fg: [fg.r, fg.g, fg.b],
              bg: effectiveBg(n),
              size: parseFloat(cs.fontSize),
              weight: Number(cs.fontWeight) || 400,
              cls: (n.className || "").toString().slice(0, 30),
              txt: (n.textContent || "").trim().slice(0, 38),
            });
          }
        }
        walk(n);
      }
    };
    walk(document.querySelector("main") || document.body);
    return out;
  });

  const fails = [];
  for (const s of samples) {
    const cr = ratio(s.fg, s.bg);
    // AA: 4.5 for normal text; 3.0 for >=24px, or >=18.66px at >=700.
    const large = s.size >= 24 || (s.size >= 18.66 && s.weight >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need - 0.01) {
      fails.push({ cr: cr.toFixed(2), need, size: s.size, cls: s.cls, txt: s.txt,
        fg: s.fg.map(Math.round).join(","), bg: s.bg.map(Math.round).join(",") });
    }
  }
  grand += fails.length;
  console.log(`${r.padEnd(36)} samples=${String(samples.length).padStart(4)}  AA-fail=${fails.length}`);
  for (const f of fails.slice(0, 8)) {
    console.log(`    ${f.cr} (need ${f.need})  ${f.size}px  fg(${f.fg}) on bg(${f.bg})  .${f.cls}  "${f.txt}"`);
  }
}
console.log(`\nTOTAL AA failures across ${routes.length} routes: ${grand}`);
await browser.close();
