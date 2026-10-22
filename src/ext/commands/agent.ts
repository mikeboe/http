import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { adaptGuide, skillText } from '../agentGuide';
import { requireRoots } from '../services';
import type { Ext } from '../services';

const exists = (p: string) => access(p).then(() => true, () => false);

/** Writes `<root>/AGENTS.md`, copies the schemas to `<root>/.schema/`, and optionally a Claude Code skill. */
export async function addAgentInstructions(ext: Ext): Promise<void> {
  const { root, workspaceDir } = requireRoots();
  const extDir = ext.context.extensionPath;
  const rel = path.relative(workspaceDir, root).split(path.sep).join('/');
  const guide = adaptGuide(await readFile(path.join(extDir, 'resources', 'agent-guide.md'), 'utf8'), rel);

  const agents = path.join(root, 'AGENTS.md');
  if (await exists(agents)) {
    const ok = await vscode.window.showWarningMessage(`${rel || '.'}/AGENTS.md exists. Replace it?`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
  }
  await mkdir(root, { recursive: true });
  await writeFile(agents, guide);

  const schemaDir = path.join(root, '.schema');
  await mkdir(schemaDir, { recursive: true });
  for (const f of (await readdir(path.join(extDir, 'schemas'))).filter((x) => x.endsWith('.json'))) {
    await copyFile(path.join(extDir, 'schemas', f), path.join(schemaDir, f));
  }

  const choice = await vscode.window.showInformationMessage(
    `Wrote ${rel || '.'}/AGENTS.md and ${rel || '.'}/.schema/. Also add a Claude Code skill (.claude/skills/http-requests/SKILL.md)?`,
    'Add skill', 'No',
  );
  if (choice === 'Add skill') {
    const dir = path.join(workspaceDir, '.claude', 'skills', 'http-requests');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), skillText(guide));
  }
  await vscode.window.showTextDocument(vscode.Uri.file(agents));
}
