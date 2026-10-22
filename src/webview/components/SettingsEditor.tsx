import type { Settings } from '../../core/model';
import type { Inherited } from '../../core/protocol';
import { useMapExists } from '../hooks';
import { settingOp } from '../ops';
import { DURATION, folderLabel } from '../util';
import { edit } from '../vscode';
import { TextField } from './Field';

export function SettingsEditor({ settings, inherited, present }: { settings: Settings; inherited: Inherited['settings']; present: boolean }) {
  const mapExists = useMapExists(present);
  const set = (key: keyof Settings, value: string | boolean) => edit(settingOp(mapExists(), key, value));
  /** "inherited from api: false" when the request does not set `key` but a folder does. */
  const hint = (key: keyof Settings): string | undefined => {
    const v = inherited[key];
    if (settings[key] !== undefined || v === undefined) return undefined;
    return `inherited from ${folderLabel(inherited.from?.[key] ?? 'a folder')}: ${String(v)}`;
  };
  const checkbox = (key: 'followRedirects' | 'verifyTls', text: string) => {
    const h = hint(key);
    return (
      <label class="form-row form-check">
        <input type="checkbox" checked={(settings[key] ?? inherited[key]) !== false} onChange={(e) => set(key, e.currentTarget.checked)} />
        <span>{text}</span>
        {h && <span class="hint">({h})</span>}
      </label>
    );
  };
  const timeoutHint = hint('timeout');
  return (
    <div class="form">
      <label class="form-row">
        <span class="form-label">Timeout</span>
        <TextField
          class="short"
          value={settings.timeout ?? ''}
          placeholder={inherited.timeout !== undefined ? `${inherited.timeout} (inherited)` : 'e.g. 30s'}
          ariaLabel="Timeout"
          template={false}
          validate={(v) => (v === '' || DURATION.test(v.trim()) ? undefined : 'Use a duration such as 500ms, 10s, 2m or 1h')}
          onCommit={(v) => set('timeout', v.trim())}
        />
        <span class="hint">{timeoutHint ? `Empty: ${timeoutHint}.` : 'Empty uses the default timeout.'} Units: ms, s, m, h.</span>
      </label>
      {checkbox('followRedirects', 'Follow redirects')}
      {checkbox('verifyTls', 'Verify TLS certificates')}
    </div>
  );
}
