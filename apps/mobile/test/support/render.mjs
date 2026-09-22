/**
 * RENDER HARNESS for native component tests.
 *
 * Bundles a module with esbuild (so TSX, path aliases and the whole import
 * graph resolve exactly as Metro would), swaps the native-only packages for
 * stubs, and renders the result with `react-test-renderer`. What executes is
 * the component's real code.
 *
 * Node's test runner cannot load `react-native` or any `expo-*` package, which
 * is why the previous suite had no render coverage at all and every "test" was
 * an assertion about source text.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "../..");
/** Build output lives under node_modules so it is never committed or linted. */
const CACHE_DIR = resolve(MOBILE_ROOT, "node_modules/.render-test-cache");

/** Packages with no Node-loadable implementation, mapped to stubs. */
const ALIASES = {
  "react-native": resolve(HERE, "react-native-stub.mjs"),
  "react-native-safe-area-context": resolve(HERE, "react-native-stub.mjs"),
  "expo-router": resolve(HERE, "expo-stub.mjs"),
  "expo-audio": resolve(HERE, "expo-stub.mjs"),
  "expo-camera": resolve(HERE, "expo-stub.mjs"),
  "expo-file-system": resolve(HERE, "expo-stub.mjs"),
  "expo-crypto": resolve(HERE, "expo-stub.mjs"),
  "expo-location": resolve(HERE, "expo-stub.mjs"),
  "expo-document-picker": resolve(HERE, "expo-stub.mjs"),
  "expo-linking": resolve(HERE, "expo-stub.mjs"),
  "expo-apple-authentication": resolve(HERE, "expo-stub.mjs"),
  "expo-auth-session": resolve(HERE, "expo-stub.mjs"),
  "expo-auth-session/providers/google": resolve(HERE, "expo-stub.mjs"),
  "@react-native-async-storage/async-storage": resolve(HERE, "expo-stub.mjs"),
};

/**
 * Bundle `entry` (a path relative to apps/mobile) and import it.
 * `react` and `react-test-renderer` stay external so the component and the
 * renderer share one React instance — two copies break hooks.
 */
export async function loadModule(entry, extraExports = []) {
  // A synthetic entry re-exporting everything needed keeps the subject AND the
  // providers in ONE module graph. Bundling them separately gave each graph its
  // own copy of locale-context, so the provider and the consumer held different
  // React contexts and every screen threw "LocaleContext missing".
  const spec = (e) => JSON.stringify(resolve(MOBILE_ROOT, e).split("\\").join("/"));
  const stdinContents = [
    // `export *` deliberately does NOT re-export `default`, so a screen loaded
    // this way had an undefined default export and rendered as "Element type is
    // invalid". Every expo-router screen IS a default export.
    `export { default } from ${spec(entry)};`,
    ...[entry, ...extraExports].map((e) => `export * from ${spec(e)};`),
  ].join("\n");
  const result = await build({
    ...(extraExports.length
      ? {
          stdin: {
            contents: stdinContents,
            resolveDir: MOBILE_ROOT,
            sourcefile: "render-entry.ts",
            loader: "ts",
          },
        }
      : { entryPoints: [resolve(MOBILE_ROOT, entry)] }),
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "node20",
    jsx: "automatic",
    loader: { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".png": "dataurl" },
    alias: ALIASES,
    external: ["react", "react/jsx-runtime", "react-test-renderer"],
    logLevel: "silent",
  });
  // Write inside the package rather than importing a data: URL — a data: module
  // cannot resolve the bare specifier "react", and `react` must stay external
  // so the component and the renderer share one React instance.
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, createHash("sha1").update(entry + extraExports.join("|")).digest("hex") + ".mjs");
  await writeFile(file, result.outputFiles[0].text, "utf8");
  return import(`${pathToFileURL(file).href}?v=${Date.now()}`);
}

