import test from "node:test";
import assert from "node:assert/strict";

import { filesFromDataTransfer } from "../app/(app)/capture/_lib/folder-utils";

/**
 * C-16 (Free-user audit of 4d9b78963) — a drop of several files/folders staged
 * only the first. The browser protects the drag data once the drop handler
 * yields, so `webkitGetAsEntry()` / `getAsFile()` on items read after the first
 * `await` return null. Here the fake DataTransfer protects itself at the first
 * microtask, as a browser does after dispatch.
 */
function fileEntry(name: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => setTimeout(() => ok(new File([name], name)), 0),
  };
}
function dirEntry(name: string, children: ReturnType<typeof fileEntry>[]) {
  let served = false;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok: (e: unknown[]) => void) =>
        setTimeout(() => {
          ok(served ? [] : children);
          served = true;
        }, 0),
    }),
  };
}

function protectedDataTransfer(entries: Array<{ entry?: unknown; file?: File }>): DataTransfer {
  let isProtected = false;
  queueMicrotask(() => (isProtected = true));
  const items = entries.map((e) => ({
    kind: "file",
    webkitGetAsEntry: () => (isProtected ? null : (e.entry ?? null)),
    getAsFile: () => (isProtected ? null : (e.file ?? null)),
  }));
  return { items, files: [] } as unknown as DataTransfer;
}

test("C-16: every dropped folder and file is staged, not only the first", async () => {
  const dt = protectedDataTransfer([
    { entry: dirEntry("first", [fileEntry("a.jpg")]) },
    { entry: dirEntry("second", [fileEntry("b.jpg"), fileEntry("c.jpg")]) },
    { file: new File(["d"], "d.pdf") },
  ]);
  const files = await filesFromDataTransfer(dt);
  assert.deepEqual(
    files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).sort(),
    ["d.pdf", "first/a.jpg", "second/b.jpg", "second/c.jpg"],
  );
});
