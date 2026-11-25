<img src=".github/readme/gtasks.gif" width="100%" alt="The smoke test walking the same handshake Claude does against the server: discovery, registration, the password page, the token exchange and the list of 13 tools, every check ok">

# gtasks-mcp

I keep my whole to do list in Google Tasks and wanted to add to it by just messaging Claude, so I built the connector.

<img src=".github/readme/gtasks.svg" width="100%" alt="Claude calls create_task, one Cloudflare Worker with no database passes it on, and the task shows up in Google Tasks">

## Run it

```
npm install
npm run setup
```

You need a Google OAuth client and a Cloudflare account first, [docs/SETUP.md](docs/SETUP.md) has the clicks. Setup prints an address when it finishes. Add it in Claude under Settings, Connectors, Add custom connector.
