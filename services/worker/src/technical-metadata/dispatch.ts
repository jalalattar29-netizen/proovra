/**
 * Technical-metadata dispatcher. Routes a part's bytes to the correct
 * parser by MIME type. Never throws.
 */

import {
  classifyMediaKind,
  unparsedMetadata,
  type TechnicalMetadata,
} from "@proovra/shared-runtime/technical-metadata";
import { parseImageMetadata } from "./image-parser.js";
import { parseVideoMetadata } from "./video-parser.js";
import { parsePdfMetadata } from "./pdf-parser.js";

export async function dispatchTechnicalMetadata(
  bytes: Buffer,
  mimeType: string | null,
): Promise<TechnicalMetadata> {
  const kind = classifyMediaKind(mimeType);
  try {
    switch (kind) {
      case "IMAGE":
        return await parseImageMetadata(bytes, mimeType);
      case "VIDEO":
      case "AUDIO":
        return await parseVideoMetadata(bytes, mimeType);
      case "PDF":
        return await parsePdfMetadata(bytes, mimeType);
      default:
        return unparsedMetadata(mimeType, "UNSUPPORTED");
    }
  } catch {
    return unparsedMetadata(mimeType, "FAILED");
  }
}
