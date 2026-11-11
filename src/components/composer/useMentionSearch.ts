"use client";

import { useEffect, useRef, useState } from "react";
import { api, type XUser } from "../lib/api";

type Entry = { users: XUser[]; creditsExhausted: boolean };
const cache = new Map<string, Entry>();
const MAX_CACHE = 200;

function localFilter(pool: XUser[], q: string): XUser[] {
  const lq = q.toLowerCase();
  return pool.filter((u) => u.username.toLowerCase().startsWith(lq) || u.name.toLowerCase().includes(lq));
}

/** Debounced (200ms), abortable mention search with an in-memory cache and instant local narrowing. */
export function useMentionSearch(query: string | null) {
  const [users, setUsers] = useState<XUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState<string | null>(null);
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastPool = useRef<XUser[]>([]);

  useEffect(() => {
    if (!query) {
      abortRef.current?.abort();
      setLoading(false);
      setResolvedQuery(null);
      return;
    }
    const key = query.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      lastPool.current = cached.users;
      setUsers(cached.users);
      setCreditsExhausted(cached.creditsExhausted);
      setResolvedQuery(query);
      setLoading(false);
      return;
    }
    // Show something immediately: narrow the previous results (or a cached shorter prefix).
    let pool = lastPool.current;
    for (let i = key.length - 1; i > 0; i--) {
      const prefix = cache.get(key.slice(0, i));
      if (prefix) {
        pool = prefix.users;
        break;
      }
    }
    setUsers(localFilter(pool, key));
    setLoading(true);

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await api.searchMentions(query, ctrl.signal);
        const users = res.users;
        const exhausted = !!res.creditsExhausted;
        if (cache.size > MAX_CACHE) cache.clear();
        // Don't cache degraded (out-of-credits) results: they should improve once credits are granted.
        if (!exhausted) cache.set(key, { users, creditsExhausted: false });
        if (ctrl.signal.aborted) return;
        lastPool.current = users;
        setUsers(users);
        setCreditsExhausted(exhausted);
        setResolvedQuery(query);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setResolvedQuery(query);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { users, loading, resolved: resolvedQuery === query, creditsExhausted };
}
