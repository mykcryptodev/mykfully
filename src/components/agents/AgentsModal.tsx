"use client";

import { useEffect, useId, useState } from "react";
import { api, type ApiToken, type TokenScopes } from "../lib/api";
import { relativeShort } from "../lib/time";
import { useApp } from "../app/AppProvider";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { IconCheck, IconCopy, IconTrash, IconX } from "../ui/icons";

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      <div className="flex items-start gap-2 rounded-lg border border-line bg-hover p-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-[17px] text-ink">{value}</code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md p-1 text-muted hover:bg-canvas hover:text-ink"
          aria-label={`Copy ${label}`}
          title="Copy"
        >
          {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
        </button>
      </div>
    </div>
  );
}

const NO_SCOPES: TokenScopes = { schedule: false, publish: false, delete: false };

const PERMISSIONS: { key: keyof TokenScopes; label: string; hint: string; danger?: boolean }[] = [
  { key: "schedule", label: "Schedule", hint: "Schedule and unschedule threads, and edit scheduled ones." },
  { key: "publish", label: "Publish now", hint: "Post to X immediately. Public, can’t be undone, spends credits.", danger: true },
  { key: "delete", label: "Delete", hint: "Permanently delete threads from mykfully.", danger: true },
];

/** Checkboxes for a token's opt-in permissions. Drafting and previews are always allowed. */
function PermissionChecks({
  value, onChange, disabled, idPrefix,
}: { value: TokenScopes; onChange: (key: keyof TokenScopes, on: boolean) => void; disabled?: boolean; idPrefix: string }) {
  return (
    <fieldset className="mt-2 flex flex-col gap-1.5" disabled={disabled}>
      <legend className="sr-only">Permissions</legend>
      {PERMISSIONS.map((p) => (
        <label key={p.key} htmlFor={`${idPrefix}-${p.key}`} className="flex cursor-pointer items-start gap-2 text-[13px] leading-[17px]">
          <input
            id={`${idPrefix}-${p.key}`}
            type="checkbox"
            checked={value[p.key]}
            onChange={(e) => onChange(p.key, e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span>
            <span className={`font-semibold ${p.danger ? "text-danger" : "text-ink"}`}>{p.label}</span>
            <span className="text-muted"> · {p.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Create/revoke API tokens, set what each may do, and show how to connect an agent over MCP. */
export function AgentsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, toast } = useApp();
  const titleId = useId();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [scopes, setScopes] = useState<TokenScopes>(NO_SCOPES);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setError(null);
    api.listTokens().then((r) => setTokens(r.tokens), () => setTokens([]));
  }, [open]);

  const mcpUrl = typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp";
  const token = created ?? "<your token>";

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createToken(name.trim() || "Agent", scopes);
      setCreated(r.token);
      setTokens((t) => [r.apiToken, ...(t ?? [])]);
      setName("");
      setScopes(NO_SCOPES);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create token");
    } finally {
      setBusy(false);
    }
  };

  /** Saved immediately; the token's next request uses the new permissions. */
  const toggle = async (t: ApiToken, key: keyof TokenScopes, on: boolean) => {
    setSaving(t.id);
    setTokens((list) => (list ?? []).map((x) => (x.id === t.id ? { ...x, scopes: { ...x.scopes, [key]: on } } : x)));
    try {
      const r = await api.updateTokenScopes(t.id, { [key]: on });
      setTokens((list) => (list ?? []).map((x) => (x.id === t.id ? r.apiToken : x)));
    } catch (e) {
      setTokens((list) => (list ?? []).map((x) => (x.id === t.id ? t : x)));
      toast(e instanceof Error ? e.message : "Couldn't update permissions", "error");
    } finally {
      setSaving(null);
    }
  };

  const revoke = async (t: ApiToken) => {
    try {
      await api.revokeToken(t.id);
      setTokens((list) => (list ?? []).filter((x) => x.id !== t.id));
      toast(`Revoked “${t.name}”`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke", "error");
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="max-h-[90vh] max-w-[520px] overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={titleId} className="text-lg font-bold text-ink">Connect an agent</h2>
          <p className="mt-1 text-[13px] leading-[18px] text-muted">
            Agents can always draft threads, render X previews and check or buy credits over MCP. Scheduling, publishing
            and deleting are off unless you allow them for a token. You can change this any time, and it applies to the
            agent’s next request.
          </p>
        </div>
        <button onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label="Close">
          <IconX size={17} />
        </button>
      </div>

      {created ? (
        <div className="mt-4 rounded-xl border border-line-strong p-3">
          <p className="text-[13px] font-semibold text-ink">Copy your token now. It won’t be shown again.</p>
          <CopyBlock label="API token" value={created} />
        </div>
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="flex gap-2">
          <input
            data-autofocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Token name, e.g. Claude Code"
            aria-label="Token name"
            className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 text-[14px] text-ink outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex h-9 items-center gap-2 rounded-full bg-ink px-4 text-[14px] font-bold text-canvas hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Spinner size={14} />}
            Create token
          </button>
          </div>
          <PermissionChecks idPrefix="new" value={scopes} onChange={(k, on) => setScopes((s) => ({ ...s, [k]: on }))} />
        </form>
      )}
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}

      <div className="mt-5">
        <h3 className="text-[14px] font-bold text-ink">Set up</h3>
        <CopyBlock label="MCP server URL" value={mcpUrl} />
        <CopyBlock label="Claude Code" value={`claude mcp add --transport http mykfully ${mcpUrl} --header "Authorization: Bearer ${token}"`} />
        <CopyBlock
          label="Other MCP clients (JSON)"
          value={JSON.stringify({ mcpServers: { mykfully: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}
        />
      </div>

      <div className="mt-5">
        <h3 className="text-[14px] font-bold text-ink">Active tokens</h3>
        {tokens === null ? (
          <div className="py-4 text-center"><Spinner size={16} /></div>
        ) : tokens.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">No tokens yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold text-ink">{t.name}</div>
                  <div className="text-xs text-muted">
                    <code className="font-mono">{t.prefix}…</code> · created {relativeShort(t.createdAt, me?.timezone ?? "UTC")}
                    {t.lastUsedAt ? ` · used ${relativeShort(t.lastUsedAt, me?.timezone ?? "UTC")}` : " · never used"}
                  </div>
                  <PermissionChecks idPrefix={t.id} value={t.scopes} disabled={saving === t.id} onChange={(k, on) => void toggle(t, k, on)} />
                </div>
                <button
                  onClick={() => revoke(t)}
                  className="rounded-full p-1.5 text-muted hover:bg-danger/10 hover:text-danger"
                  aria-label={`Revoke ${t.name}`}
                  title="Revoke"
                >
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
