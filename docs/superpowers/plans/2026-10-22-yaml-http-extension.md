# YAML HTTP VS Code Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that edits and sends HTTP requests stored as `*.req.yaml` files, in a Yaak-style split-screen custom editor, with environments, auth, chaining and OpenAPI import/re-import.

**Architecture:** All logic lives in `src/core/`. It is plain TypeScript with no `vscode` import, and it's unit-tested with vitest against real temp directories and local HTTP servers. `src/ext/` is a thin VS Code layer: custom editor provider, tree view, status bar, commands and SecretStorage adapter. It delegates to core and to `src/ext/controller.ts`, which is vscode-free so it can be tested. `src/webview/` is a Preact app styled only with VS Code theme CSS variables. It talks to the host through the message protocol in `src/core/protocol.ts`, and it is verified in Playwright through a harness page that mocks `acquireVsCodeApi`.

**Tech Stack:** TypeScript 5, esbuild, vitest, `yaml` (eemeli) 2.x, `undici` (for `Agent` with `rejectUnauthorized`), `@apidevtools/swagger-parser`, Preact, Playwright (dev, already in sandbox), `@vscode/vsce` (packaging).

**Spec:** `docs/superpowers/specs/2026-10-22-http-client-design.md`

## Global Constraints

- `engines.vscode`: `^1.90.0`. Extension host is Node; the extension does not run in VS Code for the Web.
- Settings / command / view prefix: `yamlHttp` (setting `yamlHttp.root`, default `.http`).
- Request files: `*.req.yaml`; folder files: `_folder.yaml`; environments: `env/<name>.yaml` + `env/<name>.env` + `env/<name>.env.example`; import bookkeeping in `.openapi/`.
- `src/core/**` must not import `vscode`.
- The webview never receives resolved secret values. Secrets are: values from `.env`, credentials produced by auth, and the `Authorization`, `Cookie`, `Proxy-Authorization` request header values. In the Timeline, mask them as `•••••`.
- UI colours, fonts and borders come only from `--vscode-*` CSS variables (for example `--vscode-editor-background`, `--vscode-foreground`, `--vscode-button-background`, `--vscode-input-background`, `--vscode-panel-border`, `--vscode-editor-font-family`). There are no hard-coded colours, apart from method badge colours, which take a `--vscode-charts-*` variable.
- YAML edits go through the `yaml` Document API. Untouched nodes keep their comments, order and formatting.
- History: last 20 responses per request per environment, stored in extension workspace storage.
- Templating: only `{{name}}`, `{{response('id','path'[,'maxAge'])}}` and the escape `\{{`. Values are not expanded recursively.
- Re-import conflicts: the user wins and the file is flagged. The user can take the spec version per file.

## Review Focus

1. **Broken YAML open in the editor.** The UI shows the parse error and an "Open as text" action, and never writes to the file. Test is in Task 10 (`controller does not edit invalid document`).
2. **Concurrent outside edit.** An agent or git rewrites the file while the UI is open. The UI re-renders from disk, and the next UI edit applies to the new text, not stale text. Test is in Task 10 (`edit applies to latest text`).
3. **Values containing `{{`.** An environment value containing `{{x}}` is inserted literally, not expanded again. Test is in Task 4 (`does not expand recursively`).
4. **Binary or large responses.** Store the body base64. Set `bodyText` only for text content types. Cap the stored body at 10 MB and set `truncated: true`. Test is in Task 5 (`binary response`, `truncates large body`).
5. **Request ids with spaces or unicode.** For example `my folder/Über list.req.yaml`, used by `response('my folder/Über list', …)` and by the tree. Test is in Task 3 (`ids with spaces and unicode`).

---

## File Structure

```
package.json, tsconfig.json, esbuild.mjs, vitest.config.ts, .vscodeignore
schemas/request.schema.json, folder.schema.json, environment.schema.json, openapi-registry.schema.json
resources/agent-guide.md          # AGENTS.md / SKILL.md template
src/core/model.ts                 # types, parseRequest/parseFolder, durations
src/core/yamlEdit.ts              # EditOp + applyEdits (comment-preserving)
src/core/workspace.ts             # ids, listing, folder chain, effective request
src/core/env.ts                   # environments, dotenv, gitignore
src/core/template.ts              # parse/render templates
src/core/resolve.ts               # EffectiveRequest -> ResolvedRequest
src/core/extract.ts               # value paths: body.a[0].b, headers.x, status
src/core/http.ts                  # send, redirects, cookies, timeline, masking
src/core/auth.ts                  # basic/bearer/apiKey/oauth2
src/core/history.ts               # HistoryStore
src/core/runner.ts                # runRequest + chaining
src/core/openapi/load.ts          # load + dereference spec
src/core/openapi/generate.ts      # spec -> files
src/core/openapi/merge.ts         # three-way YAML merge
src/core/openapi/importer.ts      # plan/apply import, registry, snapshot
src/core/protocol.ts              # host<->webview messages
src/ext/extension.ts              # activate: wiring
src/ext/controller.ts             # vscode-free editor controller
src/ext/editorProvider.ts         # CustomTextEditorProvider
src/ext/tree.ts, envStatus.ts, secrets.ts, commands.ts, codelens.ts
src/webview/main.tsx, App.tsx, components/*.tsx, styles.css, vscode.ts
test/core/*.test.ts, test/ext/controller.test.ts
test/webview/harness.html, test/webview/screenshot.mjs
```

---

