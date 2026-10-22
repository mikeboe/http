# YAML HTTP Client for VS Code — Design

Date: 2026-10-22
Status: draft, awaiting approval
Mockup: `mockups/layout.html` (published: https://0a8bec90-94f6-4c68-aa28-faf8a72236db.agents.mikeboe.com)

## Intent

A thin, simple HTTP client for day-to-day development and API testing, living
inside VS Code. It's modelled on Yaak (https://github.com/mountain-loop/yaak): a
split-screen request/response editor. Every request is a plain YAML file in the
repo. Because requests are text files, coding agents can create and edit them
directly. There is no CLI. Agents only need to know the file format.

Why: Yaak-style ergonomics without a separate desktop app, and requests that are
versioned with the code and writable by agents.

## Goals

- Send HTTP requests from a Yaak-like UI: method + URL bar, request tabs
  (Params, Headers, Auth, Body, Settings) on the left, response (status, time,
  size, Body, Headers, Timeline) on the right.
- One request = one YAML file; folders = collections. The YAML file is the only
  source of truth.
- Environments (local, staging, …) with variables; secrets in git-ignored `.env`
  files.
- Auth: none, basic, bearer, API key (header or query), OAuth 2 client
  credentials, OAuth 2 authorization code (with PKCE; loopback redirect on a
  random port, or a fixed `redirectUri` for providers that require one). Folder-level auth that
  requests inherit.
- Request chaining: a field can use a value from another request's response.
- OpenAPI import (file or URL) that generates request files, and re-import that
  **updates** existing files while keeping user edits.
- Agent support: a JSON Schema for the request/folder/environment files and a
  short format guide (skill) an agent can read.

## Non-goals

- CLI, CI runner, or running requests outside VS Code.
- GraphQL, WebSockets, gRPC, SSE.
- Pre/post-request scripting and test assertions.
- Sync, accounts, cloud, team features beyond "it's files in git".
- Importing from Postman/Insomnia/Bruno/Yaak (possible later, not now).

## Anti-goals (would be failure even if it works)

- Secrets ending up in committed files, in the webview, or in logs.
- A UI that rewrites a YAML file the user or an agent edited by hand into
  something unrecognisable (reordered keys, dropped comments).
- Growing into a Postman clone. If a feature needs a scripting language, it's out.

## Constraints

- VS Code extension, TypeScript.
- Works on desktop VS Code (Node extension host). VS Code for the Web isn't
  supported, because requests are sent from Node.

## Approaches considered

- **A. Custom editor on the YAML files (chosen).** A `CustomTextEditorProvider`
  for `*.req.yaml` renders the split-screen webview UI. The text document is the
  model; UI edits become `WorkspaceEdit`s on the document, and text edits re-render
  the UI. HTTP runs in the extension host. Chosen because it gives the Yaak-like
  UI while keeping files first-class. Agent or git edits just show up, undo/redo
  and dirty state come from VS Code for free, and there's no CORS.
- **B. Single Yaak-style panel app.** One webview with its own sidebar and tabs
  that reads/writes files behind the scenes. Rejected: duplicates VS Code's
  explorer/tabs, needs its own sync for outside edits, feels less native.
- **C. CodeLens "Send" over raw YAML, response in a side editor** (REST Client
  style). Rejected as the end state: it's not the UI that was asked for. It's
  essentially a subset of A (A gets a "Send" CodeLens in the text view for free).

## Design

### Files on disk

All under a workspace folder `.http/`. The location can be changed with the
setting `yamlHttp.root`.

```
.http/
  env/
    local.yaml          # committed: non-secret variables
    local.env           # git-ignored: secrets (KEY=value)
    local.env.example   # committed: secret names, no values
    staging.yaml
    staging.env
  users/
    _folder.yaml        # optional: shared headers/auth for this folder
    create.req.yaml
    get-by-id.req.yaml
  auth/
    login.req.yaml
  .openapi/             # import bookkeeping (see OpenAPI), committed
```

- `.gitignore`: when the extension creates an environment, it adds `.http/env/*.env`
  (and `!*.env.example`) to the workspace `.gitignore` if it isn't already
  covered. It tells the user when it does this.
- Schemas are matched by filename pattern through the extension's `yamlValidation`
  contribution. No `$schema` comment is written into files *(my call: a bundled
  path is machine-specific and would churn in git)*. "Add agent instructions" also
  copies the schemas to `.http/.schema/`, so agents and editors without the
  extension can validate against a stable repo-relative path.
- v1 supports one `.http/` root in the first workspace folder. Multi-root
  workspaces are not supported *(my call)*.
- Where the mockup and this doc disagree (`./api`, `create.yaml`, map-style
  headers, `{{secret.x}}`), this doc wins.

### Request file (`*.req.yaml`)

```yaml
name: Create user
method: POST
url: "{{baseUrl}}/users/{{id}}/roles"
pathParams:               # request-local variables, resolved before env vars
  id: u_8f2k1
query:                    # list, so order and duplicates are preserved
  - { name: notify, value: "true" }
  - { name: debug, value: "1", enabled: false }
headers:
  - { name: Content-Type, value: application/json }
auth:                     # omitted = inherit from nearest _folder.yaml
  type: bearer
  token: "{{apiToken}}"
body:
  json: |                 # one of: json | text | form | multipart | file | none
    {
      "name": "Ada Lovelace",
      "email": "ada@example.com"
    }
settings:
  timeout: 10s
  followRedirects: true
  verifyTls: true
source:                   # only on imported requests
  spec: petstore
  operationId: createUser
```

Auth shapes:

```yaml
auth: { type: none }
auth: { type: basic, username: "{{user}}", password: "{{pass}}" }
auth: { type: bearer, token: "{{apiToken}}" }
auth: { type: apiKey, in: header, name: X-API-Key, value: "{{apiKey}}" }   # in: header | query
auth: { type: oauth2, grant: clientCredentials, tokenUrl: ..., clientId: ..., clientSecret: "{{clientSecret}}", scope: ... }
auth: { type: oauth2, grant: authorizationCode, authUrl: ..., tokenUrl: ..., clientId: ..., clientSecret: ..., scope: ..., pkce: true, redirectUri: http://127.0.0.1:8765/callback }  # redirectUri optional
auth: { type: inherit }   # explicit form of "omitted"
```

Body shapes: `json` (canonical form is a block string, sent verbatim, so the UI's text
area round-trips exactly, even while half-typed; a hand-written YAML mapping is also
accepted and serialised, and the first UI edit converts just that node to a block
string *(my call)*), `text` (`{ contentType, content }`), `form` (list of name/value
pairs), `multipart` (list of `{ name, value }` or `{ name, file: ./path }`),
`file` (`./path`, sent raw), `none`.

### Folder file (`_folder.yaml`)

May contain `headers`, `auth`, and `settings`. Requests inherit from the nearest
folder up the tree. Headers merge, and a request header with the same name wins.
`auth` and each `settings` key are overridden whole.

### Environments

- `env/<name>.yaml`: `variables:` map of non-secret values (for example `baseUrl`).
- `env/<name>.env`: dotenv secrets. They override the YAML ones if the same name
  appears in both.
- The active environment is chosen with a status-bar item and remembered per
  workspace. It is not stored in the repo.
- A missing variable gives a clear error naming the variable and the file it
  should go in. The request is not sent.

### Templating

- `{{name}}` is replaced, in any string field, with the first match from: the
  request's `pathParams`, then the active environment (`.env` over `.yaml`).
- Secrets are identified by where they come from, not by syntax: any value
  from a `.env` file is a secret *(my call)*.
- `{{response('auth/login', 'body.access_token')}}` is replaced with a value from
  another request's response. An optional third argument is a max age:
  `{{response('auth/login', 'body.access_token', '30m')}}`.
  - Path to the request: relative to `.http/`, without `.req.yaml`.
  - Value path: `body.<dot.path>` (with `[0]` for array indexes), `headers.<name>`,
    or `status`.
  - Behaviour: it uses the last saved response of that request **in the current
    environment**. If there's none, or it's older than the max age, it sends that
    request first, recursively, and caches the response. Loops are detected and
    reported as errors.
  - If a dependency gets a non-2xx response, a network error, or has no value at
    the path, the parent request is not sent. The error names the dependency and
    the reason. Failed responses go into history but are never used as the cached
    value for chaining *(my call)*. Requests that ran as dependencies appear in the Timeline.
- Nothing else: no expressions, no other functions. Literal `{{` is escaped as
  `\{{`.

### UI (custom editor)

Shown in the mockup. Specifics:

- Opening a `*.req.yaml` opens the custom editor by default. "Open as text" is
  one click from the editor title (and back again).
- Tree view "HTTP Requests" in its own activity-bar container. It mirrors
  `.http/`, with method badges and context-menu actions: new request, new folder,
  rename, delete, duplicate, import OpenAPI.
- Request pane tabs: Params (query + path params), Headers, Auth (form per auth
  type, with "Inherit" showing what is inherited from where), Body (type
  selector, plus a Monaco-like text area for JSON/text, or key/value tables),
  Settings.
- Response pane: status/time/size header; tabs Body (pretty JSON with
  syntax highlighting, raw toggle, images preview), Headers, Timeline (resolved
  URL, request headers sent with secrets masked, redirects, dependent requests).
- "Send" is also on `Ctrl/Cmd+Enter`, and a CodeLens appears in the text view.
- Variables in fields are highlighted. Hovering one shows which environment file
  it comes from, not its value if it's a secret.

### Editing model (UI ⇄ YAML)

- The text document is the model. The webview receives a parsed request object
  and sends back small edits ("set headers[1].value"). The extension host applies
  them through the `yaml` library's document API (`Document.setIn` etc.), which
  keeps comments, key order and formatting of untouched parts, and turns them
  into a `WorkspaceEdit`.
- If the YAML is invalid, the UI shows the parse error and an "Open as text" button.
  It never overwrites the file.
- Undo/redo, dirty state and saving come from VS Code's text document.

### Sending requests

- Done in the extension host with Node's built-in `fetch` (undici). The webview
  never sees resolved secrets. The Timeline masks values from `.env`, all
  credentials produced by auth (basic password, bearer/OAuth tokens, API keys) and
  the `Authorization`, `Cookie` and `Proxy-Authorization` request headers *(my call)*.
- Responses are shown and stored in history unmasked, because seeing what the API
  returned is the point. History lives in local workspace storage, never in the
  repo *(my call)*.
- Redirects are followed manually so each hop shows in the Timeline. The
  `followRedirects` and `timeout` settings are respected.
- Cookies: a per-environment cookie jar, in memory only for the lifetime of the
  VS Code window, with a "Clear cookies" command.
- Cancel button while a request is in flight.

### Response history

- The last 20 responses per request per environment are stored in the
  extension's workspace storage (`ExtensionContext.storageUri`), not in the repo.
  The response pane has a small dropdown to view older ones.
- Chaining reads from this same store.

### OAuth 2

- Client credentials: the token is fetched on demand, cached until it expires,
  and refetched automatically.
- Authorization code + PKCE: opens the system browser, receives the redirect
  on a loopback `http://127.0.0.1:<random port>/callback`, and exchanges the code.
  Refresh tokens are used when present.
- Cached tokens are stored in VS Code `SecretStorage`, per environment and per auth
  config. They're never written into files. A "Clear OAuth tokens" command removes them.

### OpenAPI import and re-import

- Input: OpenAPI 3.0/3.1 (JSON or YAML) from a file or URL. Swagger 2.0 is not
  supported.
- Each import is registered as a named spec in `.http/.openapi/<spec>.yaml`
  (`source: <path or url>`, `target: <folder>`, last import time). This is how
  re-import knows where to look.
- Generation: one folder per tag (untagged go in the spec folder root), one
  `*.req.yaml` per operation. Name and filename come from `summary`/`operationId`.
  - URL: `{{<spec>BaseUrl}}` + path (for example `{{petstoreBaseUrl}}/users/{{id}}`).
    The base URL variable is named after the spec, so several APIs can coexist
    *(my call)*. Its value comes from `servers[0]` and is added to each
    environment that doesn't have it yet (creating `local` if none exist). Path
    params go into `pathParams` with example values, or empty if there's none.
  - Query/header params: added with example or default values. Optional ones are
    added as `enabled: false`.
  - Body: an example built from the schema. Uses `example`/`examples` first,
    otherwise a generated skeleton. `$ref`s are resolved.
  - Auth: security schemes become a `_folder.yaml` auth at the spec folder,
    with secret values as `{{variables}}` added to `.env.example`.
  - `source: { spec, operationId }` is written into each file.
- Re-import (command or context menu on the spec folder):
  - Files are matched by `source.spec` + `source.operationId`, wherever they now
    live. Moved or renamed files are found.
  - **Updated from the spec:** method, path template, the set of parameters and
    headers (new ones added, removed ones dropped), body shape (new fields added,
    removed fields dropped), auth type.
  - **Kept:** values the user changed, extra headers or params the user added (not
    in the spec), `name`, filename and location, settings, comments.
  - New operations get new files. Operations removed from the spec are not
    deleted: the file gets `source.removed: true` and shows a warning badge in the
    tree.
  - **Conflicts: the user wins.** When the user and the spec both changed the same
    thing (URL path, a value, a body field, the body type, auth), the user's version
    is kept and the file is marked as a conflict in the preview, with a one-click
    "take spec version" for that file. Fields are identified across versions by
    `name` for list entries (query, headers, form) and by key path for JSON body
    fields. A body field the user changed that the spec removed is kept and flagged.
  - Before writing, it shows a summary ("12 added, 5 updated, 1 removed") with a
    per-file diff preview. The user confirms or cancels.
  - To tell "user changed this value" from "spec default", the last generated
    version of each file is kept in `.http/.openapi/<spec>.snapshot.yaml`, so
    re-import is a three-way merge: last generated + current file + new spec.

### Agent support

- JSON Schemas for request, folder, environment and spec-registry files, shipped
  in the extension. They're referenced through the `# yaml-language-server` comment
  and contributed via `yamlValidation`. Validation works with Red Hat's YAML
  extension. Without it, the custom editor still shows schema errors itself.
- Command "Add agent instructions": writes `.http/AGENTS.md` (format guide with
  examples: request, folder auth, env vars, chaining). It can also write a
  `.claude/skills/http-requests/SKILL.md` with the same content. Kept to about
  one page.

## Left to the builder

- Webview UI framework (suggestion: Preact or Svelte with
  `@vscode-elements/elements` for a native look), bundler (esbuild).
- YAML library (suggestion: `yaml` from eemeli, for comment-preserving edits),
  OpenAPI parsing (`@apidevtools/swagger-parser` or similar), dotenv parsing.
- Exact JSON-body editor in the webview (plain textarea with highlighting is fine
  for v1).
- Test strategy. Unit tests are expected for templating, chaining, folder
  inheritance, YAML edit round-trips and the OpenAPI merge.
- Extension name and publisher. The working name is "YAML HTTP" (`yamlHttp.*`).
- Build order. A suggested milestone order: files + send + response pane →
  environments/secrets → auth → chaining → OpenAPI import → re-import merge →
  agent schema/guide.
