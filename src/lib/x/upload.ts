import { setTimeout as sleep } from "node:timers/promises";
import { HttpError } from "../errors";
import type { MediaContentType } from "../media-types";
import { X_MEDIA_CHUNK_BYTES, X_MEDIA_STATUS_CHECKS } from "./media-policy";
import type { XClient, XMediaResponse } from "./types";

function uploadId(response: XMediaResponse): string {
  if (typeof response.id === "string" && /^\d{1,19}$/.test(response.id)) return response.id;
  throw new HttpError(502, "X did not return a media ID.", { code: "media_upload_failed" });
}

async function waitForProcessing(client: XClient, id: string, response: XMediaResponse, signal: AbortSignal) {
  let processing = response.processing_info;
  for (let checks = 0; processing && processing.state !== "succeeded"; checks++) {
    if (processing.state !== "pending" && processing.state !== "in_progress") {
      throw new HttpError(422, "X could not process this media. Try a different file.", { code: "media_processing_failed" });
    }
    if (checks >= X_MEDIA_STATUS_CHECKS) {
      throw new HttpError(503, "X is still processing the media. Try again shortly.", { code: "media_processing_timeout" });
    }
    const seconds = processing.check_after_secs;
    const delay = typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(1, seconds) : 1;
    await sleep(delay * 1000, undefined, { signal });
    ({ processing_info: processing } = await client.requestMedia({ type: "status", id }, signal));
  }
}

/** Upload just before posting, so X's short-lived media IDs are fresh when attached. */
export async function uploadAttachment(
  client: XClient,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: MediaContentType,
  altText: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  let id: string;
  try {
    signal.throwIfAborted();
    const media = new Blob([bytes], { type: contentType });
    if (contentType === "image/gif" || contentType === "video/mp4") {
      id = uploadId(await client.requestMedia({ type: "initialize", size: media.size, contentType }, signal));
      for (let offset = 0, index = 0; offset < media.size; offset += X_MEDIA_CHUNK_BYTES, index++) {
        const segment = media.slice(offset, offset + X_MEDIA_CHUNK_BYTES, contentType);
        await client.requestMedia({ type: "append", id, index, media: segment }, signal);
      }
      const response = await client.requestMedia({ type: "finalize", id }, signal);
      await waitForProcessing(client, id, response, signal);
    } else {
      const response = await client.requestMedia({ type: "image", media }, signal);
      id = uploadId(response);
      await waitForProcessing(client, id, response, signal);
    }
    const text = altText?.trim();
    if (text) await client.requestMedia({ type: "altText", id, text }, signal);
  } catch (e) {
    if (!signal.aborted) throw e;
    throw new HttpError(503, "The X media upload took too long. Try again shortly.", { code: "media_upload_timeout" });
  }
  return id;
}
