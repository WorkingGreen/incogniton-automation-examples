# Using Incogniton with AI assistants (MCP)

Incogniton runs a hosted [Model Context Protocol](https://modelcontextprotocol.io) server. With it, an AI assistant (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, …) can search, create and edit profiles, proxies, groups and tags, and launch and stop profiles on your desktop app. Checked against the live server on 2026-10-08: 19 tools, server `incogniton-mcp` 1.0.0.

**What MCP does not do:** it does not browse. There are no tools to open pages, click or read content. For that, the assistant (or your script) attaches Playwright or Puppeteer to the `cdp_url` that a launch returns. That hand-off is shown in the runnable example [launch-with-mcp-and-attach-playwright](examples/launch-with-mcp-and-attach-playwright.md).

## 1. Get a token

In the Incogniton app: **My Account → Settings → MCP Token → Generate Token**. The token starts with `mcp_live_`.

Treat it like a password: anyone with it can create, change, delete and launch your profiles. Keep it in your MCP client's config or in this repo's `.env` (git-ignored), never in code or chat. If it leaks, regenerate it in the app; the old one stops working.

## 2. Connect your AI client

All clients use the published stdio bridge [`@incogniton/mcp`](https://www.npmjs.com/package/@incogniton/mcp) (Node.js 18+), which forwards to `https://v5api.incogniton.com/mcp`.

Claude Code (one command; replace the token):

```bash
claude mcp add incogniton --scope user --env INCOGNITON_MCP_TOKEN=mcp_live_YOUR_TOKEN -- npx -y @incogniton/mcp
```

Claude Desktop, Cursor, Windsurf (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "incogniton": {
      "command": "npx",
      "args": ["-y", "@incogniton/mcp"],
      "env": { "INCOGNITON_MCP_TOKEN": "mcp_live_YOUR_TOKEN" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "incogniton": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@incogniton/mcp"],
      "env": { "INCOGNITON_MCP_TOKEN": "mcp_live_YOUR_TOKEN" }
    }
  }
}
```

The Incogniton app also generates these snippets with your token filled in (Settings → Automation → MCP). Check that the bridge works:

```bash
npx -y @incogniton/mcp --health
```

## 3. The tools

| Area | Tools | Notes |
| --- | --- | --- |
| Profiles | `search_profiles`, `create_profiles`, `edit_profile`, `clone_profile` | `create_profiles` needs only `profile_names`; everything else (proxy, fingerprint, group, tags) is optional |
| Proxies | `search_proxies`, `create_proxies` | `create_proxies` needs `proxy_urls` and `proxy_schemes` |
| Organisation | `search_profile_groups`, `create_profile_groups`, `search_proxy_groups`, `create_proxy_groups`, `search_tags`, `create_tags`, `search_team_members` | |
| Helpers | `get_all_creation_info`, `get_profile_languages` | Lists groups/tags/proxies and language codes you can use when creating profiles |
| Launching | `get_eligible_sessions`, `launch_profile`, `get_launch_status`, `stop_profile` | See below |

Results are text written for the model, usually a sentence followed by a JSON block. Scripts should extract the JSON block (see `extractJson` in [lib/mcp-client.ts](../lib/mcp-client.ts)).

## 4. Launching, and handing the browser to Playwright

1. `launch_profile { profile_browser_ID }` creates a launch request, which your **desktop app** picks up within seconds (it must be running and logged in). The request expires after `timeout_seconds` (30–300, default 300).
   - If your account has **several logged-in desktop sessions**, the tool does not launch. It answers "Multiple active sessions found. Please specify target_session_id". Choose with `get_eligible_sessions`. Device names may show as "Unknown Device", and a launch sent to another session opens the profile **on that device**. This machine's session id is in the Incogniton app log: `authenticated successfully (session_id=...)`.
2. `get_launch_status { profile_browser_ID }` returns the requests for that profile as JSON. When yours is `LAUNCHED` and the browser still runs, the entry carries:
   - `cdp_url`, for example `http://127.0.0.1:55923`, a Chrome DevTools endpoint;
   - or `cdp_unavailable_reason` explaining why there is none (for example, the browser was closed).

   Asking by `request_id` instead returns prose without `cdp_url` (observed 2026-10-08), so filter by profile.
3. Attach: `chromium.connectOverCDP(cdp_url)` (Playwright) or `puppeteer.connect({ browserURL: cdp_url })`. Use the profile's default context (`browser.contexts()[0]`); see [lifecycle](lifecycle-and-persistence.md).
4. Stop:
   - **`stop_profile { profile_browser_ID }`** stops only profiles that were launched through MCP. It answers with a stop request id; poll `get_launch_status` (with `include_stop_requests`) until that stop request is `STOPPED`. Match on the stop request's own id: the server has been seen attaching a stop to an older launch of the same profile.
   - **Or close the browser over CDP** (`Browser.close`), which is what the example does by default. Current app versions terminate the browser on a stop, which can lose cookies/localStorage written in the last seconds; a normal close does not.

**Version note (2026-10-08):** `cdp_url` needs a desktop app version that reports the DevTools port for MCP launches. The release installed on the test machine launched and stopped profiles through MCP but returned only `cdp_unavailable_reason` ("… or the desktop runs an older app version"); the current development build returned `cdp_url` and the example passed end to end.

`cdp_url` is a loopback address **on the desktop machine**. It works only when the code that connects runs on the same machine as the Incogniton app (Claude Code or a script in a terminal there, not Claude Desktop on another computer). The port changes on every launch.

## 5. Example prompts

These work in any MCP client. The tools in brackets are what the assistant is expected to call.

- "Create 3 profiles called shop-1 to shop-3 in the group Shops, Windows, latest browser." [`search_profile_groups` → `create_profiles`]
- "Which profiles use the proxy at 203.0.113.10?" [`search_proxies` → `search_profiles`]
- "Clone the profile shop-1 twice." [`search_profiles` → `clone_profile`]
- "Launch shop-1 on this computer and give me its DevTools URL." [`search_profiles` → `launch_profile` → `get_launch_status`]
- "Stop shop-1." [`stop_profile` → `get_launch_status`]

For page work, a coding agent (for example Claude Code on the same machine) can take the `cdp_url` and run Playwright. That is exactly [the example](examples/launch-with-mcp-and-attach-playwright.md):

```bash
npm run example:mcp -- --session-id <this machine's session id>
```

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Tools don't appear in the client | Bridge not started or token missing | `npx -y @incogniton/mcp --health`; check `INCOGNITON_MCP_TOKEN` in the client config; restart the client |
| `401`/`403` from the endpoint | Token revoked or mistyped | Regenerate the token in the app |
| Launch stays `PENDING`, then `EXPIRED` | The target session's app is not running or not logged in, or it is another device | Start the app on that machine, or target this machine's session |
| `LAUNCHED` but no `cdp_url` | Browser already closed, or the app exposes no DevTools port for it | Read `cdp_unavailable_reason`; allow browser remote control in the app |
| Connection refused on `cdp_url` | The connecting code runs on a different machine, or the browser closed | Run the code on the desktop machine; check `get_launch_status` again |
| `stop_profile` says the profile was not launched via MCP | It was opened from the app or the local API | Close it in the app or with the local API (`npm run session -- stop` for sessions this repo started) |

Known server issues, observed 2026-10-08, are listed in [product-and-documentation-gaps.md](product-and-documentation-gaps.md#mcp).
