# FocusGuard

A macOS focus app for the NVIDIA Nemotron track. You set a goal; a Nemotron agent judges every window and browser tab you switch to. Go off-task and a full-screen overlay blocks the screen until you go back. Stay off-task for 10 seconds and the agent texts your phone over iMessage (Photon). At the end you get a debrief text with focus metrics. All state lives in SpacetimeDB.

## Setup on your Mac (about 10 minutes)

You need Node 22+ (`node -v`).

```bash
# 1. SpacetimeDB CLI (one time)
curl -sSf https://install.spacetimedb.com | sh
# open a new terminal so `spacetime` is on your PATH

# 2. Dependencies
cd focusguard
npm install
(cd server && npm install)

# 3. Terminal A: run the database (leave it running)
spacetime start

# 4. Terminal B: publish the module
npm run db:publish

# 5. Check Nemotron, SpacetimeDB and Photon
npm run smoke              # add `-- --send` to text USER_PHONE a test message

# 6. Run the app
npm start
```

`.env` already holds your keys. Set `FOCUSGUARD_DRY_RUN_SMS=1` there to print texts in the terminal instead of sending them while you test.

### macOS permissions (do this before demoing)

The first session will trigger prompts. If window titles don't appear, or the "Back" button does nothing:

- **System Settings → Privacy & Security → Accessibility**: enable the terminal you launched from (Terminal, iTerm, or VS Code) and **Electron**.
- **System Settings → Privacy & Security → Automation**: allow it to control **System Events** and **Google Chrome** (or Safari).

Restart `npm start` after changing them. Chrome or Safari is needed for exact tab URLs and switching back to the right tab; other browsers fall back to the window title.

## Install as a real Mac app

`npm start` runs FocusGuard inside the generic "Electron" app. To get a proper **FocusGuard.app** with its own name and icon in the Dock, Cmd+Tab and Launchpad:

```bash
npm install            # once, picks up the packager
npm run package:mac    # builds release/FocusGuard-darwin-arm64/FocusGuard.app
cp -R release/FocusGuard-darwin-*/FocusGuard.app /Applications/
open /Applications/FocusGuard.app
```

The app reads its settings from the `.env` bundled at build time, so re-run `npm run package:mac` after editing `.env`. Because it's a new app to macOS, grant **FocusGuard** Accessibility and Automation permissions again (System Settings → Privacy & Security). Each rebuild gets a new signature, so you may need to toggle those permissions off and on after rebuilding. Logs: `~/Library/Logs/FocusGuard/main.log`.

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| Watcher | `src/main/mac.ts`, `main.ts` | Every second, reads the frontmost app, window title and browser URL with AppleScript; logs changes to SpacetimeDB |
| SpacetimeDB module | `server/src/index.ts` | Decides instantly from learned rules or earlier verdicts; otherwise queues a `judge` job. Off-task → creates an `intervention` and schedules `alert_check` 10 s later |
| Agent | `src/main/agent.ts` | Handles `agent_job` rows: **profile** (goal → rules), **judge** (tool loop), **alert** (writes + sends the text), **debrief** (metrics + summary) |
| Nemotron | `src/main/llm.ts` | `nemotron-3-nano-omni-30b-a3b-reasoning` via build.nvidia.com. Thinking off for fast calls, on for the debrief |
| Photon | `src/main/photon.ts` | `spectrum-ts` iMessage provider: `imessage(app).space.create(phone)` → `space.send(text)` |
| Overlay | `main.ts`, `renderer/overlay.html` | Full-screen window on every display and Space; takes focus back until the current window is on-task |

### The Judge's tools

`get_session_context`, `fetch_page_summary` (page title/description, YouTube titles via oEmbed), `lookup_rules`, `save_rule`, `record_verdict`. Every call is written to the `agent_trace` table and shown live in the app's **Agent trace** panel. If the endpoint returns no native tool calls, the agent accepts a JSON verdict instead. If Nemotron is unreachable, a small built-in list of distraction sites still blocks and everything else is allowed.

Strict mode: an off-task verdict under 60% confidence is downgraded to on-task, because a wrong block has no override.

## Demo script (about 3 minutes)

1. Start: "Finish CS 3345 A4: Dijkstra in Python", 30 min. The trace shows the profile call and the learned rules appear.
2. Open VS Code: on-task instantly (app rule).
3. Open a YouTube video titled "Dijkstra's algorithm in 3 minutes": on-task (keyword rule beats the site).
4. Open reddit.com: the trace shows `fetch_page_summary` → `save_rule reddit.com` → `record_verdict off_task`, and the overlay covers the screen. Try Cmd+Tab; it comes back.
5. Wait 10 seconds: your phone gets the iMessage. Click **Back to Code**; the overlay closes.
6. Open Reddit again: blocked instantly by the rule the agent learned.
7. End the session (type `i am done focusing`): the debrief arrives by iMessage and shows in the app.

## Escape hatch

Ending a session early always works: type `i am done focusing` in the End session box (main window, or the small link at the bottom of the overlay). Quitting with Cmd+Q is blocked while a session runs.

## Useful commands

```bash
spacetime sql focusguard "SELECT * FROM activity_event"   # inspect data
spacetime logs focusguard -f                                # module logs
npm run db:publish                                          # republish (wipes data)
npm run db:generate                                         # regenerate bindings after changing server/src/index.ts
```
