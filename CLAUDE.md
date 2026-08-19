# ClaudeDash — agent notes

A local, sessions-only dashboard over every Claude Code session on this machine: an
in-browser PTY terminal per session, a multi-repo diff view, and optional Jira / PR context
tabs. **Single-user, localhost-only, no auth** — it reads `~/.claude` and spawns processes as
you, so don't expose it to a network.

Nothing here is tied to a particular company or project layout: paths, Jira host and workflow
statuses all come from `.env`. (The old Overview / Jira launcher / Services / Orchestrators /
Settings views were deliberately removed — don't reintroduce them.)

## Run

```powershell
cd D:\Projects\ArtificialAssistant
.\start.ps1
```

`start.ps1` loads `.env`, then runs `dotnet run` (backend) and `npm run dev` (Vite) side by side. Ctrl+C stops both.

| Service  | URL                       | Notes |
|----------|---------------------------|-------|
| Frontend | http://localhost:7342     | Vite dev server. Proxies `/api`, `/hub`, `/ws` to backend. |
| Backend  | http://localhost:7341     | .NET 10 + Kestrel + SignalR. |

If you need to restart the backend alone: `Get-Process -Name ClaudeDash.Api | Stop-Process -Force` then `dotnet run --urls http://localhost:7341` from `backend\ClaudeDash.Api`. Manual `dotnet run` does **not** load `.env` — use `start.ps1` (or replicate its env-var mapping) to get Jira creds.

`.env` keys: `CLAUDE_HOME`, `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Backend maps them to `ClaudeDash__ClaudeHome`, `Jira__Domain`, etc.

## Layout

```
backend/ClaudeDash.Api/        .NET 10 Minimal API
  Models/Models.cs             All records (SessionSummary, MultiChangesResult, …)
  Services/
    ClaudeDataService.cs       Reads ~/.claude/{projects,sessions} JSONL; GetTouchedFilePaths
    TerminalService.cs         WebSocket ↔ ConPTY bridge
    ConPty.cs                  Win32 P/Invoke pseudo-console wrapper
    JiraService.cs             Atlassian Cloud + Server/DC auth (powers the session Jira tab)
    GitService.cs              Diffs + multi-repo discovery (GetMultiChangesAsync)
    GitHubService.cs           `gh pr view` for the PR tab
    PtySessionManager.cs       Backend-owned PTY registry (terminals outlive the browser)
    FolderPickerService.cs     Native folder dialog for "new session" (Windows)
    FileWatcherService.cs      FileSystemWatcher → SignalR /hub
  Hubs/DashboardHub.cs         SignalR hub (single "change" event)
  Program.cs                   Endpoint mapping
frontend/                      Vite + React 19 + TanStack Query + Tailwind
  src/App.tsx                  Slim header (no nav) + session list/detail layout
  src/components/
    SessionList.tsx            Flat session list: pinned / open-terminals / history
    SessionDetail.tsx          Header + Transcript/Changes/Terminal/Jira/PR tabs
    Transcript.tsx             Renders text/thinking/tool_use/tool_result blocks
    TerminalPane.tsx           xterm.js + WebSocket (theme-aware)
    ChangesView.tsx            Multi-repo diff view (repo sections → file blocks)
    JiraDetailView.tsx         Jira issue cards for the session's detected keys
    CommandSnippet.tsx         Copy-paste cmd lines (bash/pwsh/cmd)
    NewSessionModal.tsx        "+ New session" dialog
    Markdown.tsx               react-markdown wrapper for transcript prose
    ActiveWorkBar.tsx          Header strip of "active work" cubes (click = open, x = done)
    ScratchTerminal.tsx        Floating always-on scratch-pad terminal (popup, resizable)
    Chip.tsx                   Pastel tag pill
  src/lib/theme.ts             Theme store: system|light|dark, tracks OS setting
  src/terminalStore.ts         Module-level Map of live PTY WebSockets + buffers
  src/lib/sessionNames.ts      Custom session names (localStorage)
  src/lib/activeWork.ts        Active-work cube strip: ordered ids + dismissed set (localStorage)
  src/lib/recentPaths.ts       Last 10 session directories (localStorage)
  src/lib/commands.ts          Command pub/sub (keyboard → whoever owns the state)
  src/lib/shortcuts.ts         Shortcut table + Alt-held "hint mode" store
  src/components/Kbd.tsx       Recessive key badge
  src/components/Segmented.tsx Segmented control with a sliding indicator
  src/components/ShortcutsOverlay.tsx  The `?` map
  src/hooks/                   useChangeFeed (SignalR), useChime, useSessionName, useHotkeys
.mcp.json                      Project-scoped MCP servers
start.ps1                      Dev launcher
```

## Theming (glass tiles)

The UI is a set of translucent, blurred tiles over a tinted backdrop — the JetBrains
"new UI" family of ideas, tightened up: depth from elevation and spacing rather than an
outline around every box, one accent, one type scale.

**The rules that keep it from turning into soup** (stated at the top of `src/index.css`):

- Inner content sits on a *tint* (`surface-3` / `.card`), not inside a bordered box. Only
  outer panels (`.tile`) get a border, and it is a hairline plus a 1px specular top edge.
- One accent (violet). It marks selection and the single primary action per view. Nothing
  else is accent-coloured.
- Status colour is semantic only: amber = working, rose = needs you, emerald = done.
- **Two gradients in the whole app**: the page backdrop, and the primary/selected element
  (`--grad-accent`, used by `.btn-accent` and the selected session row). Adding a third is
  how this starts looking tacky.

**Tokens, not palettes.** `src/index.css` defines every colour as a CSS variable on `:root`
(light) and `.dark`; `tailwind.config.js` maps them to semantic classes: `app`, `surface` /
`surface-2` / `surface-3` / `surface-solid`, `hairline` / `hairline-strong`, `edge`, `fg` /
`fg-muted` / `fg-dim`, `accent` / `accent-fg` / `accent-soft` / `accent-ring`. Use these —
never `zinc-*` with a `dark:` twin. There are no `dark:` variants left in the components.

**Type scale** is overridden in `tailwind.config.js` and deliberately short: `text-2xs` 10px
(meta, micro-caps), `text-xs` 11px, `text-sm` 12.5px, `text-base` 13.5px (body), `text-lg`
15px (panel titles). Numbers use `tabular-nums`; `.label` is the only place letter-spacing
appears.

**Component classes** (`index.css`, `@layer components`): `.tile` (blurred panel, 16px
radius), `.tile-flat` (same look, no blur — for long scrollers, where blur costs frames),
`.card` (inner tint), `.seam` / `.seam-t` (dividers), `.label`, `.pill` / `.pill-on`,
`.btn-accent` (the gradient primary), `.segment` + `.segment-item[data-on]` (tab bar),
`.field` (inputs with an accent focus ring), `.row-action` (list-row buttons: 55% opacity at
rest, so they are always visible — never hover-only).

**Motion** is tokenised too: `--ease` (a fast-out curve), `--t-hover: 150ms`, `--t-press:
90ms`. Hover may ease; a press must feel instant — anything over ~110ms on click reads as
lag rather than feedback. Utilities: `.press` (scale 0.96 on `:active`, for any button),
`.row-press` (session rows: 1px nudge toward the pointer on hover), `.cube` (active-work
cubes: 1px lift). Everything is disabled under `@media (prefers-reduced-motion: reduce)`.
No entrance/exit animations — content appearing is not an event worth animating.

**Where motion is used** (and nowhere else): `Segmented` measures its active item and slides
a single indicator element between segments (240ms) instead of blinking a background from one
to the next — measured rather than CSS-only because segment widths differ (`Jira ×2`,
`PR #481`). Switching session or tab replays `.pane-in` (200ms lift), the terminal tab
excluded so remounting never throws away the xterm buffer. Active-work cubes `.pop-in` when
they appear, dialogs and the scratch window use `.dialog-in` + `.backdrop-in`, the session
row's state rail grows from 35% to full height on selection, and the peek overlay slides out
of the rail. Everything above is off under `prefers-reduced-motion`.

**Layout** is `gap-2 p-2` around tiles**Layout** is `gap-2 p-2` around tiles so the backdrop shows through the seams: header tile
on top, session-list tile and detail tile side by side.

The session-list header band and the detail pane's header + tab bar are tuned to the same
height so their seams land on the same pixel row (177px at the current spacing). The detail
pane's session identity — live/pid, branch, jira keys, session id — is right-aligned for
that reason; if you add a row to either header, re-check both seams line up.

Tailwind still runs in `darkMode: "class"` and `index.html` keeps the pre-paint script;
`src/lib/theme.ts` is unchanged (system | light | dark). xterm can't be themed by CSS, so
`TerminalPane` holds two `ITheme` objects matched to the tokens and swaps
`term.options.theme` via `subscribeTheme`.

**Editing the Tailwind config requires restarting Vite** — the running dev server keeps a
cached config, so new token or scale utilities silently compile to nothing until it is. Kill
just the Vite process (the node running `vite/bin/vite.js --port 7342`) rather than
`start.ps1`, or restarting the backend will take every PTY down with it.

## Data sources (read-only, on host)

All under `~/.claude/`:

- `projects/<encoded-cwd>/<sessionId>.jsonl` — per-session transcript. Workspace id = the cwd with every non-alphanumeric character replaced by a dash (`C:\dev\my-app` → `C--dev-my-app`), which is what `ClaudeDataService.EncodeWorkspaceId` reproduces.
- `sessions/<pid>.json` — currently-live claude processes. `IsLive` is computed by matching sessionId against the pid files.

## Session status detection

Backend derives status by walking the JSONL (in `ClaudeDataService.SummarizeSession`):

| status | condition |
|---|---|
| `awaiting_input` | last `tool_use` is `AskUserQuestion` with no matching `tool_result` yet |
| `done` | last assistant has `stop_reason: "end_turn"` and no pending tool; **or** session is not live (any non-live session is `done`) |
| `working` | live AND mid tool loop |

Chime in `App.tsx` fires only on transitions: `working → done` or `* → awaiting_input` for the **selected** session. First observation is silent. One sound for both (Web Audio synth).

## Changes tab (multi-repo aware)

`GET /changes` returns `MultiChangesResult` — a list of repos with per-repo `ChangesResult`:

- If the session cwd is itself a git repo → single entry, `discoveredVia: "cwd"`.
- If cwd is a parent directory holding several repos → repos are discovered from the file paths the session actually edited (`ClaudeDataService.GetTouchedFilePaths` scans the JSONL for Edit/Write/MultiEdit/NotebookEdit tool_use inputs, `GitService.FindRepoRoot` walks up to each repo root), `discoveredVia: "touched-files"`. Worktree repos outside cwd are included and get their leaf name.
- If no touched files parse out → falls back to scanning cwd's direct children for repos, `discoveredVia: "scan"`.

Diff base per repo: merge-base of HEAD vs origin/master → origin/main → master → main → HEAD~1. `GET /changes/file` takes a `repo` query param (repo root path) so the frontend fetches file diffs against the right repo.

## Active work strip

The header carries a row of small cubes — one per session the user is actively working on
(`ActiveWorkBar.tsx`, state in `src/lib/activeWork.ts`, localStorage key
`claudedash:active-work`). A session joins the strip automatically when it is live or when
the user opens it; it leaves only when the user clicks the cube's ×. Closing records the id
in a `dismissed` list so the auto-add rule doesn't immediately re-add it — `forceTrackSession`
clears that dismissal if a session needs to come back. The cube's dot mirrors the backend
session status (amber = working, rose = awaiting input, emerald = done).

`SessionList` mirrors that state: tracked sessions float to the top of their group (in cube
order — `Array.sort` is stable so the rest keep recency order) and render at full opacity,
while untracked rows grey out at 40% (hover restores them). Greying is driven by active-work
membership, not age; the only thing age still does is hide >10-day-old sessions behind "Show
older", and a tracked session is exempt from that too.

## Scratch pad terminal

`ScratchTerminal.tsx` is a floating popup terminal (toggled by the "🗨️ scratch" header
button) that always lands in the *same* conversation, so quick questions never create rows
in the session list:

- `GET /api/scratch` creates `%USERPROFILE%\claudedash-scratch` and returns
  `{ cwd, workspaceId }`. The workspace id comes from `ClaudeDataService.EncodeWorkspaceId`,
  which mirrors Claude Code's own folder naming (every non-alphanumeric character becomes a
  dash: `C:\Users\jane.doe` → `C--Users-jane-doe`).
