"use client";

import { useId, useState } from "react";
import { Modal } from "../ui/Modal";
import { IconSearch } from "../ui/icons";

export type ComposerCommand = {
  label: string;
  keywords?: string;
  shortcut?: string;
  run: () => void;
};

export function CommandBar({ commands, onClose }: { commands: ComposerCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputId = useId();
  const search = query.trim().toLowerCase();
  const results = commands.filter(({ label, keywords }) => `${label} ${keywords ?? ""}`.toLowerCase().includes(search));
  const selected = Math.min(active, results.length - 1);

  const run = (command: ComposerCommand) => {
    onClose();
    command.run();
  };

  return (
    <Modal open onClose={onClose} labelledBy={inputId} className="max-w-[460px] overflow-hidden border border-line">
      <label id={inputId} htmlFor={`${inputId}-search`} className="sr-only">Command bar</label>
      <div className="flex items-center gap-3 border-b border-line px-4 text-muted">
        <IconSearch size={17} />
        <input
          id={`${inputId}-search`}
          data-autofocus
          role="combobox"
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={selected >= 0 ? `${listId}-${selected}` : undefined}
          className="min-w-0 flex-1 bg-transparent py-4 text-ink outline-none"
          placeholder="Search commands…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Tab") {
              event.preventDefault();
            } else if (results.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
            } else if (event.key === "Enter" && selected >= 0) {
              event.preventDefault();
              run(results[selected]);
            }
          }}
        />
        <kbd className="rounded border border-line px-1.5 text-[11px]">Esc</kbd>
      </div>
      <ul id={listId} role="listbox" aria-label="Commands" className="p-2">
        {results.map((command, index) => (
          <li
            id={`${listId}-${index}`}
            key={command.label}
            role="option"
            aria-selected={index === selected}
            className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${index === selected ? "bg-accent-soft text-accent" : "text-ink"}`}
            onPointerMove={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(command)}
          >
            {command.label}
            {command.shortcut && <kbd className="text-xs text-muted">{command.shortcut}</kbd>}
          </li>
        ))}
      </ul>
      {results.length === 0 && <p role="status" className="px-5 pb-5 text-sm text-muted">No matching commands.</p>}
    </Modal>
  );
}
