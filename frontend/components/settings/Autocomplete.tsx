'use client';

import { useEffect, useRef, useState } from 'react';
import { inputClass } from './ui';

export type AutocompleteOption = {
  key: string;
  /** What goes into the input when picked. */
  value: string;
  primary: string;
  secondary?: string;
};

/**
 * A text input with a suggestion list under it (Settings → Home city / Home
 * airport). Typing is never blocked: the field still takes free text, the list
 * is a shortcut. Arrow keys move, Enter picks, Escape closes.
 */
export default function Autocomplete({
  id,
  value,
  onChange,
  fetchOptions,
  onPick,
  placeholder,
  maxLength,
  className = '',
  minChars = 2,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  fetchOptions: (q: string, signal: AbortSignal) => Promise<AutocompleteOption[]>;
  onPick?: (option: AutocompleteOption) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  minChars?: number;
}) {
  const [options, setOptions] = useState<AutocompleteOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Only fetch for text the user TYPED — not for the saved value on load, nor
  // for the text a pick just put in.
  const [query, setQuery] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fetchRef = useRef(fetchOptions);
  fetchRef.current = fetchOptions;

  useEffect(() => {
    if (query === null) return;
    const q = query.trim();
    if (q.length < minChars) {
      setOptions([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchRef
        .current(q, controller.signal)
        .then((opts) => {
          setOptions(opts);
          setActive(-1);
          setOpen(opts.length > 0);
        })
        .catch(() => {
          /* aborted or offline — the field still works as plain text */
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, minChars]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (o: AutocompleteOption) => {
    onChange(o.value);
    onPick?.(o);
    setQuery(null);
    setOpen(false);
    setOptions([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || options.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); // don't submit the form
      pick(options[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const listId = `${id}-suggestions`;
  return (
    <div className="relative" ref={wrapRef}>
      <input
        id={id}
        className={`${inputClass} ${className}`}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
        }}
        onFocus={() => options.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 z-30 bg-white rounded-lg shadow-lg border border-gray-100 py-1 max-h-64 overflow-auto"
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer ${i === active ? 'bg-gray-50' : ''}`}
            >
              <div className="text-sm text-gray-800 normal-case">{o.primary}</div>
              {o.secondary && <div className="text-xs text-gray-400 normal-case">{o.secondary}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
