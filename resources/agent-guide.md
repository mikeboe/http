# HTTP requests in `.http/`

This folder holds HTTP requests as YAML files, used by the YAML HTTP VS Code extension.
Edit the files directly; the extension picks up changes.

## Layout

```
.http/
  env/local.yaml          # committed: non-secret variables
  env/local.env           # git-ignored: secrets, KEY=value. Never commit it.
  env/local.env.example   # committed: secret names only, no values
  users/_folder.yaml      # optional: headers/auth/settings shared by users/**
  users/get-by-id.req.yaml
  auth/login.req.yaml
  .openapi/               # OpenAPI import records; do not edit by hand
  .schema/                # JSON Schemas for validation
```

A request's id is its path relative to `.http/` without `.req.yaml` (e.g. `users/get-by-id`).

## Request (`*.req.yaml`)

```yaml
name: Get user            # shown in the tree; defaults to the file name
method: GET               # GET POST PUT PATCH DELETE HEAD OPTIONS (default GET)
url: "{{baseUrl}}/users/{{id}}"   # the only required key
pathParams:               # request-local variables, used before environment variables
  id: u_8f2k1
query:                    # lists keep order and allow duplicates
  - { name: verbose, value: "true" }
  - { name: debug, value: "1", enabled: false }
headers:
  - { name: Accept, value: application/json }
auth: { type: bearer, token: "{{apiToken}}" }   # omit to inherit from _folder.yaml
body: { none: true }
settings: { timeout: 10s, followRedirects: true, verifyTls: true }   # durations: 500ms 10s 30m 2h
```

Other keys are not allowed. `source: { spec, operationId }` marks imported requests; keep it.

## Body (exactly one key)

```yaml
body:
  json: |                 # sent verbatim; a block string is the canonical form
    { "name": "Ada" }
# text:      { contentType: text/csv, content: "a,b" }
# form:      [ { name: user, value: ada } ]
# multipart: [ { name: note, value: hi }, { name: avatar, file: ./avatar.png } ]
# file:      ./payload.bin          # paths are relative to the request file
# none:      true
```

## Auth

```yaml
auth: { type: none }
auth: { type: inherit }                                   # same as omitting it
auth: { type: basic, username: "{{user}}", password: "{{pass}}" }
auth: { type: bearer, token: "{{apiToken}}" }
auth: { type: apiKey, in: header, name: X-API-Key, value: "{{apiKey}}" }   # in: header | query
auth: { type: oauth2, grant: clientCredentials, tokenUrl: "https://id.example.com/token", clientId: my-app, clientSecret: "{{clientSecret}}", scope: read }
auth: { type: oauth2, grant: authorizationCode, authUrl: "https://id.example.com/authorize", tokenUrl: "https://id.example.com/token", clientId: my-app, pkce: true }
```

## Folder (`_folder.yaml`)

Requests inherit from every `_folder.yaml` from `.http/` down to their own folder.
Headers merge (a request header with the same name wins). The nearest `auth` and each `settings` key win whole.

```yaml
headers:
  - { name: Accept, value: application/json }
auth: { type: bearer, token: "{{apiToken}}" }
settings: { timeout: 30s }
```

## Environments and secrets

`env/<name>.yaml` holds non-secret values; `env/<name>.env` holds secrets and wins on a clash:

```yaml
# env/local.yaml
variables:
  baseUrl: http://localhost:3000
```

```
# env/local.env  (git-ignored: never commit, never print its values)
apiToken=abc123
```

When you add a secret, add its name with an empty value to `env/<name>.env.example`.

## Templates and chaining

- `{{name}}` in any string: `pathParams` first, then the active environment. A missing variable stops the send.
- `{{response('auth/login', 'body.access_token')}}` uses a value from another request's last
  successful response in the same environment, sending it first if there is none.
  An optional max age resends when older: `{{response('auth/login', 'body.access_token', '30m')}}`.
  Paths: `body.a.b[0].c`, `body`, `headers.<name>`, `status`.
- Write a literal `{{` as `\{{`. Nothing else is evaluated.

## Validate

Schemas are in `.http/.schema/`: `request.schema.json`, `folder.schema.json`,
`environment.schema.json`, `registry.schema.json`. For example:

```
check-jsonschema --schemafile .http/.schema/request.schema.json .http/users/get-by-id.req.yaml
```