- The PTY runs with `mode=continue`, i.e. `claude --continue` in that cwd. If the workspace
  has no transcript yet, `TerminalService` downgrades the mode to `new` — `--continue` fails
  on an empty history.
- `App.tsx` filters the scratch workspace out of `visibleSessions` (matched on both the
  encoded workspace id *and* the raw cwd), so the session list, counters, auto-select and the
  active-work strip never see it.
- Closing the popup only unmounts the xterm; the WebSocket lives in `terminalStore`, so the
  conversation keeps running in the background.

## Terminal lifetime (backend-owned)

A PTY belongs to the backend, not to the browser socket looking at it. `PtySessionManager`
keys running sessions by the *same* string the frontend uses (`workspaceId|sessionId|mode`)
and each `PtySession` runs one pump task that drains the pseudo-console into a 512 KB replay
buffer and fans bytes out to every attached viewer — so output keeps flowing and keeps being
recorded while nothing is attached at all.

- Closing the tab, reloading, or dropping the socket **detaches a viewer**. The claude
  process keeps running.
- `GET /api/terminals` lists what's alive; `terminalStore.restoreFromServer()` runs once per
  page load and re-opens a socket for each entry, so the "Open terminals" group and the
  scratch pad come back by themselves.
- The WebSocket carries a `key=` query param — that's how a reattach finds the existing PTY
  instead of spawning a second one. `renameTerminal` mirrors the client-side launch-key
  promotion to the backend via `POST /api/terminals/rename`, keeping both sides in agreement.
