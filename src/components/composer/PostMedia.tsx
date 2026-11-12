"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { MAX_MEDIA_ALT_TEXT_LENGTH, type MediaAttachment } from "@/lib/media-types";
import { mediaUrl } from "../lib/api";
import { IconDoc, IconX } from "../ui/icons";

export const ATTACHMENT_DRAG_TYPE = "application/x-mykfully-attachment";
export type AttachmentDrag = { postId: string; mediaId: string };

export function readAttachmentDrag(event: DragEvent): AttachmentDrag | null {
  try {
    const data = JSON.parse(event.dataTransfer.getData(ATTACHMENT_DRAG_TYPE)) as Partial<AttachmentDrag>;
    if (typeof data.postId === "string" && typeof data.mediaId === "string") {
      return { postId: data.postId, mediaId: data.mediaId };
    }
  } catch {}
  return null;
}

type EditProps = {
  postId: string;
  onChange: (update: (media: MediaAttachment[]) => MediaAttachment[]) => void;
  onDrop: (source: AttachmentDrag, beforeId?: string) => void;
};

const TILE_ACTION = "rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 focus-visible:outline-2 focus-visible:outline-accent";

export function PostMedia({ media, edit }: { media?: MediaAttachment[]; edit?: EditProps }) {
  const [descriptionsOpen, setDescriptionsOpen] = useState(false);
  const descriptionId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (!media?.length) return null;

  const move = (id: string, direction: -1 | 1) => {
    edit?.onChange((current) => {
      const index = current.findIndex((item) => item.id === id);
      const other = index + direction;
      if (index < 0 || !current[other]) return current;
      const next = [...current];
      [next[index], next[other]] = [next[other], next[index]];
      return next;
    });
  };

  // Alt text saves as you type; Done (or ⌘/Ctrl+Enter, Escape) just dismisses the panel.
  const closeDescriptions = () => {
    setDescriptionsOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="mt-2">
      <div className={`grid gap-0.5 overflow-hidden rounded-2xl border border-line bg-line ${
        media.length === 1 ? "grid-cols-1" : "aspect-video grid-cols-2 auto-rows-fr"
      }`}>
        {media.map((item, index) => (
          <div
            key={item.id}
            className={`group/tile relative min-h-0 min-w-0 bg-card ${
              media.length === 1 ? "max-h-[420px]" : media.length === 3 && index === 0 ? "row-span-2" : ""
            } ${edit && !item.contentType.startsWith("video/") ? "cursor-grab active:cursor-grabbing" : ""}`}
            draggable={!!edit}
            onDragStart={edit ? (event) => {
              event.dataTransfer.setData(ATTACHMENT_DRAG_TYPE, JSON.stringify({ postId: edit.postId, mediaId: item.id }));
              event.dataTransfer.effectAllowed = "move";
            } : undefined}
            onDrop={edit ? (event) => {
              const source = readAttachmentDrag(event);
              if (!source) return;
              event.preventDefault();
              event.stopPropagation();
              edit.onDrop(source, item.id);
            } : undefined}
          >
            {item.contentType.startsWith("video/") ? (
              <video controls playsInline preload="metadata" src={mediaUrl(item.id)}
                aria-label={item.altText || item.name} className="block max-h-[420px] w-full bg-black object-contain" />
            ) : (
              // Preview responses require the signed-in browser's session cookie.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mediaUrl(item.id)}
                alt={item.altText || (edit ? item.name : "")}
                draggable={false}
                className={media.length === 1
                  ? "block max-h-[420px] w-full object-contain"
                  : "absolute inset-0 h-full w-full object-cover"}
              />
            )}
            {item.contentType === "image/gif" && (
              <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">GIF</span>
            )}
            {edit && (
              <div className="absolute right-2 top-2 flex gap-1">
                {index > 0 && (
                  <button type="button" className={TILE_ACTION} onClick={() => move(item.id, -1)}
                    aria-label={`Move ${item.name} earlier`} title="Move earlier">
                    <span aria-hidden className="block w-3 text-center text-xs leading-3">←</span>
                  </button>
                )}
                {index < media.length - 1 && (
                  <button type="button" className={TILE_ACTION} onClick={() => move(item.id, 1)}
                    aria-label={`Move ${item.name} later`} title="Move later">
                    <span aria-hidden className="block w-3 text-center text-xs leading-3">→</span>
                  </button>
                )}
                <button type="button" className={TILE_ACTION}
                  aria-label={`Remove ${item.name}`} title="Remove attachment"
                  onClick={() => edit.onChange((current) => current.filter((entry) => entry.id !== item.id))}>
                  <IconX size={13} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {edit && media.some((item) => !item.contentType.startsWith("video/")) && (
        <div className="mt-1.5">
          <button ref={toggleRef} type="button" className="flex items-center gap-1 rounded text-[13px] text-muted hover:text-ink"
            aria-expanded={descriptionsOpen} aria-controls={descriptionId} onClick={() => setDescriptionsOpen(!descriptionsOpen)}>
            <IconDoc size={14} /> Descriptions
          </button>
          {descriptionsOpen && (
            <div id={descriptionId} className="mt-2 space-y-2 rounded-xl border border-line bg-card p-3"
              onKeyDown={(event) => {
                const done = event.key === "Escape"
                  || (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey);
                if (!done) return;
                event.preventDefault();
                event.stopPropagation();
                closeDescriptions();
              }}>
              {media.filter((item) => !item.contentType.startsWith("video/")).map((item) => (
                <label key={item.id} className="block text-xs text-muted">
                  <span className="block truncate">Alt text for {item.name}</span>
                  <textarea value={item.altText ?? ""} rows={2} maxLength={MAX_MEDIA_ALT_TEXT_LENGTH}
                    placeholder="Describe this media for someone who can’t see it"
                    className="mt-1 block w-full resize-y rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-accent"
                    onChange={(event) => {
                      const altText = event.currentTarget.value;
                      edit.onChange((current) => current.map((entry) => entry.id === item.id ? { ...entry, altText } : entry));
                    }} />
                </label>
              ))}
              <div className="flex justify-end pt-1">
                <button type="button" onClick={closeDescriptions}
                  aria-keyshortcuts="Meta+Enter Control+Enter Escape" title="Done (⌘/Ctrl Enter)"
                  className="inline-flex h-8 items-center justify-center rounded-full leading-none bg-accent px-4 text-[13px] font-bold text-white transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
