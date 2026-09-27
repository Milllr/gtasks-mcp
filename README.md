# gtasks-mcp

A remote MCP server that gives Claude read and write access to Google Tasks,
running on a single Cloudflare Worker. No database, no KV, no Durable Objects.

Built because Google Tasks has no official Claude connector, and driving the
web UI through browser automation is slow.

## What it costs

Nothing. Workers free tier covers 100,000 requests a day and 10ms of CPU per
invocation. This server does a handful of requests a day, and the CPU limit
counts compute only, not time spent waiting on Google. The Google Tasks API is
free. Nothing here touches a paid tier.

## How it is put together

| Piece | File | Notes |
| --- | --- | --- |
| Router | `src/index.ts` | Discovery, OAuth and `/mcp` on one Worker |
| OAuth server | `src/oauth.ts` | RFC 8414, RFC 9728, RFC 7591, PKCE S256 |
| Signed blobs | `src/crypto.ts` | HMAC-SHA256, so no storage is needed |
| Google client | `src/google.ts` | Refresh token grant, access token cached in isolate memory |
| Tools | `src/tools.ts` | The eleven tools Claude sees |
| JSON-RPC | `src/mcp.ts` | Streamable HTTP, stateless |

State is the interesting bit. Registered clients, authorization codes and
access tokens are all HMAC signed blobs that carry their own contents, so the
Worker remembers nothing between requests. Rotating `SIGNING_SECRET` revokes
every credential at once.

## Setup

### 1. Google Cloud console

1. Create a project at <https://console.cloud.google.com/>.
2. Enable the **Google Tasks API** under APIs and Services, Library.
3. Under APIs and Services, OAuth consent screen: choose **External**, fill in
   the app name and your email.
4. Add the scope `https://www.googleapis.com/auth/tasks`.
5. **Publish the app.** Leave it in Testing and Google expires your refresh
   token after seven days, which means reauthorizing every week forever. Once
   published it stays valid. It will remain unverified and show a warning
   screen the first time, which is fine for a personal app.
6. Under Credentials, create an **OAuth client ID** of type **Web application**
   and add this authorized redirect URI:

   ```
   http://localhost:8787/callback
   ```

7. Copy the client ID and client secret.

### 2. Get a refresh token

```powershell
cd C:\code\gtasks-mcp
npm install
node scripts/get-refresh-token.mjs
```

It opens your browser, you approve, and it prints a refresh token. Nothing is
sent anywhere except to Google.

### 3. Store the secrets

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put MCP_PASSWORD     # you choose this, you type it when connecting
npx wrangler secret put SIGNING_SECRET   # any long random string
```

A decent signing secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 4. Deploy

```powershell
npx wrangler deploy
```

Visit the printed URL. It tells you whether every secret is set.

### 5. Connect Claude

In Claude, go to Settings, Connectors, Add custom connector, and paste:

```
https://gtasks-mcp.<your-subdomain>.workers.dev/mcp
```

Claude opens a page asking for a password. That is your `MCP_PASSWORD`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_task_lists` | Every list with its id |
| `list_tasks` | Tasks in one list |
| `search_tasks` | Search titles and notes across all lists |
| `create_task` | Add a task, with notes, due date, or a parent |
| `update_task` | Change title, notes, due date or status |
| `complete_task` | Tick one off |
| `delete_task` | Permanent |
| `move_task` | Between lists |
| `create_task_list` | New list |
| `rename_task_list` | Rename a list |
| `delete_task_list` | Permanent, takes its tasks with it |

Lists are matched by name, case and punctuation insensitively, so `shit 2 do`
finds the list without needing its id.

## Local development

```powershell
npx wrangler dev
```

Put the same secrets in a `.dev.vars` file, which is gitignored:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
MCP_PASSWORD=...
SIGNING_SECRET=...
```

## Verifying it works

`scripts/smoke-test.mjs` walks the exact handshake Claude performs: discovery,
dynamic registration, the PKCE authorize round trip, token exchange, the
refresh grant, and an authorized `tools/list`. It also checks that a wrong
password and a bad PKCE verifier are both rejected.

```powershell
node scripts/smoke-test.mjs https://gtasks-mcp.<your-subdomain>.workers.dev <your-password>
```

It never calls a tool, so it cannot touch your real tasks.

## Troubleshooting

**"Could not refresh the Google access token"** usually means the refresh token
expired, which happens if the consent screen is still in Testing. Publish it,
re-run the token script, update the secret.

**Claude cannot connect.** Open the Worker root URL. If it lists missing
secrets, that is your answer. Otherwise `npx wrangler tail` streams live logs.

**Rotating access.** Change `SIGNING_SECRET` and every existing Claude
connection is revoked. Reconnect with the password.