/** Render an element and return the tree plus query helpers. */
export async function renderComponent(element) {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });

  const api = {
    renderer,
    get root() {
      return renderer.root;
    },
    /**
     * One string per rendered Text node.
     *
     * The pieces of a node are JOINED, not returned separately: JSX splits a
     * sentence across expressions (`{n} recovery code{n === 1 ? "" : "s"} left`)
     * and the user reads one line, so a test that matched the fragments
     * separately would pass while the assembled sentence was wrong.
     */
    texts() {
      return renderer.root
        .findAll((n) => typeof n.type === "string" && n.type === "Text")
        .map((n) => flattenText(n.props.children).join(""))
        .filter(Boolean);
    },
    /** True when `needle` appears in any rendered string. */
    hasText(needle) {
      return api.texts().some((t) => t.includes(needle));
    },
    /** Elements carrying an accessibility label, by exact label. */
    byLabel(label) {
      return renderer.root.findAll(
        (n) => typeof n.type === "string" && n.props?.accessibilityLabel === label,
      );
    },
    byRole(role) {
      return renderer.root.findAll(
        (n) => typeof n.type === "string" && n.props?.accessibilityRole === role,
      );
    },
    /**
     * The RESOLVED style of a node. React Native accepts a style FUNCTION on
     * pressables, so reading `props.style` raw returns a function and any
     * assertion over it silently passes.
     */
    styleOf(node, state = { pressed: false }) {
      const raw = typeof node.props.style === "function" ? node.props.style(state) : node.props.style;
      return [raw]
        .flat(4)
        .filter((s) => s && typeof s === "object")
        .reduce((acc, s) => ({ ...acc, ...s }), {});
    },
    byTestId(id) {
      return renderer.root.findAll((n) => typeof n.type === "string" && n.props?.testID === id);
    },
    /**
     * Fire a press on the first element with this accessibility label.
     *
     * A DISABLED target is a no-op, because React Native's `Pressable` does not
     * call `onPress` when `disabled` is set. Calling the handler regardless
     * would let a test "prove" a guard that the platform, not the code, was
     * providing — and would equally hide a missing guard.
     */
    async press(label) {
      const hits = api.byLabel(label);
      if (hits.length === 0) throw new Error(`no pressable labelled "${label}"`);
      const target = hits.find((n) => n.props.onPress) ?? hits[0];
      if (!target.props.onPress) throw new Error(`"${label}" has no onPress`);
      if (target.props.disabled || target.props.accessibilityState?.disabled) return;
      await act(async () => {
        await target.props.onPress();
      });
    },
    /** Type into the first TextInput carrying this accessibility label. */
    async type(label, value) {
      const hits = api.byLabel(label).filter((n) => n.props.onChangeText);
      if (hits.length === 0) throw new Error(`no text input labelled "${label}"`);
      await act(async () => {
        await hits[0].props.onChangeText(value);
      });
    },
    async update(next) {
      await act(async () => {
        renderer.update(next);
      });
    },
    unmount() {
      TestRenderer.act(() => renderer.unmount());
    },
  };
  return api;
}

function flattenText(children) {
  if (children == null || children === false) return [];
  if (typeof children === "string") return [children];
  if (typeof children === "number") return [String(children)];
  if (Array.isArray(children)) return children.flatMap(flattenText);
  if (children.props) return flattenText(children.props.children);
  return [];
}

export { React, act };

/**
 * Wrap an element in the providers every screen assumes.
 *
 * Screens call `useLocale()` (and, deeper in, network/toast), whose hooks throw
 * "LocaleContext missing" rather than returning a default — deliberately, so a
 * provider cannot be forgotten in the app. That same strictness means a render
 * test has to mount them, which is closer to how the app actually boots.
 */
export async function loadWithProviders(entry) {
  return loadModule(entry, ["test/support/providers.tsx"]);
}

/**
 * Render an element inside the providers every screen assumes.
 *
 * `mod` must come from `loadWithProviders`, so the provider and the component
 * share one module graph — see the note on loadModule.
 */
export async function renderInProviders(mod, element) {
  return renderComponent(React.createElement(mod.TestProviders, null, element));
}
