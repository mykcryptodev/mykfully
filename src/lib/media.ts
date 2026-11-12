import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { execRows } from "./credits";
import type { DB } from "./db";
import { drafts, mediaAssets, mediaChunks, mediaUsage } from "./db/schema";
import { HttpError } from "./errors";
import {
  MEDIA_CHUNK_SIZE,
  MEDIA_CONTENT_TYPES,
  mediaSizeLimit,
  type MediaAttachment,
  type MediaContentType,
} from "./media-types";

const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_MEDIA_ASSETS = 256;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENCODED_CHUNK = Math.ceil(MEDIA_CHUNK_SIZE / 3) * 4;

const startSchema = z.object({
  name: z.string().trim().min(1).max(255).refine((name) => !name.includes("\0")),
  contentType: z.enum(MEDIA_CONTENT_TYPES),
  size: z.number().int().positive(),
});
const chunkSchema = z.object({
  offset: z.number().int().nonnegative().multipleOf(MEDIA_CHUNK_SIZE),
  data: z.string().min(1).max(MAX_ENCODED_CHUNK),
});
const metadata = {
  id: mediaAssets.id,
  name: mediaAssets.name,
  contentType: mediaAssets.contentType,
  size: mediaAssets.size,
};

/** Bound JSON reads even when a self-hosted deployment accepts larger request bodies. */
export async function readMediaJson(req: Request, chunk = false): Promise<unknown> {
  const maxBytes = chunk ? MAX_ENCODED_CHUNK + 4096 : 4096;
  if (Number(req.headers.get("content-length")) > maxBytes) {
    throw new HttpError(413, "Upload request is too large");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError("Missing JSON body");
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Upload request is too large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts, bytes).toString("utf8"));
}

/** Release quota and delete stale uploads in the same statement. Draft references keep media alive. */
async function pruneUnusedMedia(db: DB, userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS).toISOString();
  await db.execute(sql`
    WITH removed AS (
      DELETE FROM ${mediaAssets} AS a
      WHERE a.user_id = ${userId}
        AND a.touched_at < ${cutoff}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM ${drafts} AS d
          WHERE d.user_id = a.user_id
            AND d.posts @> jsonb_build_array(jsonb_build_object('media', jsonb_build_array(jsonb_build_object('id', a.id))))
        )
      RETURNING size
    ), released AS (
      SELECT coalesce(sum(size), 0)::int AS bytes, count(*)::int AS assets FROM removed
    )
    UPDATE ${mediaUsage} AS u
    SET total_bytes = u.total_bytes - r.bytes, asset_count = u.asset_count - r.assets
    FROM released AS r WHERE u.user_id = ${userId} AND r.assets > 0
  `);
}

export async function startMediaUpload(db: DB, userId: string, input: unknown): Promise<MediaAttachment> {
  const { name, contentType, size } = startSchema.parse(input);
  const limit = mediaSizeLimit(contentType);
  if (size > limit) throw new HttpError(413, `This file type is limited to ${limit / (1024 * 1024)} MB`);
  await pruneUnusedMedia(db, userId);
  const id = randomUUID();
  // The quota row serializes reservations across instances. Failed inserts roll back the reservation.
  const result = await db.execute(sql`
    WITH reserved AS (
      INSERT INTO ${mediaUsage} AS u (user_id, total_bytes, asset_count)
      VALUES (${userId}, ${size}, 1)
      ON CONFLICT (user_id) DO UPDATE
      SET total_bytes = u.total_bytes + excluded.total_bytes, asset_count = u.asset_count + 1
      WHERE u.total_bytes + excluded.total_bytes <= ${MAX_MEDIA_BYTES} AND u.asset_count < ${MAX_MEDIA_ASSETS}
      RETURNING user_id
    )
    INSERT INTO ${mediaAssets} (id, user_id, name, content_type, size)
    SELECT ${id}, user_id, ${name}, ${contentType}, ${size} FROM reserved
    RETURNING id
  `);
  if (!execRows<{ id: string }>(result).length) {
    throw new HttpError(413, "Your media storage is full. Remove unused media or old drafts to free up space.", {
      code: "media_storage_full",
    });
  }
  return { id, name, contentType, size };
}

function matchesContentType(bytes: Buffer, contentType: MediaContentType): boolean {
  const head = bytes.subarray(0, 12);
  switch (contentType) {
    case "image/jpeg":
      return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case "image/png":
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(head.toString("latin1", 0, 6));
    case "video/mp4":
      return head.length === 12 && head.toString("latin1", 4, 8) === "ftyp"
        && !["avif", "avis", "heic", "heix", "mif1", "msf1", "qt  "].includes(head.toString("latin1", 8, 12));
  }
}

const complete = eq(mediaAssets.uploadedSize, mediaAssets.size);
const owns = (userId: string, id: string) => and(eq(mediaAssets.id, id), eq(mediaAssets.userId, userId));

