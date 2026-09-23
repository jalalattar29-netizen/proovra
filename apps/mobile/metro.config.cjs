/**
 * METRO — the one resolution the TYPE pin must not reach.
 *
 * ---------------------------------------------------------------------------
 * WHAT BROKE
 * ---------------------------------------------------------------------------
 * `tsconfig.json` maps `react` and `react/*` at `./node_modules/@types/react`.
 * That pin is correct and load-bearing: this repository holds two React majors
 * on purpose — React 18 here under Expo 52 / RN 0.76, React 19 in `apps/web` —
 * and without it packages that declare React types as an optional peer resolve
 * through pnpm's single shared fallback, so every `forwardRef` component
 * becomes "not a valid JSX element type". Removing the two entries
 * reintroduces TS2786 on `CameraView` immediately; it was measured, not
 * assumed.
 *
 * But Expo enables `tsconfigPaths` in Metro by default, so Metro read that
 * TYPE mapping as a RUNTIME one. Every `import React from "react"` resolved to
 * `@types/react`, whose `main` points at an `index` that contains no
 * JavaScript at all, and the bundle failed on the first file it touched:
 *
 *     While trying to resolve module `react` … the package
 *     `apps/mobile/node_modules/@types/react/package.json` was successfully
 *     found. However, this package itself specifies a `main` module field
 *     that could not be resolved.
 *
 * So the app could not be bundled, and therefore could not be BUILT. The EAS
 * Android build from this branch errored in the "Bundle JavaScript" phase
 * after two minutes, and the last build that succeeded predates the commit
 * that added the pin. Nothing in the JavaScript test suites could catch it:
 * they transpile modules directly and never run Metro.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SHAPE OF FIX
 * ---------------------------------------------------------------------------
 * `expo.experiments.tsconfigPaths: false` would also work, and would take the
 * `@proovra/ui` source alias down with it — a wider change than the problem.
 * A `resolveRequest` hook runs BEFORE the default resolver, so this overrides
 * exactly the two specifiers that must never be aliased and leaves every other
 * path mapping doing its job.
 *
 * The type pin stays. Metro just stops reading it as an instruction about
 * runtime code, which it never was.
 *
 * `.cjs`, not `.js`: this package is `"type": "module"`, and Metro loads its
 * config through require().
 */
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

/** The REAL React, the one with JavaScript in it. */
const reactRoot = path.resolve(projectRoot, "node_modules/react");

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    const subpath = moduleName === "react" ? "" : moduleName.slice("react".length);
    return context.resolveRequest(
      context,
      subpath ? path.join(reactRoot, subpath) : reactRoot,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
