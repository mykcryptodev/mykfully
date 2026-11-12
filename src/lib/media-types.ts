export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4"] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

export type MediaAttachment = {
  id: string;
  name: string;
  contentType: MediaContentType;
  size: number;
  altText?: string;
};

const MiB = 1024 * 1024;
export const MEDIA_CHUNK_SIZE = 2 * MiB;
export const MAX_MEDIA_ATTACHMENTS = 4;
export const MAX_MEDIA_ALT_TEXT_LENGTH = 1000;

export function isStaticImage(contentType: MediaContentType): boolean {
  return contentType !== "image/gif" && contentType !== "video/mp4";
}

export function mediaSizeLimit(contentType: MediaContentType): number {
  if (contentType === "video/mp4") return 32 * MiB;
  if (contentType === "image/gif") return 15 * MiB;
  return 5 * MiB;
}

export function mediaCombinationError(media: readonly Pick<MediaAttachment, "contentType">[]): string | undefined {
  if (media.length > 1 && media.some(({ contentType }) => !isStaticImage(contentType))) {
    return "A post can contain up to four images, one GIF, or one video.";
  }
  if (media.length > MAX_MEDIA_ATTACHMENTS) return "A post can contain up to four images.";
}
