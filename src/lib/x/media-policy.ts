import type { MediaAttachment } from "../media-types";

export const X_MEDIA_CHUNK_BYTES = 4_000_000;
export const X_MEDIA_STATUS_CHECKS = 6;

/** Upper bound for the upload and metadata requests needed in one publishing attempt. */
export function estimateMediaCost(
  attachments: readonly MediaAttachment[] | undefined,
  costs: { mediaUpload: number; mediaMetadata: number },
): number {
  let total = 0;
  for (const attachment of attachments ?? []) {
    const chunked = attachment.contentType === "image/gif" || attachment.contentType === "video/mp4";
    const requests = chunked ? 2 + Math.ceil(attachment.size / X_MEDIA_CHUNK_BYTES) + X_MEDIA_STATUS_CHECKS : 1;
    total += requests * costs.mediaUpload;
    if (attachment.altText?.trim()) total += costs.mediaMetadata;
  }
  return total;
}
