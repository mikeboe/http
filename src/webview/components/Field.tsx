// Text fields that debounce edits and keep the user's text while focused.
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { VariableInfo } from '../../core/protocol';
import { templateParts, variableNames } from '../util';

export const DEBOUNCE_MS = 300;

const flushers = new Set<() => void>();

/** Increments with every `state` from the host, so fields can drop edits the host did not take. */
export const StateSeq = createContext(0);

/** Commits every pending debounced edit now (before a send). */
export function flushPendingEdits(): void {
  for (const f of [...flushers]) f();
}

/**
 * Local text state for an input bound to a host value. Edits are committed after `DEBOUNCE_MS`
 * and on blur. While focused, a new host value never replaces the text; on blur, or when the host
 * value changes while unfocused, the input shows the host value. `commit` returns false when it
 * rejected the value (e.g. invalid); the text is then reset to the host value on blur.
 */
export function useDraft(value: string, commit: (v: string) => boolean | void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const valueRef = useRef(value);
  valueRef.current = value;
  // The last committed text the host has not echoed yet.
  const inFlight = useRef<string | undefined>(undefined);

  /** Commits the pending text; returns false if there was none or it was rejected. */
  const flush = useCallback((): boolean => {
    clearTimeout(timer.current);
    timer.current = undefined;
    flushers.delete(flush);
    const v = pending.current;
    pending.current = undefined;
    if (v === undefined || v === (inFlight.current ?? valueRef.current)) return false;
    if (commitRef.current(v) === false) return false;
    inFlight.current = v;
    return true;
  }, []);

  const seq = useContext(StateSeq);

  // Every new state settles the edit in flight: either it carries the edit or the host rejected it.
  useEffect(() => {
    inFlight.current = undefined;
    if (!focused.current && pending.current === undefined) setDraft(value);
  }, [value, seq]);
  useEffect(() => () => { flush(); }, [flush]);

  return {
    draft,
    onInput(v: string) {
      setDraft(v);
      pending.current = v;
      flushers.add(flush);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    },
    onFocus() { focused.current = true; },
    onBlur() {
      focused.current = false;
      // Keep the text if an edit is on its way to the host; otherwise show the host value.
      if (!flush() && inFlight.current === undefined) setDraft(valueRef.current);
    },
  };
}

/** Variables known to the host, by name. */
export const VarsContext = createContext<Map<string, VariableInfo>>(new Map());

function describe(name: string, v: VariableInfo | undefined): string {
  if (!v) return `{{${name}}}`;
  switch (v.kind) {
    case 'missing': return `{{${name}}}: not set in the current environment`;
    case 'secret': return `{{${name}}}: secret from ${v.file ?? 'the environment'}`;
    case 'pathParam': return `{{${name}}}: path parameter = ${v.value ?? ''}`;
    default: return `{{${name}}}: from ${v.file ?? 'the environment'} = ${v.value ?? ''}`;
  }
}

/** Tooltip text listing the variables used in `s` and where they come from. */
export function useVariableTooltip(s: string): string | undefined {
  const vars = useContext(VarsContext);
  const names = variableNames(s);
  return names.length ? names.map((n) => describe(n, vars.get(n))).join('\n') : undefined;
}

interface TextFieldProps {
  value: string;
  onCommit(v: string): boolean | void;
  placeholder?: string;
  class?: string;
  /** Returns an error message for invalid text; invalid text is not committed. */
  validate?(v: string): string | undefined;
  /** Show `{{var}}` tokens (default true). */
  template?: boolean;
  ariaLabel?: string;
}

/**
 * A single-line input. `{{var}}` tokens are drawn by a mirror layer behind the transparent input:
 * known variables get a highlight, missing ones an error underline; the tooltip names the sources.
 */
export function TextField(p: TextFieldProps) {
  const validate = p.validate;
  const d = useDraft(p.value, (v) => (validate?.(v) ? false : p.onCommit(v)));
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const template = p.template !== false;
  const sync = () => { if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft; };
  useLayoutEffect(sync);
  const error = validate?.(d.draft);
  const tooltip = useVariableTooltip(template ? d.draft : '');
  return (
    <div class={`field${error ? ' invalid' : ''}${p.class ? ` ${p.class}` : ''}`}>
      {template && (
        <div class="field-mirror" ref={mirror} aria-hidden="true">
          <Tokens text={d.draft} />
          {'\u00a0'}
        </div>
      )}
      <input
        ref={input}
        type="text"
        spellcheck={false}
        value={d.draft}
        placeholder={p.placeholder}
        aria-label={p.ariaLabel ?? p.placeholder}
        aria-invalid={error ? true : undefined}
        title={error ?? tooltip}
        onInput={(e) => { d.onInput(e.currentTarget.value); sync(); }}
        onFocus={d.onFocus}
        onBlur={d.onBlur}
        onScroll={sync}
        onKeyUp={sync}
        onSelect={sync}
      />
    </div>
  );
}

interface TextAreaProps { value: string; onCommit(v: string): void; onDraft?(v: string): void; class?: string; ariaLabel?: string; placeholder?: string }

/** Highlighted `{{var}}` tokens for a mirror layer; the text itself is transparent. */
function Tokens({ text }: { text: string }) {
  const vars = useContext(VarsContext);
  return (
    <>
      {templateParts(text).map((part, i) => {
        if (part.kind === 'text') return part.text;
        const kind = part.kind === 'var' ? vars.get(part.name)?.kind ?? 'unknown' : 'expr';
        return <span key={i} class={`tok tok-${kind}`}>{part.text}</span>;
      })}
    </>
  );
}

/**
 * A monospace multi-line editor with the same debounce and focus rules as `TextField`, and the
 * same `{{var}}` mirror layer (no other highlighting).
 */
export function TextArea(p: TextAreaProps) {
  const d = useDraft(p.value, p.onCommit);
  const tooltip = useVariableTooltip(d.draft);
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const sync = () => {
    if (!mirror.current || !area.current) return;
    mirror.current.scrollTop = area.current.scrollTop;
    mirror.current.scrollLeft = area.current.scrollLeft;
  };
  useLayoutEffect(sync);
  return (
    <div class={`field field-area${p.class ? ` ${p.class}` : ''}`}>
      <div class="field-mirror code-mirror" ref={mirror} aria-hidden="true"><Tokens text={d.draft} />{'\n\u00a0'}</div>
      <textarea
        ref={area}
        class="code-area"
        spellcheck={false}
        value={d.draft}
        placeholder={p.placeholder}
        aria-label={p.ariaLabel}
        title={tooltip}
        onInput={(e) => { d.onInput(e.currentTarget.value); p.onDraft?.(e.currentTarget.value); sync(); }}
        onFocus={d.onFocus}
        onBlur={d.onBlur}
        onScroll={sync}
      />
    </div>
  );
}
