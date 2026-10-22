export interface TabDef { id: string; label: string; count?: number; note?: string }

/** A tab strip; counts show as a badge ("Headers 2"), notes as dim text ("Body JSON"). */
export function Tabs({ tabs, active, onChange, class: cls }: { tabs: TabDef[]; active: string; onChange(id: string): void; class?: string }) {
  return (
    <div class={`tabs ${cls ?? ''}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          class={`tab${t.id === active ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count ? <span class="count">{t.count}</span> : null}
          {t.note ? <span class="note">{t.note}</span> : null}
        </button>
      ))}
    </div>
  );
}