export async function appendMediaChunk(db: DB, userId: string, id: string, input: unknown): Promise<number> {
  const { offset, data } = chunkSchema.parse(input);
  const [asset] = await db
    .select({ size: mediaAssets.size, contentType: mediaAssets.contentType })
    .from(mediaAssets).where(owns(userId, id)).limit(1);
  if (!asset) throw new HttpError(404, "Media not found");

  const bytes = Buffer.from(data, "base64");
  if (offset >= asset.size || bytes.length !== Math.min(MEDIA_CHUNK_SIZE, asset.size - offset)
    || bytes.toString("base64") !== data) {
    throw new HttpError(400, "Invalid upload chunk");
  }
  if (offset === 0 && !matchesContentType(bytes, asset.contentType)) {
    throw new HttpError(415, "This file does not match its media type");
  }

  try {
    const nextOffset = offset + bytes.length;
    const result = await db.execute(sql`
      WITH advanced AS (
        UPDATE ${mediaAssets}
        SET uploaded_size = ${nextOffset}, touched_at = now()
        WHERE id = ${id} AND user_id = ${userId} AND uploaded_size = ${offset}
        RETURNING id
      )
      INSERT INTO ${mediaChunks} (media_id, byte_offset, bytes)
      SELECT id, ${offset}, decode(${data}, 'base64') FROM advanced
      RETURNING media_id
    `);
    if (execRows<{ media_id: string }>(result).length) return nextOffset;

    // Recover when the client retries a chunk whose response was lost.
    const [retry] = await db
      .select({ uploadedSize: mediaAssets.uploadedSize })
      .from(mediaAssets)
      .innerJoin(mediaChunks, eq(mediaAssets.id, mediaChunks.mediaId))
      .where(and(owns(userId, id), eq(mediaChunks.byteOffset, offset), sql`${mediaChunks.bytes} = decode(${data}, 'base64')`))
      .limit(1);
    if (retry) return retry.uploadedSize;
  } catch (e) {
    // Driver exceptions can include the SQL parameters, including the uploaded content.
    console.error("[mykfully] media chunk write failed", e instanceof Error ? e.name : "Unknown error");
    throw new Error("Media chunk write failed");
  }
  throw new HttpError(409, "Upload chunk is out of order");
}

export async function listOwnedMedia(db: DB, userId: string, ids: string[]): Promise<MediaAttachment[]> {
  if (!ids.length) return [];
  // Touch the rows while validating a new draft reference so a concurrent orphan sweep cannot remove them.
  return db.update(mediaAssets).set({ touchedAt: sql`now()` })
    .where(and(eq(mediaAssets.userId, userId), inArray(mediaAssets.id, ids), complete))
    .returning(metadata);
}

async function getMedia(db: DB, userId: string, id: string): Promise<MediaAttachment> {
  const [attachment] = await db.select(metadata).from(mediaAssets).where(and(owns(userId, id), complete)).limit(1);
  if (!attachment) throw new HttpError(404, "Media not found");
  return attachment;
}

function readChunks(db: DB, userId: string, id: string, start: number, end: number) {
  // Base64 keeps even the largest complete asset below Neon's 64 MB HTTP result limit.
  return db.select({
    offset: mediaChunks.byteOffset,
    encoded: sql<string>`encode(${mediaChunks.bytes}, 'base64')`,
  }).from(mediaChunks)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaChunks.mediaId))
    .where(and(owns(userId, id), complete, sql`${mediaChunks.byteOffset} BETWEEN ${start} AND ${end}`))
    .orderBy(mediaChunks.byteOffset);
}

export async function loadMedia(db: DB, userId: string, id: string): Promise<{
  attachment: MediaAttachment;
  bytes: Uint8Array<ArrayBuffer>;
}> {
  const attachment = await getMedia(db, userId, id);
  const chunks = await readChunks(db, userId, id, 0, attachment.size - 1);
  const bytes = new Uint8Array(attachment.size);
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== offset) throw new Error("Missing media chunk");
    const data = Buffer.from(chunk.encoded, "base64");
    bytes.set(data, offset);
    offset += data.length;
  }
  if (offset !== attachment.size) throw new Error("Incomplete media content");
  return { attachment, bytes };
}

/** Parse one HTTP byte range. Video players use these for metadata probes and seeking. */
function parseRange(range: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match) return;
  const [, first, last] = match;
  if (!first && !last) return;
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1;
  if (start >= size || start > end) return;
  return { start, end };
}

export async function mediaResponse(db: DB, userId: string, id: string, range: string | null): Promise<Response> {
  const { size, contentType } = await getMedia(db, userId, id);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  const selected = range ? parseRange(range, size) : { start: 0, end: size - 1 };
  if (!selected) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = selected;
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  // Stream bounded chunks so downloads stay within the Vercel response limit.
  let offset = Math.floor(start / MEDIA_CHUNK_SIZE) * MEDIA_CHUNK_SIZE;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const [chunk] = await readChunks(db, userId, id, offset, offset);
      if (!chunk) throw new Error("Missing media chunk");
      const bytes = Buffer.from(chunk.encoded, "base64");
      controller.enqueue(bytes.subarray(Math.max(0, start - offset), end - offset + 1));
      offset += MEDIA_CHUNK_SIZE;
      if (offset > end) controller.close();
    },
  });
  return new Response(stream, { status: range ? 206 : 200, headers });
}
