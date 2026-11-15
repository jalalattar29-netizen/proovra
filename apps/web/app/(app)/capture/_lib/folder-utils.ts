export type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (success: (file: File) => void, error?: (error: unknown) => void) => void;
};

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (error: unknown) => void
    ) => void;
  };
};

async function readAllDirectoryEntries(
  directoryEntry: FileSystemDirectoryEntryLike
): Promise<FileSystemEntryLike[]> {
  const reader = directoryEntry.createReader();
  const entries: FileSystemEntryLike[] = [];

  let keepReading = true;

  while (keepReading) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

    if (!batch.length) {
      keepReading = false;
    } else {
      entries.push(...batch);
    }
  }

  return entries;
}

async function fileFromEntry(
  fileEntry: FileSystemFileEntryLike,
  relativePath: string
): Promise<File> {
  const file = await new Promise<File>((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });

  Object.defineProperty(file, "webkitRelativePath", {
    value: relativePath,
    configurable: true,
  });

  return file;
}

async function collectFilesFromEntry(
  entry: FileSystemEntryLike,
  parentPath = ""
): Promise<File[]> {
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    return [await fileFromEntry(entry as FileSystemFileEntryLike, currentPath)];
  }

  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(
      entry as FileSystemDirectoryEntryLike
    );

    const nestedFiles = await Promise.all(
      children.map((child) => collectFilesFromEntry(child, currentPath))
    );

    return nestedFiles.flat();
  }

  return [];
}

/**
 * C-16 (Free-user audit of 4d9b78963) — every dropped item is taken while the
 * drop event is still being dispatched. The browser protects the drag data
 * once the handler yields: after the first `await` (reading the first
 * folder), `webkitGetAsEntry()` and `getAsFile()` on the remaining items
 * return null, so a drop of several files or folders staged only the first.
 * The entries (and plain files) are now collected synchronously, then read.
 */
export async function filesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);

  if (!items.length) {
    return Array.from(dataTransfer.files ?? []);
  }

  const fallbackFiles = Array.from(dataTransfer.files ?? []);
  const taken: Array<FileSystemEntryLike | File> = [];
  for (const item of items) {
    const maybeEntry =
      "webkitGetAsEntry" in item
        ? (
            item as DataTransferItem & {
              webkitGetAsEntry?: () => FileSystemEntryLike | null;
            }
          ).webkitGetAsEntry?.()
        : null;
    const file = maybeEntry ? null : item.getAsFile();
    if (maybeEntry) taken.push(maybeEntry);
    else if (file) taken.push(file);
  }

  const entryFiles: File[] = [];
  for (const entry of taken) {
    if (entry instanceof File) entryFiles.push(entry);
    else entryFiles.push(...(await collectFilesFromEntry(entry)));
  }

  return entryFiles.length ? entryFiles : fallbackFiles;
}

/**
 * F-P1-10 (Free-user audit of 4d9b78963) — whether this browser can pick a
 * whole folder. "Folder — keeps folder structure" was offered everywhere; the
 * directory picker (`webkitdirectory`) is a desktop capability: phones and
 * tablets either lack the property or open the ordinary file picker under it.
 * Where it is not supported, the existing multi-file picker is the way in.
 */
export function folderPickerSupported(env: {
  /** A fresh <input> (capability probe). */
  input: object | null | undefined;
  userAgent?: string | null;
  /** navigator.userAgentData?.mobile, where the browser exposes it. */
  uaMobile?: boolean | null;
  maxTouchPoints?: number | null;
}): boolean {
  if (!env.input || !("webkitdirectory" in env.input)) return false;
  if (env.uaMobile === true) return false;
  const ua = env.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  // iPadOS reports a desktop Mac user agent; a touch Mac is an iPad.
  if (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) > 1) return false;
  return true;
}

/** The probe, in a browser. */
export function browserSupportsFolderPicker(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return folderPickerSupported({
    input: document.createElement("input"),
    userAgent: nav.userAgent,
    uaMobile: nav.userAgentData?.mobile ?? null,
    maxTouchPoints: nav.maxTouchPoints,
  });
}
