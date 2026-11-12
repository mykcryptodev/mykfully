"use client";

import { useEffect, useRef, useState } from "react";
import {
  MEDIA_CONTENT_TYPES,
  mediaCombinationError,
  mediaSizeLimit,
  type MediaAttachment,
  type MediaContentType,
} from "@/lib/media-types";
import { api } from "../lib/api";

export function usePostMediaUpload(
  media: MediaAttachment[],
  onUpload: (item: MediaAttachment) => void,
  onUploadState: (uploading: boolean) => void,
) {
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const upload = async (files: File[]) => {
    if (!files.length || controller.current) return;
    setError(null);
    const candidates: { contentType: MediaContentType }[] = [];
    for (const file of files) {
      const contentType = MEDIA_CONTENT_TYPES.find((type) => type === file.type);
      if (!contentType) {
        setError(`${file.name}: choose a JPG, PNG, WebP, GIF, or MP4 file.`);
        return;
      }
      const limit = mediaSizeLimit(contentType);
      if (!file.size || file.size > limit) {
        setError(`${file.name}: file size must be between 1 byte and ${limit / 1024 ** 2} MB.`);
        return;
      }
      candidates.push({ contentType });
    }
    const combinationError = mediaCombinationError([...media, ...candidates]);
    if (combinationError) {
      setError(combinationError);
      return;
    }

    const request = new AbortController();
    controller.current = request;
    onUploadState(true);
    setProgress(0);
    let completed = 0;
    try {
      for (const file of files) {
        const item = await api.uploadMedia(file, (percent) => {
          setProgress(Math.floor((completed * 100 + percent) / files.length));
        }, request.signal);
        if (request.signal.aborted) break;
        onUpload(item);
        completed++;
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn’t upload media");
    } finally {
      controller.current = null;
      onUploadState(false);
      if (!request.signal.aborted) setProgress(null);
    }
  };

  return { error, progress, upload };
}