- A session ends only when its process exits, when the user kills it (`destroyTerminal` →
  `DELETE /api/terminals`), or when the backend restarts. **Restarting the backend still
  kills every PTY** — the pseudo-console handles die with the host process.
- The UI side of reattach: `isRestoring()` is true until the first `/api/terminals` fetch
  settles, and `SessionDetail` shows a "Reconnecting to running terminals…" placeholder
  instead of the launch button during that window. When a terminal appears for the selected
  session it auto-switches to the Terminal tab, unless the user has picked a tab themselves
  (`tabPinnedByUser`).
- `TerminalPane` calls `term.focus()` after the initial fit and refocuses on mousedown
  anywhere in the pane, so selecting a session lets you type immediately. Pass
  `autoFocus={false}` to opt out.
- Attaching replays the raw buffer. For a TUI like claude that means the redraw can look
  slightly stale until the next repaint; resizing the window forces a clean one.

## Terminal (the hard-won bit)

We use a custom ConPTY wrapper (`Services/ConPty.cs`) — `Pty.Net` 0.1.14-pre crashes on .NET 10 and its WinPTY fallback can't fool Node's `isTTY` check.

**Critical** for `claude.exe` to render its TUI instead of dropping into `--print` mode:

1. `STARTF_USESTDHANDLES` flag in `STARTUPINFO.dwFlags`
2. `hStdInput/hStdOutput/hStdError` set to **NULL**
3. `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE_HANDLE` attribute pointing at the HPCON
4. `EXTENDED_STARTUPINFO_PRESENT` in `dwCreationFlags`
5. `bInheritHandles = FALSE`

