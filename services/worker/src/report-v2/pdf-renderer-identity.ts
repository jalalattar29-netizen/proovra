/**
 * THE REPORT PDF NAMES ITS RENDERER, NOT THE BROWSER THAT PRINTED IT.
 *
 * Chromium writes its own identity into the PDF document information
 * dictionary, and which identity depends on the runtime:
 *
 *   full Chrome (new headless)   /Creator = the browser's user agent
 *                                (OS, CPU and "HeadlessChrome/<version>")
 *   chrome-headless-shell        /Creator = "Chromium"
 *   both                         /Producer = "Skia/PDF m<milestone>"
 *
 * A `--user-agent` flag only covered the first case. So the identity is set
 * here, on the printed bytes, whatever browser printed them: /Creator and
 * /Producer are both the product's own renderer name, and every other entry
 * (title, dates) is kept as Chromium wrote it.
 *
 * The file is rewritten as ONE revision (no incremental update), so the old
 * values leave no trace in the bytes and the signer that runs next sees the
 * same structure Chromium produced. Only the structure Chromium/Skia emits is
 * accepted — a classic cross-reference table in one subsection starting at
 * object 0, one revision, an indirect /Info. Anything else is refused rather
 * than shipped with the browser's identity in it.
 */

export class PdfRendererIdentityError extends Error {
  constructor(detail: string) {
    super(`REPORT_PDF_RENDERER_IDENTITY: ${detail}`);
    this.name = "PdfRendererIdentityError";
  }
}

const KEYS = ["Creator", "Producer"] as const;

function isDelimiter(ch: string | undefined): boolean {
  return ch === undefined || /[\s()<>[\]{}/%]/.test(ch);
}

/** The end (exclusive) of the PDF string value starting at `start`. */
function stringValueEnd(text: string, start: number): number {
  if (text[start] === "(") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return i + 1;
    }
    throw new PdfRendererIdentityError("unterminated literal string in /Info");
  }
  if (text[start] === "<" && text[start + 1] !== "<") {
    const end = text.indexOf(">", start);
    if (end < 0) throw new PdfRendererIdentityError("unterminated hex string in /Info");
    return end + 1;
  }
  // An indirect or non-string value would leave the old identity elsewhere in
  // the file; Chromium writes direct strings, so anything else is refused.
  throw new PdfRendererIdentityError(`/Info identity value is not a direct string (at ${start})`);
}

/** The dictionary with every `/Creator` and `/Producer` entry removed. */
function withoutIdentityEntries(dict: string): string {
  let out = dict;
  for (const key of KEYS) {
    for (;;) {
      const name = `/${key}`;
      let at = out.indexOf(name);
      while (at >= 0 && !isDelimiter(out[at + name.length])) at = out.indexOf(name, at + 1);
      if (at < 0) break;
      let valueStart = at + name.length;
      while (/\s/.test(out[valueStart] ?? "")) valueStart++;
      let valueEnd = stringValueEnd(out, valueStart);
      while (/\s/.test(out[valueEnd] ?? "")) valueEnd++;
      out = out.slice(0, at) + out.slice(valueEnd);
    }
  }
  return out;
}

function literal(value: string): string {
  if (!/^[\x20-\x7E]+$/.test(value) || /[()\\]/.test(value)) {
    throw new PdfRendererIdentityError("the renderer name must be printable ASCII without parentheses or backslashes");
  }
  return `(${value})`;
}

/**
 * The PDF with `/Creator` and `/Producer` set to `rendererName`, in one
 * revision, every cross-reference offset recomputed.
 */
export function setPdfRendererIdentity(pdf: Buffer, rendererName: string): Buffer {
  const nameLiteral = literal(rendererName);
  // latin1 maps every byte to one char and back: binary streams survive.
  const s = pdf.toString("latin1");

  const tail = s.slice(-1024);
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!sx) throw new PdfRendererIdentityError("no startxref at the end of the file");
  const xrefOffset = Number(sx[1]);

  const table = /^xref\r?\n0 (\d+)\r?\n/.exec(s.slice(xrefOffset, xrefOffset + 64));
  if (!table) throw new PdfRendererIdentityError("no classic cross-reference table at startxref");
  const count = Number(table[1]);
  const entriesStart = xrefOffset + table[0].length;
  const entryRe = /(\d{10}) (\d{5}) ([nf])[ \r]?\n/y;
  const entries: Array<{ offset: number; gen: string; kind: string }> = [];
  entryRe.lastIndex = entriesStart;
  for (let i = 0; i < count; i++) {
    const m = entryRe.exec(s);
    if (!m) throw new PdfRendererIdentityError(`malformed cross-reference entry ${i}`);
    entries.push({ offset: Number(m[1]), gen: m[2]!, kind: m[3]! });
  }
  const afterEntries = entryRe.lastIndex;
  const trailerAndRest = s.slice(afterEntries, s.lastIndexOf("startxref"));
  if (!/^trailer\b/.test(trailerAndRest)) throw new PdfRendererIdentityError("no trailer after the cross-reference table");
  if (/\/Prev\b/.test(trailerAndRest)) throw new PdfRendererIdentityError("more than one revision");
  const infoRef = /\/Info\s+(\d+)\s+0\s+R/.exec(trailerAndRest);
  if (!infoRef) throw new PdfRendererIdentityError("no indirect /Info in the trailer");

  const infoNum = Number(infoRef[1]);
  const info = entries[infoNum];
  if (!info || info.kind !== "n") throw new PdfRendererIdentityError("/Info is not an in-use object");
  const header = `${infoNum} 0 obj`;
  if (s.slice(info.offset, info.offset + header.length) !== header) {
    throw new PdfRendererIdentityError("/Info offset does not point at its object");
  }
  const objEnd = s.indexOf("endobj", info.offset);
  if (objEnd < 0 || objEnd > xrefOffset) throw new PdfRendererIdentityError("/Info object is not terminated");
  const body = s.slice(info.offset + header.length, objEnd);
  const open = body.indexOf("<<");
  const close = body.lastIndexOf(">>");
  if (open < 0 || close < open) throw new PdfRendererIdentityError("/Info is not a dictionary");

  const dict = withoutIdentityEntries(body.slice(open + 2, close)).trimEnd();
  const newBody = `${body.slice(0, open)}<<${dict}\n/Creator ${nameLiteral}\n/Producer ${nameLiteral}>>${body.slice(close + 2)}`;
  const delta = newBody.length - body.length;

  const objectsBefore = s.slice(0, info.offset + header.length);
  const objectsAfter = s.slice(objEnd, xrefOffset);
  const xref =
    table[0] +
    entries
      .map((e) => {
        const offset = e.kind === "n" && e.offset > info.offset ? e.offset + delta : e.offset;
        return `${String(offset).padStart(10, "0")} ${e.gen} ${e.kind} \n`;
      })
      .join("");
  const trailer = s.slice(afterEntries, s.lastIndexOf("startxref"));

  return Buffer.from(
    `${objectsBefore}${newBody}${objectsAfter}${xref}${trailer}startxref\n${xrefOffset + delta}\n%%EOF\n`,
    "latin1",
  );
}
