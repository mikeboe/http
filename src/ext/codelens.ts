import * as vscode from 'vscode';

/** "▶ Send" above the first line of a request opened as text. */
export class SendCodeLens implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: '▶ Send', command: 'yamlHttp.send', arguments: [document.uri] })];
  }
}

export const registerCodeLens = () =>
  vscode.languages.registerCodeLensProvider({ pattern: '**/*.req.yaml' }, new SendCodeLens());
