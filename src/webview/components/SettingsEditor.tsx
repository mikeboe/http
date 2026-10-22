import type { Settings } from '../../core/model';
import { DURATION } from '../util';
import { edit } from '../vscode';
import { TextField } from './Field';

export function SettingsEditor({ settings }: { settings: Settings }) {
  const set = (key: keyof Settings, value: string | boolean) => {
    // Set the whole map when it may be absent on disk.
    if (Object.keys(settings).length === 0) edit({ op: 'set', path: ['settings'], value: { [key]: value } });
    else edit({ op: 'set', path: ['settings', key], value });
  };
  return (
    <div class="form">
      <label class="form-row">
        <span class="form-label">Timeout</span>
        <TextField
          class="short"
          value={settings.timeout ?? ''}
          placeholder="e.g. 30s"
          ariaLabel="Timeout"
          template={false}
          validate={(v) => (v === '' || DURATION.test(v.trim()) ? undefined : 'Use a duration such as 500ms, 10s, 2m or 1h')}
          onCommit={(v) => (v.trim() === '' ? edit({ op: 'delete', path: ['settings', 'timeout'] }) : set('timeout', v.trim()))}
        />
        <span class="hint">Empty uses the folder or default timeout. Units: ms, s, m, h.</span>
      </label>
      <label class="form-row form-check">
        <input type="checkbox" checked={settings.followRedirects !== false} onChange={(e) => set('followRedirects', e.currentTarget.checked)} />
        <span>Follow redirects</span>
      </label>
      <label class="form-row form-check">
        <input type="checkbox" checked={settings.verifyTls !== false} onChange={(e) => set('verifyTls', e.currentTarget.checked)} />
        <span>Verify TLS certificates</span>
      </label>
    </div>
  );
}