### Task 1: Scaffold, model and schemas

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.mjs`, `.vscodeignore`, `src/core/model.ts`, `schemas/*.json`
- Test: `test/core/model.test.ts`

**Interfaces:**
- Produces (`src/core/model.ts`):
  ```ts
  export type KV = { name: string; value: string; enabled?: boolean };
  export type Auth =
    | { type: 'none' } | { type: 'inherit' }
    | { type: 'basic'; username: string; password: string }
    | { type: 'bearer'; token: string }
    | { type: 'apiKey'; in: 'header' | 'query'; name: string; value: string }
    | { type: 'oauth2'; grant: 'clientCredentials'; tokenUrl: string; clientId: string; clientSecret?: string; scope?: string }
    | { type: 'oauth2'; grant: 'authorizationCode'; authUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scope?: string; pkce?: boolean; redirectUri?: string };
  export type MultipartPart = { name: string; value?: string; file?: string; enabled?: boolean };
  export type Body =
    | { type: 'none' } | { type: 'json'; content: string }
    | { type: 'text'; contentType: string; content: string }
    | { type: 'form'; fields: KV[] } | { type: 'multipart'; parts: MultipartPart[] }
    | { type: 'file'; path: string };
  export interface Settings { timeout?: string; followRedirects?: boolean; verifyTls?: boolean }
  export interface Source { spec: string; operationId: string; removed?: boolean }
  export interface RequestDef { name: string; method: string; url: string; pathParams: Record<string, string>;
    query: KV[]; headers: KV[]; auth?: Auth; body: Body; settings: Settings; source?: Source }
  export interface FolderDef { headers: KV[]; auth?: Auth; settings: Settings }
  export interface Diagnostic { message: string; line?: number; col?: number }
  export const HTTP_METHODS: readonly string[]; // GET POST PUT PATCH DELETE HEAD OPTIONS
  export function parseRequest(text: string): { request?: RequestDef; errors: Diagnostic[] };
  export function parseFolder(text: string): { folder?: FolderDef; errors: Diagnostic[] };
  export function parseDuration(s: string): number; // ms; '500ms','10s','30m','2h'; throws on invalid
  ```
  On-disk `body` is a one-key mapping: `json` (block string **or** YAML mapping/list → `JSON.stringify(v, null, 2)`), `text: {contentType, content}`, `form: KV[]`, `multipart: MultipartPart[]`, `file: string`, `none: true`. A missing body means `{type:'none'}`. A missing `method` means `GET`. A missing `url` is an error. Unknown top-level keys produce a Diagnostic warning (`unknown key "x"`), and parsing still succeeds.

- [ ] **Step 1: Scaffold.** `package.json` with `name: "yaml-http"`, `displayName: "YAML HTTP"`, `main: "./dist/extension.js"`, `engines.vscode: "^1.90.0"`, scripts `build` (node esbuild.mjs), `test` (vitest run), `typecheck` (tsc --noEmit), `package` (vsce package --no-dependencies). esbuild bundles `src/ext/extension.ts` → `dist/extension.js` (cjs, node, external `vscode`) and `src/webview/main.tsx` → `dist/webview.js` (iife, browser, jsx automatic with `jsxImportSource: 'preact'`) plus `dist/webview.css`. Install deps: `yaml undici @apidevtools/swagger-parser preact`; dev: `typescript esbuild vitest @types/node @types/vscode@1.90 @vscode/vsce`.
- [ ] **Step 2: Write failing tests** in `test/core/model.test.ts`:
  - `parses full request`: the spec's example (pathParams, query with `enabled:false`, headers, bearer auth, `json: |` block, settings, source) gives the exact `RequestDef`, and `errors` is `[]`.
  - `json mapping body is stringified`: `body: {json: {a: 1}}` gives `content === '{\n  "a": 1\n}'`.
  - `defaults`: `url: x` only gives `method 'GET'`, `query []`, `headers []`, `pathParams {}`, `body {type:'none'}`, `settings {}`.
  - `missing url is error`, `invalid yaml reports line` (errors[0].line is a number), `unknown method is error`, `unknown key warns`.
  - `parseDuration`: `'500ms'→500`, `'10s'→10000`, `'30m'→1800000`, `'2h'→7200000`, `'x'` throws.
- [ ] **Step 3: Run** `npx vitest run test/core/model.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement `model.ts`.** Write JSON Schemas (draft-07) for request, folder, environment (`variables: {[k]: string}`) and the registry (`source`, `target`, `importedAt`), matching the shapes above.
- [ ] **Step 5: Run tests.** Expected: PASS. Also run `npx tsc --noEmit`, which should be clean.
- [ ] **Step 6: Commit** `feat: scaffold extension and request model`.

### Task 2: Comment-preserving YAML edits

**Files:** Create `src/core/yamlEdit.ts`; Test `test/core/yamlEdit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type YamlPath = (string | number)[];
  export type EditOp =
    | { op: 'set'; path: YamlPath; value: unknown }
    | { op: 'delete'; path: YamlPath }
    | { op: 'insert'; path: YamlPath; index: number; value: unknown }   // into a sequence at path
    | { op: 'move'; path: YamlPath; from: number; to: number };         // reorder in sequence
  export function applyEdits(text: string, ops: EditOp[]): string;      // throws on unparsable text
  ```
  Paths use the on-disk shape (for example `['headers', 1, 'value']`, `['body', 'json']`). Strings containing `\n` are written as block literals (`|`). A `set` on a missing path creates the intermediate maps or sequences. Setting `['body']` replaces the whole body node.

- [ ] **Step 1: Failing tests:**
  - `keeps comments`: a file with a `# note` comment above `headers`, after `set ['url'] 'http://b'`, still contains `# note` and has the new url. Every other line stays identical.
  - `multiline string becomes block literal`: `set ['body','json'] '{\n  "a": 1\n}'` gives text containing `json: |`.
  - `replaces json mapping with block string` (spec: the first UI edit converts that node).
  - `insert header`, `delete header`, `move query`, `creates missing path` (`set ['settings','timeout'] '5s'` on a file without settings).
  - `throws on invalid yaml`.
- [ ] **Step 2: Run** `npx vitest run test/core/yamlEdit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `parseDocument` / `doc.setIn` / `doc.deleteIn` / `doc.createNode`. Set `Scalar.type = 'BLOCK_LITERAL'` for multiline strings. Insert and move work on the `YAMLSeq.items` array.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: comment-preserving yaml edits`.

### Task 3: Workspace layout and folder inheritance

**Files:** Create `src/core/workspace.ts`; Test `test/core/workspace.test.ts`

**Interfaces:**
- Consumes: `parseRequest`, `parseFolder`, types from Task 1.
- Produces:
  ```ts
  export interface TreeNode { kind: 'folder' | 'request'; id: string; path: string; name: string;
    method?: string; removed?: boolean; invalid?: boolean; children?: TreeNode[] }
  export function requestIdFromPath(root: string, file: string): string;   // posix rel path minus '.req.yaml'
  export function requestPathFromId(root: string, id: string): string;
  export function listTree(root: string): Promise<TreeNode[]>;            // skips env/, .openapi/, .schema/; folders first, then alpha
  export function loadFolderChain(root: string, requestFile: string): Promise<{ dir: string; folder: FolderDef }[]>; // outermost first
  export interface EffectiveRequest extends Omit<RequestDef, 'auth'> { auth: Auth; authFrom?: string; inheritedHeaders: KV[]; file: string; id: string }
  export function effectiveRequest(req: RequestDef, chain: { dir: string; folder: FolderDef }[], file: string, root: string): EffectiveRequest;
  export function loadEffective(root: string, id: string): Promise<EffectiveRequest>; // throws Error(`Request not found: ${id}`) / parse errors
  ```
  Rules from the spec: headers merge outermost to innermost, and a request header with the same name (case-insensitive) wins. Disabled headers don't override. `auth` missing or `inherit` means the nearest folder auth, otherwise `{type:'none'}`. `authFrom` is the folder's relative dir. Each `settings` key is overridden whole, innermost wins.

- [ ] **Step 1: Failing tests** using `fs.mkdtemp`:
  - `id round trip`
  - `ids with spaces and unicode`: `my folder/Über list.req.yaml` ↔ `'my folder/Über list'`.
  - `tree lists folders then requests with methods`, `tree skips env and .openapi`, `tree marks invalid and removed files`.
  - `inherits folder auth and reports authFrom`, `request auth overrides`, `nearest folder wins`, `headers merge case-insensitively`, `settings merge per key`.
  - `loadEffective missing id throws`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: workspace tree and folder inheritance`.

### Task 4: Environments and templating

**Files:** Create `src/core/env.ts`, `src/core/template.ts`; Tests `test/core/env.test.ts`, `test/core/template.test.ts`

**Interfaces:**
- Produces (`env.ts`):
  ```ts
  export interface Environment { name: string; variables: Record<string, string>; secrets: Record<string, string> }
  export function parseDotenv(text: string): Record<string, string>;   // KEY=value, quotes, # comments, export prefix
  export function listEnvironments(root: string): Promise<string[]>;
  export function loadEnvironment(root: string, name: string): Promise<Environment>; // missing files => empty
  export function createEnvironment(root: string, name: string, workspaceDir: string): Promise<{ gitignoreUpdated: boolean }>;
  export function ensureGitignore(workspaceDir: string, relRoot: string): Promise<boolean>; // adds `<relRoot>/env/*.env` and `!<relRoot>/env/*.env.example` if missing
  export function addVariables(root: string, env: string, vars: Record<string, string>): Promise<void>;  // only keys not present, comment-preserving
  export function addSecretNames(root: string, env: string, names: string[]): Promise<void>;           // to <env>.env.example (and empty KEY= in .env if missing)
  export function variableSource(root: string, env: Environment, name: string): { kind: 'variable' | 'secret'; file: string } | undefined;
  ```
- Produces (`template.ts`):
  ```ts
  export type Segment = { kind: 'text'; text: string } | { kind: 'var'; name: string }
    | { kind: 'response'; request: string; path: string; maxAge?: string };
  export class TemplateError extends Error {}
  export class MissingVariableError extends Error { constructor(public variable: string) }
  export function parseTemplate(s: string): Segment[];
  export function referencedVariables(s: string): string[];
  export interface TemplateContext {
    lookup(name: string): { value: string; secret: boolean } | undefined;
    response(request: string, path: string, maxAge?: string): Promise<{ value: string; secret: boolean }>;
  }
  export function renderTemplate(s: string, ctx: TemplateContext): Promise<{ value: string; secrets: string[] }>;
  ```
  Var names match `[A-Za-z_][A-Za-z0-9_.-]*`, with whitespace allowed inside braces. `response(...)` args are single- or double-quoted strings. `\{{` renders a literal `{{`. A missing variable throws `MissingVariableError`. The runner turns it into the message from the spec: `Variable "apiToken" is not set. Add it to .http/env/local.env (or local.yaml).`

- [ ] **Step 1: Failing tests:**
  - env: `parseDotenv handles quotes comments export`, `env overrides yaml`, `createEnvironment writes files and updates gitignore once` (a second call gives `gitignoreUpdated: false`), `addVariables keeps existing values and comments`, `addSecretNames writes example`.
  - template: `renders vars`, `renders response call with maxAge`, `escape`, `missing variable throws MissingVariableError with name`, `does not expand recursively` (a value of `'{{x}}'` stays literal), `collects secrets`, `unterminated braces throws TemplateError`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: environments and templating`.

### Task 5: Resolve and send over HTTP

**Files:** Create `src/core/resolve.ts`, `src/core/extract.ts`, `src/core/http.ts`; Tests `test/core/resolve.test.ts`, `test/core/http.test.ts`, `test/core/extract.test.ts`

**Interfaces:**
- Consumes: `EffectiveRequest` (Task 3), `renderTemplate`, `Environment` (Task 4), `parseDuration`.
- Produces:
  ```ts
  // resolve.ts
  export type ResolvedBody = { kind: 'none' } | { kind: 'bytes'; data: Buffer; contentType?: string }
    | { kind: 'form'; fields: [string, string][] } | { kind: 'multipart'; parts: { name: string; value?: string; file?: string; filename?: string }[] };
  export interface ResolvedRequest { method: string; url: string; headers: [string, string][]; body: ResolvedBody;
    timeoutMs: number; followRedirects: boolean; verifyTls: boolean; secrets: Set<string>; auth: Auth /* rendered */ }
  export function resolveRequest(req: EffectiveRequest, env: Environment,
    response: TemplateContext['response']): Promise<ResolvedRequest>;
  // lookup order: req.pathParams (rendered against env), then env.secrets (secret), then env.variables.
  // enabled:false entries are dropped. query is appended to url with URLSearchParams. File paths are relative to the request file's dir.
  // json body => content-type application/json unless a header sets it. Default timeout 30s, followRedirects true, verifyTls true.

  // extract.ts
  export function extractValue(r: HttpResponse, path: string): string | undefined; // 'status' | 'headers.<name>' | 'body' | 'body.a.b[0].c'; objects -> JSON.stringify

  // http.ts
  export interface HttpResponse { status: number; statusText: string; headers: [string, string][]; url: string;
    bodyBase64: string; bodyText?: string; contentType?: string; sizeBytes: number; timeMs: number; truncated?: boolean }
  export type TimelineEntry = { kind: 'request' | 'redirect' | 'response' | 'dependency' | 'info' | 'error'; text: string; headers?: [string, string][] };
  export class CookieJar { cookieHeader(url: string): string | undefined; store(url: string, setCookie: string[]): void; clear(): void }
  export function send(req: ResolvedRequest, opts: { jar: CookieJar; signal?: AbortSignal }): Promise<{ response: HttpResponse; timeline: TimelineEntry[] }>;
  export function mask(text: string, secrets: Set<string>): string;   // replaces each secret (len>=1) with '•••••'
  export const MAX_BODY_BYTES = 10 * 1024 * 1024;
  ```
  Use `undici.fetch` with `redirect: 'manual'`, and with `dispatcher: new Agent({ connect: { rejectUnauthorized: false } })` when `!verifyTls`. Redirects are capped at 10. 303, or 301/302 on POST, switch to GET with no body. A redirect to a different origin drops `Authorization` and `Cookie`. Timeline `request` entries hold masked headers, and the `Authorization`, `Cookie` and `Proxy-Authorization` values are always masked. `bodyText` is set when the content type is `text/*`, `*json*`, `*xml*`, `*javascript*`, or `application/x-www-form-urlencoded`. The cookie jar handles a simple Domain/Path/Expires/Max-Age subset.

- [ ] **Step 1: Failing tests** against `http.createServer` on port 0:
  - resolve: `applies pathParams and env`, `pathParams override env`, `secrets tracked` (a `.env` value ends up in `secrets`), `disabled query dropped and query encoded`, `json content-type default`, `form and multipart`, `missing variable throws`.
  - extract: `status`, `header case-insensitive`, `nested body path with index`, `missing path undefined`, `non-json body with body.x undefined`.
  - http: `sends method headers body`, `follows redirects and records them`, `followRedirects false returns 302`, `cross-origin redirect drops Authorization` (two servers), `303 becomes GET`, `timeout aborts with error message containing 'timed out'`, `abort signal cancels`, `cookies stored and resent`, `binary response` (png bytes give `bodyText` undefined and the base64 round-trips), `truncates large body` (11 MB gives `truncated: true` and `sizeBytes` equal to the real size), `timeline masks secrets`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: resolve and send requests`.

### Task 6: Auth

**Files:** Create `src/core/auth.ts`; Test `test/core/auth.test.ts`

**Interfaces:**
- Consumes: `ResolvedRequest` (Task 5).
- Produces:
  ```ts
  export interface TokenStore { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void>; clear(): Promise<void> }
  export class MemoryTokenStore implements TokenStore {}
  export interface AuthDeps { tokens: TokenStore; openBrowser(url: string): Promise<void>; envName: string; timeline: TimelineEntry[] }
  export function applyAuth(req: ResolvedRequest, deps: AuthDeps): Promise<void>;  // mutates req.headers/url, adds credentials to req.secrets
  export function tokenKey(envName: string, auth: Auth): string;                   // `oauth:${env}:${sha256(tokenUrl|clientId|scope|grant)}`
  export function clearTokens(store: TokenStore): Promise<void>;
  ```
  Cached token JSON: `{ access_token, refresh_token?, expires_at? }`. A token counts as expired 30 s before `expires_at`. An expired token is refreshed with `refresh_token`, otherwise re-fetched. Client credentials sends `grant_type=client_credentials` with HTTP Basic client auth when there's a secret, else `client_id` in the body. Authorization code: start `http.createServer` on `127.0.0.1` with port 0, or with the `redirectUri` port and path; build `authUrl?response_type=code&client_id&redirect_uri&scope&state` plus `code_challenge`/`code_challenge_method=S256` when `pkce !== false`; call `openBrowser`; wait up to 5 min for the callback; check `state`; exchange the code; reply to the browser with "You can close this tab." Basic sets `Authorization: Basic base64(u:p)`. Bearer sets `Authorization: Bearer t`. apiKey goes in a header or the query.

- [ ] **Step 1: Failing tests:**
  - `basic`, `bearer`, `apiKey header`, `apiKey query`, `credentials added to secrets`.
  - `client credentials fetches and caches` (the token server is hit once across two calls), `expired token refreshes`.
  - `authorization code with pkce`: `openBrowser` is a test function that does a GET on the redirect URL with `code` and `state`. Assert the token server got `code_verifier` and that its S256 matches `code_challenge`.
  - `state mismatch rejects`, `fixed redirectUri port used`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: auth types and oauth2`.

### Task 7: History and runner with chaining

**Files:** Create `src/core/history.ts`, `src/core/runner.ts`; Tests `test/core/history.test.ts`, `test/core/runner.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  ```ts
  // history.ts
  export interface HistoryEntry { id: string; requestId: string; env: string; timestamp: number; ok: boolean;
    response?: HttpResponse; timeline: TimelineEntry[]; error?: string }
  export class HistoryStore { constructor(dir: string);
    add(e: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry>;  // keeps newest 20 per (requestId, env)
    list(requestId: string, env: string): Promise<HistoryEntry[]>;  // newest first
    get(id: string): Promise<HistoryEntry | undefined>;
    latestOk(requestId: string, env: string): Promise<HistoryEntry | undefined>;
    rename(oldId: string, newId: string): Promise<void> }
  // storage: <dir>/<sha1(requestId)>.<env>.json (array). ok === response && 200<=status<300 && !error

  // runner.ts
  export interface RunContext { root: string; envName: string; env: Environment; history: HistoryStore; jar: CookieJar;
    tokens: TokenStore; openBrowser(url: string): Promise<void>; signal?: AbortSignal; now?: () => number }
  export interface RunResult { entry: HistoryEntry }   // always recorded, including failures
  export class ChainError extends Error {}
  export function runRequest(id: string, ctx: RunContext, stack?: string[]): Promise<RunResult>;
  ```
  `response(req, path, maxAge)`: a request id in `stack` throws `ChainError('Circular dependency: a → b → a')`. Otherwise it uses `latestOk`; if there's none, or it's older than `maxAge`, it runs the dependency recursively and adds a `dependency` timeline entry (`Ran auth/login → 200 (120 ms)`). If the dependency's entry isn't ok, it throws `ChainError('Dependency auth/login failed: 401 Unauthorized')`. If `extractValue` is undefined, it throws `ChainError('Dependency auth/login has no value at body.token')`. A chained value counts as a secret when the path starts with `body`, `headers`, or the dependency used secrets. Any error, including `MissingVariableError`, is recorded as an entry with `ok: false, error`, and the request is not sent.

- [ ] **Step 1: Failing tests** with temp `.http` dirs and a local server:
  - history: `keeps 20`, `latestOk skips failures`, `per env separation`.
  - runner: `runs simple request and records`, `chain uses cached response` (the login server is hit once across two runs), `chain reruns when older than maxAge` (fake `now`), `chain runs dependency when no history`, `circular dependency error`, `failed dependency blocks parent` (the parent server is never hit), `missing value error`, `missing variable message names env file`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: history and request chaining`.

### Task 8: OpenAPI load and generate

**Files:** Create `src/core/openapi/load.ts`, `src/core/openapi/generate.ts`; Test `test/core/openapi-generate.test.ts`, fixture `test/fixtures/petstore.yaml` (OpenAPI 3.0 with tags, path and query params, a requestBody with `$ref`, bearer and apiKey securitySchemes, one untagged op, one op without operationId)

**Interfaces:**
- Produces:
  ```ts
  export type OpenApiDoc = any; // dereferenced
  export function loadSpec(source: string, baseDir: string): Promise<OpenApiDoc>; // path or http(s) URL; rejects swagger 2.0: 'Only OpenAPI 3.x is supported'
  export interface GeneratedRequest { operationId: string; relPath: string; text: string }  // relPath relative to target folder
  export interface Generated { requests: GeneratedRequest[]; folderText?: string; baseUrlVar: string; baseUrl?: string; secretVars: string[] }
  export function generate(doc: OpenApiDoc, specName: string): Generated;
  export function exampleFromSchema(schema: any): unknown;
  ```
  Rules (spec plus my calls):
  - `baseUrlVar`: camelCase of the spec name plus `BaseUrl` (`petstore` → `petstoreBaseUrl`).
  - operationId fallback: `${method}_${path}` slugified.
  - Folder: the first tag slugified. Untagged operations go in the root. Filename: operationId kebab-cased plus `.req.yaml`; a duplicate gets `-2`.
  - `name`: summary, else operationId.
  - Path params become `{{name}}` in the url and `pathParams[name]` = example, default or `''`.
  - Query and header params use the example or default value. Optional params get `enabled: false`.
  - Body: for `application/json`, a `json: |` block of `JSON.stringify(example, null, 2)`, using `example`, then `examples[0].value`, then `exampleFromSchema`. For form-urlencoded or multipart, use the properties.
  - Security: the global (or first operation's) scheme goes into `_folder.yaml`. Http bearer gives `{type: bearer, token: '{{<spec>Token}}'}`. Basic gives `{{<spec>Username}}`/`{{<spec>Password}}`. apiKey gives `{type: apiKey, in, name, value: '{{<spec>ApiKey}}'}`. OAuth2 client credentials or authorization code give a matching auth with `{{<spec>ClientId}}`/`{{<spec>ClientSecret}}`. Every `{{…}}` secret name is listed in `secretVars`.
  - An operation whose security differs from the folder's gets its own `auth`.
  - `source: {spec, operationId}` goes in each file.
  - `exampleFromSchema`: use example/default/enum[0] first; otherwise string → `''` (`format: date-time` → `'2024-01-01T00:00:00Z'`, `email` → `'user@example.com'`, `uuid` → zero uuid), integer/number → `0`, boolean → `false`, array → `[item]`, object → its properties, allOf → merged, oneOf/anyOf → the first. Recursion is guarded at depth 8.

- [ ] **Step 1: Failing tests:** `generates one file per operation in tag folders`, `path params become variables and pathParams`, `optional query disabled`, `body example from ref schema`, `folder auth from security scheme and secretVars`, `fallback operationId and untagged root`, `generated text parses with parseRequest without errors`, `rejects swagger 2`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** (`SwaggerParser.dereference`). **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: openapi request generation`.

### Task 9: Three-way merge and importer

**Files:** Create `src/core/openapi/merge.ts`, `src/core/openapi/importer.ts`; Tests `test/core/openapi-merge.test.ts`, `test/core/openapi-import.test.ts`, fixture `test/fixtures/petstore-v2.yaml` (one op removed, one added, one path changed, one new query param, one body field added, one body field removed)

**Interfaces:**
- Consumes: Task 8, `listTree`/ids (Task 3), `addVariables`/`addSecretNames`/`createEnvironment`/`listEnvironments` (Task 4), `applyEdits` (Task 2).
- Produces:
  ```ts
  // merge.ts
  export interface MergeResult { text: string; conflicts: string[] }   // conflict = human path, e.g. 'url', 'query.limit', 'body.json.name', 'auth'
  export function mergeRequest(base: string, current: string, next: string): MergeResult;
  // importer.ts
  export interface FileChange { relPath: string; operationId: string; before?: string; after: string; conflicts: string[]; specText: string }
  export interface ImportPlan { specName: string; source: string; target: string; added: FileChange[]; updated: FileChange[];
    conflicted: FileChange[]; removed: FileChange[]; unchanged: number; newVariables: Record<string, string>; secretVars: string[] }
  export function planImport(root: string, opts: { specName: string; source: string; target: string; baseDir: string }): Promise<ImportPlan>;
  export function planReimport(root: string, specName: string, baseDir: string): Promise<ImportPlan>; // reads .openapi/<spec>.yaml
  export function applyImport(root: string, workspaceDir: string, plan: ImportPlan, takeSpec: Set<string>): Promise<void>;
  export function listSpecs(root: string): Promise<{ name: string; source: string; target: string; importedAt: string }[]>;
  ```
  Merge rules (from the spec):
  - **Spec-owned fields:** `method`, `url`, the set of `query`/`headers` entries keyed by name, the set of `pathParams` keys, the JSON body's key paths, `auth.type`, and the body type key.
  - **Per scalar:** current == base takes next; next == base keeps current; both changed and different keeps current and records a conflict.
  - **Lists:** entries are keyed by name. Added in next and not in current → add. Removed in next: unchanged in current → remove, changed in current → keep and record a conflict. Entries only in current (user-added) are kept.
  - **JSON body:** parse all three. If the user's JSON is invalid, keep it and record conflict `body.json`. Otherwise merge objects recursively with the same per-key rule; arrays are treated as scalars. Write back as a block string.
  - **Never touched:** `name`, `settings`, comments, unknown keys.
  - Edits go through `applyEdits` on `current`.
  - Registry and snapshot: `.openapi/<spec>.yaml` holds `{source, target, importedAt}`. `.openapi/<spec>.snapshot.yaml` maps operationId to the generated text, and is the merge base.
  - **Matching:** scan all `*.req.yaml` under root for `source.spec === specName`, keyed by operationId. Files can move.
  - **Removed operations:** set `source.removed: true` (via `applyEdits`), and list them in `removed`.
  - **Added operations:** write under `target`, never overwriting. A clash gets `-2`.
  - **`applyImport`:** writes `after`, or `specText` for relPaths in `takeSpec`. It calls `addVariables` for `{[baseUrlVar]: baseUrl}` on every env (creating `local` if none exist) and `addSecretNames` for `secretVars`, then writes the registry and snapshot.

- [ ] **Step 1: Failing tests:**
  - merge: `untouched file takes spec changes`, `user value kept when spec unchanged`, `both changed keeps user and reports conflict`, `new query param added`, `removed param dropped if user unchanged`, `removed param kept with conflict if user changed`, `user-added header kept`, `json body key added and removed`, `invalid user json conflict`, `name settings and comments preserved`.
  - import: `first import writes files folder env registry snapshot`, `reimport v2 plan counts` (added 1, updated ≥2, removed 1), `moved file still matched`, `removed marked source.removed`, `takeSpec overwrites conflicted file`, `reimport of unchanged spec gives unchanged only`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: openapi re-import with three-way merge`.

### Task 10: Protocol, controller and extension host

**Files:** Create `src/core/protocol.ts`, `src/ext/controller.ts`, `src/ext/extension.ts`, `src/ext/editorProvider.ts`, `src/ext/tree.ts`, `src/ext/envStatus.ts`, `src/ext/secrets.ts`, `src/ext/commands.ts`, `src/ext/codelens.ts`, `resources/agent-guide.md`; modify `package.json` (contributes); Test `test/ext/controller.test.ts`

**Interfaces:**
- Produces (`protocol.ts`):
  ```ts
  export interface VariableInfo { name: string; kind: 'variable' | 'secret' | 'pathParam' | 'missing'; file?: string; value?: string /* never for secrets */ }
  export interface ResponseView { entryId: string; timestamp: number; ok: boolean; error?: string; status?: number; statusText?: string;
    timeMs?: number; sizeBytes?: number; headers?: [string, string][]; contentType?: string; bodyText?: string; bodyBase64?: string;
    truncated?: boolean; timeline: TimelineEntry[] }
  export type HostMessage =
    | { type: 'state'; request?: RequestDef; errors: Diagnostic[]; inherited: { auth: Auth; authFrom?: string; headers: KV[] };
        env: { name?: string; names: string[] }; variables: VariableInfo[]; requestIds: string[] }
    | { type: 'sending' } | { type: 'response'; response: ResponseView }
    | { type: 'history'; items: { entryId: string; timestamp: number; status?: number; ok: boolean }[] };
  export type WebviewMessage =
    | { type: 'ready' } | { type: 'edit'; ops: EditOp[] } | { type: 'send' } | { type: 'cancel' }
    | { type: 'openText' } | { type: 'selectEnv'; name: string } | { type: 'showHistory'; entryId: string } | { type: 'copyResponse' };
  ```
- Produces (`controller.ts`, vscode-free):
  ```ts
  export interface DocumentPort { getText(): string; applyText(newText: string): Promise<boolean>; file: string }
  export interface ControllerDeps { root: string; post(m: HostMessage): void; run(id: string, signal: AbortSignal): Promise<HistoryEntry>;
    getEnv(): Promise<{ name?: string; names: string[]; env: Environment }>; history: HistoryStore; openText(): void; selectEnv(name: string): void }
  export class EditorController { constructor(doc: DocumentPort, deps: ControllerDeps);
    handle(m: WebviewMessage): Promise<void>; refresh(): Promise<void> /* call on document change */ }
  ```
  `edit` applies `applyEdits(doc.getText(), ops)` to the **current** text and skips it if the text fails to parse. `refresh` posts `state` with `variables` built from `referencedVariables` over all string fields, plus `variableSource`, and never includes secret values. `send` posts `sending`, runs, then posts `response` and `history`. `toResponseView` drops `bodyBase64` when `bodyText` is present.
- Extension wiring:
  - **Custom editor** `yamlHttp.requestEditor` for `*.req.yaml` (priority `default`). The provider builds the webview HTML with a CSP (`default-src 'none'; style-src ${cspSource}; script-src 'nonce-…'; img-src ${cspSource} data:`), and loads `dist/webview.js` and `dist/webview.css`. `applyText` uses a full-range `WorkspaceEdit`.
  - **Tree view** `yamlHttp.requests` in the activity-bar container `yamlHttp`, using the `$(globe)` icon. Labels have a method prefix and description; removed files get a warning icon. Context menu: New Request, New Folder, Rename, Duplicate, Delete, Import OpenAPI…, Re-import (on folders that have a registry entry).
  - **Status bar** environment picker (`yamlHttp.selectEnvironment`), storing the choice in `workspaceState`, plus a "Create environment…" item.
  - **Commands:** `yamlHttp.send` (`ctrl+enter`/`cmd+enter` when the custom editor or a `*.req.yaml` text editor is focused), `yamlHttp.openAsText`, `yamlHttp.openInEditor`, `yamlHttp.importOpenApi` (pick file or enter URL, then spec name, then target folder), `yamlHttp.reimportOpenApi` (QuickPick over the plan with the summary `12 added, 5 updated, 1 removed, 2 conflicts`; each file can be opened with `vscode.diff` on before/after; conflicted files are a multi-select for "take spec version"; Apply/Cancel), `yamlHttp.clearCookies`, `yamlHttp.clearOAuthTokens`, `yamlHttp.addAgentInstructions` (writes `<root>/AGENTS.md` from `resources/agent-guide.md`, copies `schemas/` to `<root>/.schema/`, and optionally `.claude/skills/http-requests/SKILL.md` with frontmatter `name: http-requests`).
  - **CodeLens** "▶ Send" on line 0 of `*.req.yaml` text editors.
  - **`contributes.yamlValidation`:** `**/*.req.yaml` → request schema, `**/_folder.yaml` → folder, `**/env/*.yaml` → environment.
  - **Tokens and history:** `secrets.ts` adapts `context.secrets` to `TokenStore`, with keys tracked in `globalState` so `clear()` works. `HistoryStore` dir is `context.storageUri/history`.
  - `openBrowser` is `vscode.env.openExternal`.
  - **File watcher** on `<root>/**` refreshes the tree and open controllers.
  - **Root:** `yamlHttp.root` relative to the first workspace folder.
  - When the first environment is created, show an info message if the `.gitignore` was updated.
- `agent-guide.md`: one page. Covers the file layout, a request example, a folder auth example, environments and secrets (`.env`, never commit), chaining, auth shapes, body shapes, and how to validate against `.http/.schema/`.

- [ ] **Step 1: Failing tests** (`test/ext/controller.test.ts`, with a fake DocumentPort and deps):
  - `ready posts state with request and inherited auth`
  - `edit applies ops and doc text changes`
  - `edit applies to latest text` (change the doc text externally, then edit; both changes are present)
  - `controller does not edit invalid document` (`applyText` is never called; the state has errors)
  - `secret variables have no value`
  - `send posts sending then response and history`
  - `cancel aborts run signal`
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** the controller, then the vscode wiring.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit` and `npm run build`. Expected: all pass, and `dist/extension.js` exists.
- [ ] **Step 5: Commit** `feat: extension host, custom editor, tree, commands`.

### Task 11: Webview UI

**Files:** Create `src/webview/main.tsx`, `App.tsx`, `vscode.ts`, `components/UrlBar.tsx`, `RequestTabs.tsx`, `KeyValueTable.tsx`, `AuthEditor.tsx`, `BodyEditor.tsx`, `SettingsEditor.tsx`, `ResponsePane.tsx`, `JsonView.tsx`, `styles.css`; `test/webview/harness.html`, `test/webview/screenshot.mjs`

**Interfaces:**
- Consumes: `HostMessage`/`WebviewMessage`/`EditOp` (Task 10/2). The webview imports types only, plus `HTTP_METHODS`.
- Behaviour (from the mockup and spec):
  - **Top bar:** method `<select>`, URL input, Send button (Cancel while sending), environment `<select>`.
  - **Split screen:** left and right panes with a draggable divider; the ratio is kept in `vscode.setState`. Below 600 px width the panes stack vertically.
  - **Request tabs:** Params (query table plus a pathParams table that lists the `{{x}}` names found in the url path), Headers (the table, with inherited headers shown read-only and dimmed, tagged "from <folder>"), Auth (type select including Inherit, with a form per type; on Inherit it shows "Inherited from <authFrom>: <type>"), Body (type select with none/json/text/form/multipart/file; JSON and text in a monospace `<textarea>` with a Format button for JSON; form and multipart as tables), Settings (timeout, follow redirects, verify TLS).
  - **Tab counts:** like "Headers 2".
  - **Edit ops:** every field change sends an `edit` op, debounced 300 ms for text inputs. KeyValueTable has an enabled checkbox, name, value, delete, and an empty last row that creates an entry.
  - **Variables:** `{{var}}` tokens inside inputs get a tooltip showing the variable source (from `variables`); missing variables are underlined with `--vscode-editorError-foreground`.
  - **Response pane:** status badge (`--vscode-testing-iconPassed` for 2xx, `--vscode-editorWarning-foreground` for 3xx/4xx, `--vscode-editorError-foreground` for 5xx and errors), time and size. Tabs: Body (pretty JSON with syntax colours from `--vscode-debugTokenExpression-*` variables, a Raw toggle, an `<img>` for `image/*` via a base64 data URL, and a "Truncated" notice), Headers, Timeline. A history `<select>` lists the last 20. An error result shows the error text prominently.
  - **Parse errors:** the editor area shows a banner with the error and an "Open as text" button, and nothing is editable.
  - **Styling:** only `--vscode-*` variables (see Global Constraints). Font: `--vscode-font-family`; code: `--vscode-editor-font-family`.
- [ ] **Step 1: Write the harness.** `test/webview/harness.html` defines `acquireVsCodeApi` to record posted messages on `window.__posted` and to replay a fixture `state` + `response`. It includes a block of Dark+ `--vscode-*` values and a `?theme=light` variant. `screenshot.mjs` builds, opens the harness in Playwright Chromium (NODE_PATH set to the global modules), takes `dark.png`/`light.png` into `test/webview/out/`, clicks the method select and changes the URL, and asserts that `window.__posted` contains an `edit` op with path `['url']`.
- [ ] **Step 2: Run** `node test/webview/screenshot.mjs`. Expected: FAIL (no bundle or app).
- [ ] **Step 3: Implement the components.**
- [ ] **Step 4: Run** the screenshot script. Expected: the assertion passes. Inspect both PNGs: the theme is applied, it's split-screen, and nothing overflows.
- [ ] **Step 5: Commit** `feat: webview request/response UI`.

### Task 12: Package, docs and final verification

**Files:** Modify `README.md`; create `CHANGELOG.md`, `LICENSE` (MIT), `examples/.http/…` (a small sample against `https://httpbin.org`: GET with query, POST json, folder bearer auth, chained login using `response()`)

- [ ] **Step 1: README.** Cover features, the file format overview (linking `resources/agent-guide.md`), commands, settings, and the security notes (`.env`, masking).
- [ ] **Step 2: Run** `npm test`, `npx tsc --noEmit`, `npm run build` and `npm run package`. Expected: all pass, and the `yaml-http-0.1.0.vsix` file is produced.
- [ ] **Step 3: Check the vsix contents** with `npx vsce ls`. Expected: `dist/`, `schemas/`, `resources/`, README, and no `src/` or `test/`.
- [ ] **Step 4: Commit** `docs: readme, examples, packaging`.