Why: per [GetStdHandle docs](https://learn.microsoft.com/windows/console/getstdhandle#remarks), the OS replaces std handles with the pseudo-console's only if they're NULL when the child attaches. Without USESTDHANDLES the child inherits the parent's pipe handles via the implicit console-subsystem inheritance mechanism, and the pseudo-console attribute is silently ignored. Confirmed by struct dumps — every other thing was right.

**Why a terminal used to come up mangled** (needing a zoom or window resize to fix): a
full-screen TUI only redraws when the console reports a size change. On a fresh attach the
child has already drawn its frame for whatever size the PTY had before — the 140x36 spawn
default, or a previous viewer's size — and the replayed buffer *is* that stale frame. On top
of that, xterm derives its cell size from the font, so measuring before the font is loaded
gives wrong metrics.

`TerminalPane` now handles both automatically:

- After the initial fit it **nudges**: sends `rows - 1`, then the real size 70ms later, and
  calls `term.refresh()`. That is the same signal the user was generating by hand.
- It re-runs fit + nudge once `document.fonts.ready` resolves (only if fonts weren't already
  loaded), when the pane transitions from unsized to sized (tab switch, popup opening, window
  restore — tracked in the `ResizeObserver`), and on `visibilitychange` back to visible.

Don't remove the nudge; a plain `fit()` is not enough to make the child repaint.

**xterm.js side**: set `windowsPty:**xterm.js side**: set `windowsPty: { backend: "conpty", buildNumber: 26200 }` in the Terminal options — without it, scrolling inside the alt-screen buffer ghosts/duplicates lines. ([xterm.js #3513](https://github.com/xtermjs/xterm.js/issues/3513))

The TerminalPane uses a module-level `terminalStore` so WebSockets survive React unmounts when switching sessions. Each entry caches up to 256 KB of replay output so reconnecting shows scrollback.

**Restarting the backend kills every attached PTY** — check `Get-CimInstance Win32_Process | Where ParentProcessId -eq <backend pid>` for live claude children first.

## Jira (optional)

One per-session tab (`/api/jira/issue/{key}` + a transition endpoint). Everything is driven
by `.env`; with `JIRA_DOMAIN` unset the tab simply never appears.

Both Atlassian flavours are supported, and they differ in ways that matter:

| | Cloud (`*.atlassian.net`) | Server / Data Center |
|---|---|---|
| REST base | `/rest/api/3/…`, falls back to v2 | `/rest/api/2/…` only (v3 doesn't exist) |
| Auth | Basic — email + API token | Bearer personal access token |

`JiraService` picks the order to try from the domain (Basic-first for Cloud, Bearer-first
otherwise) and falls back to the other, so a mis-set `JIRA_EMAIL` isn't fatal.

`JIRA_STATUS_LADDER` lists your workflow's statuses in order; the Jira tab turns that into
the back/forward transition buttons and the jump-to menu. Default: `To Do, In Progress,
In Review, Done`.

**If issues fail to load with an HTML response**, the host is probably behind an SSO gateway
(Cognito, Okta, an internal proxy) that redirects unauthenticated API calls to a login page.
The backend log prints the redirect target when that happens. Self-hosted instances often
also require the corporate VPN to be connected.

## Session list modes

Two layouts, remembered in localStorage (`claudedash:session-list-mode`):

- **panel** (default) — the resizable column. Drag its right edge to size it (below 340px
  rows switch to a compact form); the grip's chevron collapses it to the rail.
- **rail** — collapses to a 48px strip of numbered stops (status dot top-right, a sky dot
  bottom-right when a terminal is attached). Clicking a stop selects that session, and
  hovering anywhere on the rail slides the full list out *over* the detail pane, so a laptop
  screen gets the space back without giving up one-click switching. The same chevron grip
  appears on the rail and on the peek overlay's right edge to expand back, so the toggle is
  always in the same place.

It slides out of the rail — 190ms in, 130ms out (`.peek-in` / `.peek-out` in `index.css`).
The exit is why the overlay has both a `peeking` (mounted) and a `leaving` (animating out)
state; `prefers-reduced-motion` flattens both.

The peek overlay closes by checking **what the pointer is over** (`host.contains(target)` on
mousemove), not by `mouseleave`: it is an absolutely positioned child extending far outside
its 48px parent, boundary events there are unreliable, and an overlay stuck over the detail
pane is the worst thing this feature could do. Containment also covers the overlay's own edge
grip, which sits outside the overlay box. Escape closes it too.

## Transcript rendering

Prose is full width (this is a tool pane, not an article); code blocks and tables scroll
inside themselves so they never stretch the layout. Order is newest-turn-first by default,
flipped with the button in the toolbar (`claudedash:transcript-order`).

`Transcript.tsx` has two modes, remembered in localStorage (`claudedash:transcript-mode`):
**Messages** (default) drops turns that are pure tool traffic — reporting the count so
nothing looks silently lost — and shows prose plus a `+ N steps` button on mixed turns;
**Everything** renders every block. Thinking / tool / result blocks stay one-line
collapsibles (label + preview) so a run of them scans like a log.

Prose goes through `Markdown.tsx` (`react-markdown` + `remark-gfm`, styled by the `.md`
rules in `index.css`). Two things worth knowing:

- react-markdown **drops raw HTML** instead of rendering it, which is why there is no
  `dangerouslySetInnerHTML` anywhere. But transcripts are full of angle brackets that aren't
  HTML (`<task-notification>`, `List<string>`), and those would vanish — so `Markdown` escapes
  `<` to an entity everywhere *except* inside code spans and fences, where entities would
  print literally.
- Only paragraphs, lists and headings get a max measure (108ch). Code blocks, tables and
  quotes are exempt and scroll inside themselves, so a wide pane stays useful.

## Starting a session

`NewSessionModal` starts empty — no default path, because one machine's project folder is
wrong for every other machine. Three ways to fill it in:

- **Browse…** → `POST /api/pick-folder` → `FolderPickerService` opens the host's real folder
  dialog (PowerShell + WinForms `FolderBrowserDialog` on an `-STA` thread) and returns the
  absolute path. This exists because the browser *cannot* provide one: the File System Access
  API hands back a directory handle with no path, and `webkitdirectory` gives only relative
  paths. Windows-only; the endpoint returns `{ path: null }` elsewhere or on cancel.
- **Recent** capsules — the last 10 directories you actually started in
  (`src/lib/recentPaths.ts`, localStorage). Click fills the field, double-click starts.
- **Known workspaces** — from `/api/workspaces`, minus anything already in Recent.

Starting a second session in a directory that already has one is normal and is *not*
confirmed — several agents in one repo is the point of the tool.

## Keyboard shortcuts

Two tiers, both defined in one table (`src/lib/shortcuts.ts`):

- **Bare keys** — `j`/`k` (or ↓/↑) move through the list in *rendered* order, `1`–`5` pick a
  tab, `t` resumes/focuses the terminal, `p` pins, `x` hides, `/` focuses search, `n` new
  session, `s` scratch pad, `?` the shortcut list, `Esc` closes things. Ignored while typing —
  and xterm's helper element is a `<textarea>`, so typing in a PTY never fires one.
- **Alt + the same key** does the same thing and works *everywhere, including inside the
  terminal*. `useHotkeys` listens in the **capture phase** and `preventDefault`s, so xterm
  never sees the combo.
- **`Alt+B` hands the keyboard back** (blurs the focused element) so the bare keys work again.
  The terminal pane's header says which mode it is in — "keys go to the shell · Alt+B to
  leave" versus "click to type" — driven by focus/blur on xterm's helper textarea, since
  xterm exposes no focus events of its own.

The terminal only grabs focus when the user actually asked for it: `SessionDetail` tracks
whether the current tab was chosen by hand and passes that as `autoFocus`. Otherwise
`j`/`k` onto a session with a live terminal would silently swallow every following shortcut.

Nothing binds Ctrl or Cmd, and Alt+D/E/F/V plus Alt+arrows are deliberately unused (address
bar, Chrome menus, back/forward).

`src/lib/commands.ts` is a small pub/sub: `App` owns the key handling and dispatches a
command; whoever owns the relevant state subscribes (`SessionList` for row order and search,
`SessionDetail` for tabs — it also decides when a shortcut is a no-op, e.g. `4` with no Jira
key). That avoids lifting tab/search state or drilling props.

**Discoverability**: `<Kbd>` badges sit next to the controls at 50% opacity — legible if you
look, invisible if you don't. Holding **Alt** sets a module flag (`lib/shortcuts.ts` hint
store) that lights every badge accent-coloured at once, and `?` opens the full map.

## URL routing

Hash-based via `App.tsx`'s `parseHash` / `writeHash`. Only `#/sessions/<sessionId>` exists (anything else falls back to the newest session). Bookmarkable; `hashchange` listener handles back/forward.

## MCP servers (project-scoped `.mcp.json`)

| name | url / cmd | use |
|---|---|---|
| microsoft-learn | https://learn.microsoft.com/api/mcp | .NET docs |
| context7 | https://mcp.context7.com/mcp | JS/React/library docs |
| playwriter | `npx playwriter@latest` | Browser automation via the Playwriter Chrome extension. **Disconnects whenever the dashboard tab reloads** — user must click the extension icon to reconnect. |

## API surface

```
GET  /api/health
GET  /api/scratch                        ({ cwd, workspaceId } for the scratch-pad terminal)
POST /api/pick-folder?start=             (opens the host's native folder dialog; { path } or null)
GET  /api/terminals                      (PTY sessions alive on the backend)
POST /api/terminals/rename?from=&to=     (re-key a session; used when a launch key is promoted)
DELETE /api/terminals?key=               (explicit kill — the only way a PTY ends from the UI)
GET  /api/workspaces
GET  /api/sessions?limit=500
GET  /api/workspaces/{id}/sessions
GET  /api/workspaces/{id}/sessions/{sid}/transcript?limit=500
GET  /api/live
GET  /api/jira/issue/{key}
POST /api/jira/issue/{key}/transition
GET  /api/workspaces/{ws}/sessions/{sid}/changes          (MultiChangesResult)
GET  /api/workspaces/{ws}/sessions/{sid}/changes/file?path=&repo=
GET  /api/workspaces/{ws}/sessions/{sid}/pr
WS   /ws/terminal?workspaceId=&sessionId=&mode=resume|new|continue&shell=&cwd=&key=
WS   /hub                                (SignalR change feed; only event is "change")
```

## Don't write to settings.json

The bypass flags in `~/.claude/settings.json` (`skipDangerousModePermissionPrompt`, `skipAutoPermissionPrompt`) trigger Claude Code's auto-mode classifier to refuse edits to that file. Use `.mcp.json` (project-scoped) or `~/.claude/.mcp.json` for MCP additions. For permission/hook changes, use the `update-config` skill.

## Common pitfalls

- **Backend restarted from inside a Claude Code session used to poison spawned terminals** — inherited env broke them two ways: `CLAUDE_CODE_*`/`CLAUDECODE`/`CLAUDE_PID` markers disabled transcript saving ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"), and `NO_COLOR=1` (plus `GIT_TERMINAL_PROMPT=0`) from the tool shell made the claude TUI render monochrome. `Program.cs` strips all of these at startup and sets `COLORTERM=truecolor`; don't remove that block.
- **Restarting backend leaves the .exe locked.** If `dotnet build` errors with MSB3027, the running process still has the apphost. `Get-Process -Name ClaudeDash.Api | Stop-Process -Force` first.
- **`dotnet run` standalone won't have Jira creds.** Only `start.ps1` loads `.env`.
- **Don't put session id in URL paths.** Encode it (it's a UUID, safe, but be consistent with `encodeURIComponent`).
- **xterm.js scroll without `windowsPty` setting** → ghosting in claude TUI. Don't remove that option.
- **Spawning `claude` via Pty.Net** → claude exits with stdin warning. Don't reintroduce Pty.Net.
- **New UI must use the semantic tokens** (`surface`, `hairline`, `fg`, `accent` — see Theming) rather than `zinc-*` with `dark:` twins. Tokens are defined for both themes, so a component styled with them is correct in light and dark without a second set of classes.
- **Custom session names live in localStorage**, not in any Claude Code state. They're per-browser.
