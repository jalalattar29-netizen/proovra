/**
 * CAPTURE FOR THE COMPOSITION REVIEW.
 *
 * §6 is the one part of this phase no instrument can do: whether a page's
 * composition answers the operator's question, in the order they ask it. That
 * needs looking at the page. This produces the images to look at — full-page
 * at 1440, and the same route at 390 where the review needs both.
 *
 * Usage:
 *   node scripts/admin-ledger/visual/shots.mjs <out-dir> [--mobile] <route…>
 */
import { mkdirSync } from "node:fs";
import { open, signIn, strip, WEB } from "./lib.mjs";

const args = process.argv.slice(2);
const mobile = args.includes("--mobile");
const rest = args.filter((a) => !a.startsWith("--"));
const outDir = rest[0];
const routes = rest.slice(1);

if (!outDir || routes.length === 0) {
  console.error("usage: shots.mjs <out-dir> [--mobile] <route…>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const PARAMS = {
  "/admin/customers/:id": "0adf0000-0000-4000-8000-0000000000a1",
  "/admin/workspaces/:id": "0adf0000-0000-4000-8000-0000000000b1",
  "/admin/users/:id": "0adf0000-0000-4000-8000-000000000002",
  "/admin/demo-requests/:id": "0adf0000-0000-4000-8000-0000000000e1",
  "/admin/contact-sales/:id": "0adf0000-0000-4000-8000-0000000000e2",
  "/admin/platform/runbooks/:slug": "tsa-timestamp-failure",
};
const concrete = (r) => (PARAMS[r] ? r.replace(/:(\w+)$/, PARAMS[r]) : r);
const slug = (r) => r.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "_");

const { browser, page } = await open({
  width: mobile ? 390 : 1440,
  height: mobile ? 844 : 1000,
});
await signIn(page);

for (const route of routes) {
  await page
    .goto(`${WEB}${concrete(route)}`, { waitUntil: "networkidle", timeout: 90_000 })
    .catch(() => undefined);
  await strip(page);
  await page.waitForTimeout(1400);
  const file = `${outDir}/${slug(route)}${mobile ? "__390" : "__1440"}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`${route.padEnd(38)} h=${String(h).padStart(5)}  ${file}`);
}

await browser.close();
