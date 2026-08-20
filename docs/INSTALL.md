# Install and run

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Windows 10/11 | the terminal uses ConPTY | — |
| [.NET 10 SDK](https://dotnet.microsoft.com/download) | backend | `dotnet --version` |
| [Node.js 20+](https://nodejs.org) | frontend | `node -v` |
| Claude Code | the sessions this dashboard reads | `claude --version` |
| `gh` (optional) | PR tab | `gh auth status` |

## 2. Get the code and configure

```powershell
git clone <your-fork-url> claudedash
cd claudedash
.\setup.ps1
```

`setup.ps1` verifies the prerequisites above, creates `.env` from the example if it is missing,
restores NuGet and npm packages, and builds once. It is idempotent — re-run it any time a
checkout looks broken. `-SkipBuild` restores without compiling.

`.env` is only needed for the Jira tab — everything else works with it empty or absent. It is
gitignored; `.env.example` documents every key.

```ini
# Optional. Defaults to %USERPROFILE%\.claude
# CLAUDE_HOME=C:\Users\you\.claude

# Optional Jira integration
JIRA_DOMAIN=your-org.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
JIRA_STATUS_LADDER=To Do,In Progress,In Review,Done
```

Cloud instances (`*.atlassian.net`) authenticate with email + API token; self-hosted Server /
Data Center instances usually want a personal access token in `JIRA_API_TOKEN` and ignore the
email. If issues fail to load and the backend log shows an HTML response, the host is behind an
SSO gateway — connect the VPN it expects.

## 3. Run it

```powershell
.\start.ps1
```

| Service | URL | Notes |
|---|---|---|
| Dashboard | http://localhost:7342 | Vite dev server; proxies `/api`, `/hub`, `/ws` to the backend |
| Backend | http://localhost:7341 | .NET + Kestrel + SignalR |

Ctrl+C stops both. The dev servers compile on the fly, so `start.ps1` is all you need while
working; `build.ps1` is for a full type-check and production bundle:

```powershell
.uild.ps1                      # Debug backend + frontend bundle
.uild.ps1 -Release             # Release backend
.uild.ps1 -Clean -StopRunning  # wipe bin/obj/dist, and stop a running backend first
```

A running backend holds `ClaudeDash.Api.exe`, so a Debug build fails with MSB3027 unless you
pass `-StopRunning` — which also closes every terminal that backend is hosting.

Running the backend on its own is possible but **does not load `.env`**:

```powershell
cd backend\ClaudeDash.Api
dotnet run --urls http://localhost:7341
```

## 4. Start it automatically at login

`start.ps1` keeps a console window open, which you probably don't want at login. Use the
included launcher instead:

```powershell
.\install-startup.ps1
```

That creates a shortcut in your Startup folder pointing at `start-hidden.vbs`, which launches
`start.ps1` with no visible window. Options:

```powershell
.\install-startup.ps1 -Remove     # delete the shortcut
.\install-startup.ps1 -WhatIf     # show what it would do
```

To do it by hand instead: press <kbd>Win</kbd>+<kbd>R</kbd>, run `shell:startup`, and put a
shortcut to `start-hidden.vbs` in the folder that opens.

**Stopping the hidden instance:**

```powershell
Get-Process -Name ClaudeDash.Api | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object CommandLine -like '*vite*7342*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Note that stopping the backend also kills every terminal it is hosting.

## 5. Verify

Open http://localhost:7342. You should see your sessions listed within a second or two. If the
list is empty, check `GET http://localhost:7341/api/health`:

```json
{ "status": "ok", "claudeHome": "C:\\Users\\you\\.claude", "projectsExist": true }
```

`projectsExist: false` means `CLAUDE_HOME` is pointing at the wrong place.

## Troubleshooting

**`MSB3027: cannot copy ClaudeDash.Api.exe`** — an instance is already running and holding the
binary. `Get-Process -Name ClaudeDash.Api | Stop-Process -Force`, then build again.

**Port already in use** — something else holds 7341/7342:

```powershell
Get-NetTCPConnection -LocalPort 7341,7342 -State Listen |
  Select-Object LocalPort, OwningProcess
```

**Terminal opens but shows no TUI, or claude exits immediately** — check that `claude` is on
`PATH` for the account running the backend (`(Get-Command claude).Source`). You can also pin
the path in `backend/ClaudeDash.Api/appsettings.json` under `Terminal:ClaudeCli`.

**Terminals disappeared after a restart** — expected. PTYs survive browser reloads and closed
tabs, but not a backend restart: the pseudo-console handles die with the host process.

**The Jira tab says it failed to load** — see the credential notes in step 2. The backend log
prints the redirect target when an SSO gateway intercepts the API call.

**Empty diff in the Changes tab** — the diff is taken against the merge base with
`origin/master`, `origin/main`, `master`, `main`, or `HEAD~1`, whichever exists first. A repo
with no commits, or a session whose working directory isn't a repo, has nothing to show.
