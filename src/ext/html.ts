// vscode-free: the request editor webview's HTML shell.
import { randomBytes } from 'node:crypto';

export function makeNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

export function webviewHtml(o: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string {
  const csp = `default-src 'none'; style-src ${o.cspSource} 'unsafe-inline'; script-src 'nonce-${o.nonce}'; `
    + `img-src ${o.cspSource} data:; font-src ${o.cspSource};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Request</title>
</head>
<body>
<div id="app"></div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>
`;
}
