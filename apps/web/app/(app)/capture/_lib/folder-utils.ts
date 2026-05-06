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

export async function filesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);

  if (!items.length) {
    return Array.from(dataTransfer.files ?? []);
  }

  const entryFiles: File[] = [];

  for (const item of items) {
    const maybeEntry =
      "webkitGetAsEntry" in item
        ? (
            item as DataTransferItem & {
              webkitGetAsEntry?: () => FileSystemEntryLike | null;
            }
          ).webkitGetAsEntry?.()
        : null;

    if (maybeEntry) {
      entryFiles.push(...(await collectFilesFromEntry(maybeEntry)));
      continue;
    }

    const file = item.getAsFile();
    if (file) entryFiles.push(file);
  }

  return entryFiles.length ? entryFiles : Array.from(dataTransfer.files ?? []);
}