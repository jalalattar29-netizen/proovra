// pdfjs-dist ships no types for its worker module. The runtime only reads the
// handler it exports (and that it installs on globalThis.pdfjsWorker).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
