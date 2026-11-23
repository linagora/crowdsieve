'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { INVALID_IP_SEARCH_MESSAGE, parseIpSearch } from '@/lib/ipSearch';
import { cn } from '@/lib/utils';

// Delay after the last keystroke before the search is applied
const APPLY_DELAY = 500;

interface IpSearchInputProps {
  /** Applied search (a valid address or CIDR), null when none. */
  value: string | null;
  onChange: (ip: string | null) => void;
}

/**
 * "Search IP…" field. The search is applied on Enter or 500 ms after the last
 * keystroke; an invalid value shows an error and leaves the applied search
 * (and so the list) unchanged.
 */
export function IpSearchInput({ value, onChange }: IpSearchInputProps) {
  const errorId = useId();
  const [text, setText] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Follow changes made elsewhere (Reset, chip removal, URL navigation)
  useEffect(() => {
    const typed = parseIpSearch(textRef.current)?.value ?? null;
    if (typed !== value) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setText(value ?? '');
      setError(null);
    }
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const apply = (input: string) => {
    clearTimer();
    if (!input.trim()) {
      setError(null);
      if (value !== null) onChange(null);
      return;
    }
    const parsed = parseIpSearch(input);
    if (!parsed) {
      setError(INVALID_IP_SEARCH_MESSAGE);
      return;
    }
    setError(null);
    if (parsed.value !== value) onChange(parsed.value);
  };

  const handleChange = (next: string) => {
    setText(next);
    clearTimer();
    timerRef.current = setTimeout(() => apply(next), APPLY_DELAY);
  };

  return (
    <div className="w-[280px]">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply(text);
            }
          }}
          placeholder="IP address, e.g. 203.0.113.7"
          aria-label="Search IP"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          maxLength={64}
          className={cn(
            'h-10 w-full rounded-md border bg-white pl-9 pr-8 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-crowdsec-primary',
            error ? 'border-red-400' : 'border-slate-200'
          )}
        />
        {text && (
          <button
            type="button"
            onClick={() => {
              setText('');
              apply('');
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
            aria-label="Clear IP search"
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
