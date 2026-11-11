"use client";

import type { XUser } from "@/lib/x/types";

export type DraftStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";
export type ThreadPost = { id: string; text: string; tweetId?: string | null };

export type Draft = {
  id: string;
  userId: string;
  posts: ThreadPost[];
  status: DraftStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Me = {
  id: string;
  username: string;
  name: string;
  profileImageUrl: string | null;
  verifiedType: string | null;
  timezone: string;
};

export type { XUser };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON fetch; redirects to /login on 401 and throws ApiError on non-2xx. */
export async function apiFetch<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Not signed in");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data && typeof data.error === "string" && data.error) ||
      (data?.issues?.[0]?.message as string | undefined) ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  me: () => apiFetch<{ user: Me }>("/api/me"),
  setTimezone: (timezone: string) => apiFetch<{ user: Me }>("/api/me", { method: "PATCH", json: { timezone } }),
  logout: () => fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }),
  listDrafts: (status?: DraftStatus) =>
    apiFetch<{ drafts: Draft[] }>(status ? `/api/drafts?status=${status}` : "/api/drafts"),
  getDraft: (id: string) => apiFetch<{ draft: Draft }>(`/api/drafts/${id}`),
  createDraft: (posts: { id: string; text: string }[]) =>
    apiFetch<{ draft: Draft }>("/api/drafts", { method: "POST", json: { posts } }),
  updateDraft: (id: string, patch: { posts?: { id: string; text: string }[]; scheduledAt?: string | null }) =>
    apiFetch<{ draft: Draft }>(`/api/drafts/${id}`, { method: "PATCH", json: patch }),
  deleteDraft: (id: string) => apiFetch<{ ok: true }>(`/api/drafts/${id}`, { method: "DELETE" }),
  publish: (id: string) => apiFetch<{ draft: Draft }>(`/api/drafts/${id}/publish`, { method: "POST" }),
  searchMentions: (q: string, signal?: AbortSignal) =>
    apiFetch<{ users: XUser[]; source: string }>(`/api/mentions/search?q=${encodeURIComponent(q)}`, { signal }),
};

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
