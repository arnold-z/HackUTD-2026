# Anchor

A macOS focus app for the NVIDIA Nemotron track. You set a goal; a Nemotron agent judges every window and browser tab you switch to. Go off-task and a full-screen overlay blocks the screen until you go back. Stay off-task for 10 seconds and the agent texts your phone over iMessage (Photon). At the end you get a debrief text with focus metrics. All state lives in SpacetimeDB.

## Setup on your Mac (about 10 minutes)

You need Node 22+ (`node -v`).

```bash
# 1. SpacetimeDB CLI (one time)
curl -sSf https://install.spacetimedb.com | sh
# open a new terminal so `spacetime` is on your PATH

# 2. Dependencies
cd anchor
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

`.env` already holds your keys. Set `ANCHOR_DRY_RUN_SMS=1` there to print texts in the terminal instead of sending them while you test.

### macOS permissions (do this before demoing)

The first session will trigger prompts. If window titles don't appear, or the "Back" button does nothing:

- **System Settings → Privacy & Security → Accessibility**: enable the terminal you launched from (Terminal, iTerm, or VS Code) and **Electron**.
- **System Settings → Privacy & Security → Automation**: allow it to control **System Events** and **Google Chrome** (or Safari).

- **System Settings → Privacy & Security → Screen Recording**: enable it too. The agent uses screenshots to see which note, document or chat is open in apps like Notes, Pages, Preview, Word, Notion, Obsidian, Mail, Messages, Slack and Discord, whose window titles don't say. Without it those apps are judged by title only.

Restart `npm start` after changing them. Chrome or Safari is needed for exact tab URLs and switching back to the right tab; other browsers fall back to the window title.

## Install as a real Mac app

`npm start` runs Anchor inside the generic "Electron" app. To get a proper **Anchor.app** with its own name and icon in the Dock, Cmd+Tab and Launchpad:

```bash
npm install            # once, picks up the packager
npm run package:mac    # builds release/Anchor-darwin-arm64/Anchor.app
cp -R release/Anchor-darwin-*/Anchor.app /Applications/
open /Applications/Anchor.app
```

**Keep permissions across rebuilds (one-time, 1 minute).** macOS ties permissions to the app's signature. Create a signing certificate once and every build is signed with it:

1. Open **Keychain Access** → menu **Keychain Access → Certificate Assistant → Create a Certificate…**
2. Name: `Anchor Dev`, Identity Type: **Self-Signed Root**, Certificate Type: **Code Signing** → Create.
3. Run `npm run package:mac`. It prints `Signed with "Anchor Dev"`. Reset permissions one last time (`tccutil reset All com.anchor.app`), grant them, and they now survive rebuilds.

The app reads its settings from the `.env` bundled at build time, so re-run `npm run package:mac` after editing `.env`. Because it's a new app to macOS, grant **Anchor** Accessibility and Automation permissions again (System Settings → Privacy & Security). Each rebuild gets a new signature, so you may need to toggle those permissions off and on after rebuilding. Logs: `~/Library/Logs/Anchor/main.log`.

## Resource folder suggestions (RAG)

On the start screen, **Choose folder…** to give Anchor notes, slides, PDFs, Word files, notebooks or code for this session. Anchor reads them (up to 150 files), splits them into passages and embeds them with **Nemotron 3.5 Embed 8B** (`EMBED_MODEL` in `.env`, default `nvidia/nemotron-3.5-embed-8b`). Vectors are cached in Anchor's app data, so unchanged files are never re-embedded.

When you stay on an on-task window for 5 seconds (`SUGGEST_DWELL_MS`), the agent:
1. Describes what you're looking at (page text for browsers, a screenshot description from Nemotron Omni for other apps).
2. Searches your folder with the embedding of that description.
3. Lets Nemotron pick the files that genuinely help (or none) and say why.
4. Shows a macOS notification. Click it to open the file. Suggestions also appear under **Helpful files**.

Each file is suggested at most once every 10 minutes. `npm run smoke` checks the embedding model id; if NVIDIA lists it under another id, set `EMBED_MODEL`.

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
spacetime sql anchor "SELECT * FROM activity_event"   # inspect data
spacetime logs anchor -f                                # module logs
npm run db:publish                                          # republish (wipes data)
npm run db:generate                                         # regenerate bindings after changing server/src/index.ts
```
