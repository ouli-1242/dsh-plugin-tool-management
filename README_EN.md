# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-3fb950)](https://awesome-dsh-plugin.com)
[![dshfind](https://dshfind.com/api/badge/ouli-1242/dsh-plugin-tool-management?lang=en)](https://dshfind.com/en/plugins/ouli-1242/dsh-plugin-tool-management)
[![0xsline](https://img.shields.io/badge/0xsline-listed-3fb950)](https://github.com/0xsline/awesome-deepseek-harness)

[简体中文](README.md) · **English** · [Changelog](CHANGELOG.md) · [Release overview](docs/update.md)

- An **MCP, skills, scenes, memories, subagents, prompts & archived sessions** manager for DeepSeek Harness.
- Eight tabs: **Scenes**, **MCP**, **Skills**, **Subagents**, **Prompts**, **Memories**, **Sessions**, **Host**.

```sh
dsh plugin --profile web add dsh-plugin-tool-management@latest
```

Hard-refresh the browser (Cmd/Ctrl+Shift-R) afterwards — a **Tools** panel in Settings means it worked. No hand-editing of `cordis.patch.yml`, no skill source files touched, configuration survives restarts and upgrades.

---

## Screenshots

|                                   |                                    |
|:---------------------------------:|:----------------------------------:|
| ![Scenes](docs/images/1-EN.png)   | ![MCP](docs/images/2-EN.png)       |
| **Scenes**                        | **MCP**                            |
| ![Skills](docs/images/3-EN.png)   | ![Subagents](docs/images/4-EN.png) |
| **Skills**                        | **Subagents**                      |
| ![Prompts](docs/images/5-EN.png)  | ![Memories](docs/images/6-EN.png)  |
| **Prompts**                       | **Memories**                       |
| ![Sessions](docs/images/7-EN.png) | ![Host](docs/images/8-EN.png)      |
| **Sessions**                      | **Host**                           |

## Highlights

In one line: **set up a scene for each kind of work — "day job / writing / coding" — and switch the whole stack with one click. Everything the plugin manages, the model can actually see.**

| Highlight                             | What it means                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-click scene switch                | Each scene carries its own set: which MCP servers, which skills, which personas, which memories; flip it on and the whole stack follows, turn it off and everything comes back                                                                                                                                          |
| Memories reach the model on their own | Write a few `.md` files under a scene and they become its knowledge base — injected automatically, no copy-pasting every session                                                                                                                                                                                        |
| Notes for MCP servers                 | Write "if A is down, fall back to B" as a note — the model sees it and acts on it                                                                                                                                                                                                                                       |
| Disable a single tool                 | Keep a server but mute one tool: invisible and uncallable; "Restart" only reconnects and never flips switches                                                                                                                                                                                                           |
| Skills at a glance                    | Which copy is in effect, which is shadowed by a same-name skill, which is preferred — all marked in the list                                                                                                                                                                                                            |
| Subagent = one file, one role         | Write a role file and delegate; only the result comes back and it never clutters your History; which roles are available can follow the scene                                                                                                                                                                           |
| Several prompt presets                | Keep multiple AGENTS.md baselines (terse mode, teaching tone, …), switch with one click; a scene can bind its own                                                                                                                                                                                                       |
| Sessions no longer lost               | Archive grouped by project, searchable, batch-restorable; import transcripts from Claude Code / Cursor / Codex                                                                                                                                                                                                          |
| The model always sees it              | Everything the plugin manages (memories / MCP / skills / subagents / prompts) is announced to the model — one message per domain, republished only on change; under Minimal nothing is injected by default (follows the preset), force any domain on in the Host tab                                                    |
| Lock it and relax                     | Lock a scene to make create/update/delete in all five domains read-only; unlock first to change anything (creating/renaming/binding/activating a scene, the recycle bin, restart, export and token settings are **not** in the frozen list — see Scene lock)                                                            |
| Deleted is not gone                   | Deletes of skills / memories / personas / presets / scenes land in a recycle bin and can be restored; they also zip out and back in. **Session history is the exception: permanent delete skips the recycle bin and cannot be undone**                                                                                  |
| Safe by default                       | Secrets masked, plaintext needs a token; only the plugin's own files are written, skill sources stay untouched, and your config survives restarts and upgrades. **Masking is display-only**: secrets stay in cleartext in `cordis.patch.yml` and in up to 5 backup copies per patch file (see Configuration & security) |

## Quick start

Prerequisites: DSH installed (`dsh web` runs), Node.js ≥ 18.

```sh
dsh plugin --profile web add dsh-plugin-tool-management@latest   # install / update
dsh plugin --profile web remove dsh-plugin-tool-management       # uninstall
```

Hard-refresh the browser — a **Tools** panel with eight tabs means it worked. Client changes hot-reload; host-side changes need `dsh web` restarted.

You can also ask the model:

```text
Install the dsh-plugin-tool-management plugin:
dsh plugin --profile web add dsh-plugin-tool-management@latest
Then remind me to hard-refresh the browser.
```

The model can manage everything above via 18 tools (`mcp_manager_*` / `skill_manager_*` / `prompt_manager_*` / `memory_manager_*` / `scene_manager_*` / `subagent_manager_*`); the five `*_save` tools are upserts (create, or update the one that already has that name); scripts use `POST /dsh-plugin-tool-management/api` (`{op, args}` protocol).

Those 18 tool definitions total roughly 3,440 tokens, and the tool table is **sent with every single request**. Switch off the ones you never use in the **"Model tool table"** block on the **Host tab** (one by one, or a whole domain at once) — a switched-off tool is not sent at all, which is the only thing that genuinely saves tokens. The model then cannot call it, but **the panel is unaffected** (the 118 ops and the tool table are independent). Nothing is switched off by default.

One tool also **yields automatically**: when the official `skill` tool is mounted in that conversation (every standard-class preset mounts it), our `skill_manager_read` ("load a skill body by name") is not sent — the two do the same job. The minimal preset has no official one, so ours stays.

---

## Features

### Scenes & memories

- **A scene = a group, a memory = a `.md` file**. `memories/<scene>/<name>.md`, the whole body is injected, file names can be non-ASCII.
- **Single-choice toggle**: only one scene at a time (others greyed out); turning all off = only `global` and `_shared` inject. New scenes start off.
- **Scene-bound prompt**: switching scenes rewrites `~/.dsh/AGENTS.md` (5-gen backup, auto-restore on exit).
- **Scene profile**: every scene combines MCP tools / skills / subagents / memories (any mix); opening a scene applies and narrows injection, closing restores verbatim (the toggle is the only entry). Checked means on, unchecked means off, and **a missing section means nothing is checked — so that whole domain is off** (a scene with no MCP section therefore stops every MCP server, and exit starts them again). While a scene is active those switches (MCP, skills, subagents) still work — changes are written into that scene's profile too (they take effect immediately and are kept for the next visit); only locking freezes them. The memory domain has a single source of truth and never goes through the profile.
- **"Entering/leaving the mode" and "enabling a scene" are two independent state axes**: the UI toggle is the only entry point (it moves both axes at once). If you bypass the UI and call the HTTP API directly, note that `scene-mode-set{scene:null}` only drops the runtime snapshot and does **not clear the enabled set** — memories and the prompt keep being injected for that scene; a full exit also needs `rules-set-active{scenes:[]}`.
- **Import**: `.md` / `.zip` (dir name = scene, bundles carry attachments), same names skipped never overwritten, over-limit items reported.
- **Export**: pick memories and zip them, keeping the `scene/name` layout; bundle memories bring their attachments along. Sources are read-only.
- **Injection budget**: default 128 KiB, oversized memories skipped with a list. Deletes go to recycle bin.
- **Subagent sessions do not receive memories**: memories are injected into the **top-level session only** — they are the parent's situation, not the facts a child needs; a child's context stays "persona + task", it can read memories on demand with `memory_manager_list/read`, and relevant facts belong in the `task`. Other domains are unaffected (MCP / skills / prompts still inject; the persona catalog follows each persona's `catalogDepth`).
- **Scene lock**: once locked, create/update/delete across MCP / skills / subagents / memories / prompts is read-only — UI disabled plus a server-side guard; a scene must be running to lock, and a locked scene can't be closed until unlocked. **What freezes is the content, not the scene itself**: creating/deleting/renaming a scene, rebinding its prompt, switching the active set, recycle-bin restore and purge, MCP restart, export, injection settings and token settings are all outside the frozen list (they are not "content of the scene profile"). Switching the active set *is* refused while a locked scene is in effect — clearing it would leave the model-side write guard with nothing to check while the runtime still runs that scene's profile.
- **Deleting a scene deletes its memories too**: the scene record, profile and every memory go into one recycle-bin entry, restored as a whole; a running scene refuses deletion. Scene names are renameable (dir and profile follow, memory bodies untouched).

### Subagents

- **One file per persona**: `agents/<persona>.md`, frontmatter entirely optional.
- **A persona reaches the subagent's system prompt inside a role frame**: the body is used verbatim, wrapped in a `# Persona: <name>` heading, one authorizing line ("specified by the caller; where it conflicts with your default inclinations, it wins; the task states what to achieve, and this persona governs how") and one boundary line (it governs *how* you work, not *what* you may do), with the body fenced under `## Persona`. The frame follows the body's language. This makes the model read it as "I have been assigned a role" rather than as two stray sentences following the identity line — **the persona file itself needs no change**. The frame does not include `description`: that field exists so the *caller* can pick a persona; an introduction meant for the child belongs in the body.
- **Tool limits per Agent preset**: each preset gets its own allow/deny list (mutually exclusive), effective at runtime by the current preset — fixes the old "union of all presets" list that broke subagents after a preset switch. Two behaviours to know: **① an allow list is merged back with every currently running `mcp__*` tool** (the official `allow` means "cut everything outside the list", and not merging would cut MCP too), so ticking only `read` will not stop an MCP server that exposes a shell; **② when none of the listed names exists right now, the result is "no restriction"** (fail-open, not fail-closed) — on minimal presets an allow list easily ends up empty. The opposite failure is naming the reserved tool `run_code`: the official `tools.restrict()` throws outright (the subagent never starts), so the plugin strips it from the list and says so in the result.
- **`output:` hard output contract**: frontmatter may carry multiple `output:` lines (**one requirement per line**); the role frame renders them as a separate `## Output requirements (hard)` section after the persona definition. Use the prompt for how the role thinks (prose) and `output:` for what the deliverable must look like (format, severities, required markers, bans) — a persona with only an abstract requirement produces output nobody can check, and only checkable requirements actually get followed. The editor has an "Output requirements (hard)" box, and you can write the lines into the file directly.
- **Run and discard**: `subagent_manager_run` runs with the persona, returns only the result, never enters History. A child's context is **persona + task** only: memories are not injected (the child can read them with `memory_manager_*`, and relevant facts belong in the `task`). Scenes can bind which personas are available.
- **Two context modes**: by default the child starts fresh (it cannot see this conversation, so the task must be complete); with `inherit` the child is seeded with this conversation's **finished** turns (the same mechanism as the host's `subagent_fork`) and the task only states what is new. Only finished turns are inherited — a delegation made during the current turn cannot pass that turn's content (measured: a parent that delegated while still reading left the child to start from scratch), so treat `task` as self-contained in that case. The boundary against the host's two delegation tools (`subagent` / `subagent_fork`) is written into the context by this plugin: **work that matches a persona goes here**, and the host tools are for when no persona fits or a background job is needed.
- **On/off toggles**: a disabled persona is not injected and invisible to the model (file untouched); newly created / imported / restored personas start **disabled** (since v0.8.5, the same rule as skills / MCP) — switch them on before delegating. Entering a scene applies the profile's persona list exactly (checked on, everything else off; no section = all off) and exit restores the pre-scene switches. Inside a scene these toggles still work and are synced into the scene profile (only locking freezes them); leaving the scene restores the pre-scene state.
- **Persona catalog enters the system prompt**: names + descriptions only, so the model knows what it can delegate to; personas are renameable, scene bindings follow.
- **Catalog injection (`catalogDepth`)**: which sessions the standing persona catalog is injected into — default `1` = top level only; `2` also reaches subagent sessions; `3` goes two levels down; the UI's “No nesting limit” writes `99`, which reaches every session depth. **It does not limit nesting**: subagents can always delegate further, which the host decides (`dsh-tool-subagent` defaults to `maxDepth: 3`), and this plugin no longer passes `maxDepth` at all. When the standing catalog is not injected, `subagent_manager_list` still returns every persona. One rule drives all three places (catalog filter, domain declaration, live panel), so the UI and the actual injection cannot disagree.

### MCP servers

- **CRUD + immediate effect**: writes to `cordis.patch.yml`, HMR picks it up.
- **Per-tool switches**: disable individual tools (invisible to the model, blocked at call), whole-server batch.
- **Stopped servers still show their tools**: a server that is not running keeps the tool names and descriptions last seen (marked "as of last run"); one that has never run can be probed with "start server to read tools".
- **Secret masking**: a credential is replaced **as a whole** by `••••••`, and only for keys that look sensitive (token / secret / password / auth / api key and friends); `$VAR` and `!!js` are indirections, so they stay readable, and a URL's query string becomes `?<redacted>`. "Reveal" needs a token.
- **A masked value is never written back into the patch file**: the edit dialog prefills secret fields with the masked text, so on save the plugin restores the value found in the patch file (= that field was left alone). When there is no original value, or the stored one is itself masked (meaning the real value was destroyed earlier), the key is skipped and the panel says so — in the latter case you have to fill it in again. Secrets already stored as a mask are reported as soon as you open the page. **A URL gets the same protection in a different shape**: its query string is masked as `?<redacted>` and is likewise restored from the stored value on save; when the patch holds nothing to restore, **the whole save is refused** with a prompt to retype the full URL — dropping the query silently would leave an address that connects but fails authentication, which is harder to notice than an error.
- **Migrate & back up**: cross-project/global migration rolls back on failure; JSON export/import.
- **Status & notes enter the system prompt**: currently usable servers are listed; **one that has connected before but cannot right now is also listed and labelled** (`（当前未连上；上次连上时 N 个工具）`) — so the model says "it is not connected, check it" instead of reading "configured but unreachable" as "not configured here" and suggesting you install one. Servers that have never connected are omitted. Your notes travel along as decision hints; levels are "global / app", new servers default to global. Note: a persona-complete preset such as minimal suppresses that section — there the model reads server names, enablement, tool counts and notes with `mcp_manager_list`.

### Skills

- **Sources at a glance**: project / DSH / Agents / Codex / Claude / custom dirs, grouped by source.
- **Opposite permissions**: default sources must be read but skills can be deleted; external dirs can be disabled/removed but skills are read-only.
- **Remove ≠ disable**: remove = directory not scanned at all (files untouched, restorable); disable = still listed but not callable.
- **Same-name skills: see which copy is in effect**: the winning copy is marked "preferred", shadowed ones name the source that wins, and enabling a shadowed copy says so instead of pretending it worked.
- **Custom dirs / ZIP import & export / recycle bin**.
- **Directories can be injected**: when a preset mounts no official skills-directory line (e.g. Minimal), this plugin's injection domain delivers them as a fallback, governed by the switches on the Host page (name + blurb; the body is still read from disk).

### Prompt presets

- Multiple `~/.dsh/AGENTS.md` baselines, one-click apply (the host re-reads that file every turn, so it takes effect on the next turn), 5-gen backup.
- **Remembers the preset applied last**: even after you hand-edit `AGENTS.md`, the model can still answer "which preset is this from" (flagged "changed since").
- **Description**: one line saying what a preset is for — shown in this panel only. It lives in a sibling `meta.json`, never in AGENTS.md, so it is never injected into prompts.
- Create with body inline, edit can change id (= dir rename, scene bindings follow). A referenced preset cannot be deleted (scene binding / current contents of `AGENTS.md` / the one to restore when leaving the scene); deletes go to the recycle bin.
- **The body can be injected**: when a preset mounts no official AGENTS.md line (e.g. Minimal), this plugin's injection domain delivers the body of `~/.dsh/AGENTS.md` as a fallback (64 KiB cap; can be turned off on the Host page).
- **While a scene drives the baseline, Apply rebinds the scene to that preset** (bound by a scene, currently in AGENTS.md, or the baseline to restore on scene exit); deletes go to recycle bin.
- **While a scene drives the baseline, Apply rebinds the scene to that preset** (written into the scene profile, and the binding realigns immediately; allowed while unlocked — v0.9 reversed the old "other presets are refused" behavior); **only locking refuses**. The global baseline is restored from the snapshot on scene exit.

### Archived sessions

- Grouped by project, search, batch restore / delete, retention auto-cleanup.
- Workspace registration deleted → group rebuilt from session dirs, one-click re-register.
- Import Claude Code / Cursor / Codex / any text; export Markdown / JSONL. **An export is a readable transcript, not a full backup**: only user/assistant text blocks survive — tool calls, images, reasoning and token stats are dropped, and a `## User` line inside a Markdown body will be read as a turn boundary on re-import (the exporter does not escape it). Use archiving if you need the full record.

### Host compatibility

The plugin uses the host's own `@deepseek-ai/*` libraries at runtime — they must be the same physical modules, or every "adapt to host" decision degrades into guesswork.

- **Host tab**: host version, usable capability count, per-action routing (native/adapter/unavailable), degradations & reasons. The check-up itself is read-only, but the page has three explicit write entries: **access token** (writes the profile's `cordis.patch.yml`, takes effect after restart), **injection settings** (writes `inject-settings.json`, takes effect immediately) and **model tool table** (writes `tool-table.json`, takes effect immediately).
- **Command line**: `node scripts/doctor.mjs` (check), `node scripts/host-deps.mjs --fix` (align deps), `npm run sync:profile` (mirror the build into the profile's local install — a `file:` install is a hard-linked copy, so files ADDED by a build never show up there on their own).
- Under a **suppressing preset** such as `minimal` (persona `complete` / runtime context off) this plugin's injection is **off by default** (following the preset's intent), and the prompt and the skills are missing because their official rows are not mounted — the Host tab marks this per column, and its "Injection" block can force any domain back on.
- **Unchecking "Skills" or "Prompt" really stops them**: under standard presets the host delivers those two itself (the plugin steps aside), so unchecking now also stops the host's copy — the `skill-catalog` / `agent-instructions` messages are no longer let through on that step. The other three domains (memory / MCP / subagents) are only ever sent by this plugin, so their toggles were already complete.
- **What an injection looks like**: one `<system-reminder>` per domain — a `##` title, a **bold one-line action** (the decision point at which to recall it), the tool name / trigger, then the body; any `</system-reminder>` inside the body is escaped (your own text cannot close the frame early). Each message ends with "this copy replaces the earlier one in this session" — injections are only re-sent when the content changes, so the older copy is still in context and the model must know which to trust. The wording follows Claude Code's and Codex CLI's official injections item by item.

---

## Where data lives

| Content                                                               | Location                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| MCP definitions                                                       | `~/.dsh/cordis.patch.yml` (written by the plugin; pre-write copies land in the hub's `backups/`) |
| Skill policy / custom dirs                                            | `~/.dsh/tool-management/skills-state.json`                                                       |
| Skills / memories / personas / presets                                | `~/.dsh/tool-management/{skills,memories,subagents,prompts}/`                                    |
| Subagent toggles                                                      | `~/.dsh/tool-management/subagents-index.json`                                                    |
| Recycle bin (skills/personas/presets/scenes)                          | `~/.dsh/tool-management/trash/{skills,subagents,prompts,scenes}-trash/`                          |
| Memory recycle bin                                                    | `~/.dsh/tool-management/memories-trash/` (**a directory at the hub root, not under `trash/`**)   |
| Archive ledger / retention                                            | `~/.dsh/tool-management/history-*.json`                                                          |
| Memory index / scenes / profiles                                      | `~/.dsh/tool-management/memories-index.json`                                                     |
| MCP sidecars (disabled tools / known tools / notes / settings)        | `~/.dsh/tool-management/mcp-*.json`                                                              |
| Injection settings (five domain switches / suppressing-preset policy) | `~/.dsh/tool-management/inject-settings.json`                                                    |
| Model tool table (tools not sent to the model)                        | `~/.dsh/tool-management/tool-table.json`                                                         |
| Scenes-page preference (preview card before entering a scene)         | `~/.dsh/tool-management/scene-settings.json`                                                     |
| Runtime log / patch backups                                           | `~/.dsh/tool-management/tool-management.log` · `backups/`                                        |

**No user data is stored inside the plugin's install directory** (`dsh plugin update` replaces it wholesale).

**`backups/` keeps 5 copies per patch file**: backup names carry a layer tag (`.global` / `.profile-<name>`), so the global patch and each profile patch keep 5 each — not 5 in total. A single bulk action (e.g. `mcpm-set-all`, or the several writes of entering a scene) can consume all 5 slots of one layer and push out earlier versions.

## Configuration & security

| Field           | Description                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `token`         | Access token. When set, **all writes + plaintext secrets** require `x-dsh-token`; **unset = plaintext endpoints closed**. Also the escape hatch for curl / LAN. If you would rather not keep the token in the config file, set the `DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN` environment variable instead (when both are present `config.token` wins; `tokenDisabled: true` disables both). |
| `tokenDisabled` | `true` = the token **stays in the config** but is not in effect (this is the line written by "Turn protection off"). Writes no longer require a token; plain-text reveal still does (the plain text *is* the credential). Switch it back on any time with "Turn protection on" — no need to retype it.                                                                                 |
| `maxBodyBytes`  | Request body cap, default 88 MiB.                                                                                                                                                                                                                                                                                                                                                    |

- **Browser**: reads/writes via cookie, no token needed; but **plaintext secrets** (Reveal / export) need a token. **The token is managed under Tools → Compatibility → Access token** — a fixed entry point independent of the page. That block is one status pill + one plain sentence + three rows: the row label names the scope, the button names the verb, and the pill only answers "is protection on, is this run unlocked".
  - **This run**: fill once, valid until DSH exits (stored in this browser only). Once accepted, the row turns into a green **Unlocked** chip plus Clear, right where the input was (it used to collapse to a lone Clear button, which read as "what I just typed is gone"); only then does the host accept this token and the two rows below become usable. The row is not shown at all while the host has no token (there is nothing to check it against).
  - **Host config**: written into the profile's `cordis.patch.yml` (only those two lines change — comments and the `!!js` guard stay intact, and the previous file is backed up first); takes effect after a DSH restart. With no host token this row's button is the primary one ("Set token") and asks for the new token **twice** (a typo here means even you cannot match it). Once one is set, "Change token" opens a form with an extra **current token** field — changing it requires proving you know the current one, and being unlocked does **not** count (same rule as turning protection off): you must retype it in the form. The cursor lands in that field when the form opens; the three fields are **stacked** with Save/Clear below them (while the form is open it is the only row shown, and Enter submits), "Save new token" stays disabled until all three are filled, and a rejected token marks that field red.
  - **Protection switch**: clicking "Turn protection off" opens an in-place confirm box (the only row shown while it is open — same rule as "Change token") that asks you to **type the current token again** (yes, even while unlocked — the already-verified credential in the request header does *not* count for turning protection off; otherwise one click right after unlocking would drop the guard). On confirm it only writes `tokenDisabled: true`, so **the token itself stays in the config** and "Turn protection on" brings it back without retyping. While off, writes no longer require a token; **plain-text reveal still requires it** (the plain text *is* the credential). Turning it on keeps the old rule: being unlocked, or having the token in the input box, is enough — otherwise anyone who can open the GUI could switch the protection off.
  - **Delete token** (same row as "Change token"): removes both the `token` and `tokenDisabled` lines from the config, going back to the **never-set-up** state — writes need no token and plain-text secrets become unreadable again. It also opens an in-place confirm box asking for the current token, and the result honestly notes that "old backups still hold plaintext copies" (each backup is a full copy of the config; use "Clean old backups" in the page header to clear those too). Use the protection switch instead when you only want the gate off for now and want to keep the token.
  - **Status pill**: No token yet / Protection off / Protection on · locked / Protection on · unlocked. When the config has been changed but DSH has not restarted, an amber banner below says so (the pill reflects the running process).
- **No "fill in the token" notice while the token is not in effect**: that notice stays only while something is actually gated (a token is in effect on the host). With the token off or unset it is dropped, and the panel's status pill tells you what is going on instead.
- **Where the notice appears**: the "missing or wrong access token" sentence (with its "Fill in token" button) exists **exactly once** — inside the dialog while one is open (that is what blocks your action, so it belongs in plain sight), just below the tabs otherwise. It does not depend on which page you are on or how that page renders errors, so no entry point (dialog submits, imports, exports, bulk actions) can lose it.
- **curl / scripts**: send `x-dsh-token`, or carry the browser cookie.
- **HTTP status convention**: except for the fence's 401/403, a missing token or a business failure is **HTTP 200 + `{ ok: false, error }`** — branch on `body.ok`, not on the status code.
- **The fence's degraded mode**: when the host has no `connection` service, the fence falls back to "loopback Host + same-origin" (there is no browser cookie to check), so any local process can call write ops by faking `Host: localhost`. If you forward the port to a LAN or the public internet, **configure a token** — it is the last door on that degraded path.
- **`dir-list`'s exposure**: the "pick a folder" dialog walks directories through it, so any caller past the fence/token can list directories at **any absolute path** (read-only). That is by design, not a hole — but do not expose the port to an untrusted network.
- **Plaintext on disk (read this)**: masking is a **display-only** measure. MCP `env` / `headers` and the plugin's own `config.token` stay in cleartext inside `~/.dsh/cordis.patch.yml` (and its per-profile copy), and every config change copies the **whole file** into `~/.dsh/tool-management/backups/` (5 copies kept **per patch file**, unencrypted, never rotated, never reclaimed on uninstall) — one secret can end up as `5 × (patch files holding it) + 1` plaintext copies. The token gate decides *who may read plaintext over HTTP*; it does nothing about *reading the files*. Any local process with read access to that directory can take every credential at once. **To clean up: Settings → Tools → Compatibility → "Clean old backups"** (next to Refresh — the button itself shows the current count) — pick how many to delete **per layer** (N deletes that layer's N oldest; the tiers run up to that layer's current count, default 2) — each layer has its own group, so any total is reachable, odd ones included; each row states what would be left, and the dialog asks you to confirm once more, stating the total number of files in that confirmation. Only backup files are touched, never the live config. You can also delete old files under `~/.dsh/tool-management/backups/` by hand.
- **Port forwarded to public**: configure a token — prevents strangers injecting MCP commands (≈ remote code execution) and stealing secrets.

## FAQ

| Symptom                                                           | Fix                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages missing after install                                       | Hard refresh; restart DSH if that fails.                                                                                                                                                                                                                                                       |
| Duplicate MCP tabs                                                | Remove the stale loader row from `cordis.patch.yml`, restart.                                                                                                                                                                                                                                  |
| Broken config, DSH won't boot                                     | Restore the newest `.bak-<timestamp>`.                                                                                                                                                                                                                                                         |
| Action stopped after DSH upgrade                                  | Settings → Tools → **Host** for the reason; `doctor.mjs` → `host-deps.mjs --fix`.                                                                                                                                                                                                              |
| Still asked to confirm in `approval=never`?                       | No card appears — straight through with a log line; switch back to "workspace write" to get asked again.                                                                                                                                                                                       |
| `subagent_manager_run` reports provider unavailable               | The provider isn't registered: `spawn` (default) / `fork` (`inherit`) come from `@deepseek-ai/dsh-subagent-spawn-in-process` / `-fork-in-process` — mount and restart.                                                                                                                         |
| Scene binds persona A, but official `subagent` ran something else | Those two are host tools and this plugin cannot hide them; it writes the boundary into the context instead (work matching a persona goes to `subagent_manager_run`; host tools only when no persona fits or a background job is needed), and `inherit` now matches fork's context inheritance. |

---

## Development

```bash
npm install
npm run build        # tsc + sync client
npm test             # build + i18n + contract tests (pure-function invariants & host contracts; UI tests removed 2026-09-19)
npm run check:i18n   # dictionary self-check
npm run doctor       # host compatibility check
```

`lib/` is not tracked — run `npm run build` after cloning. Changes need `dsh web` restarted. Runtime deps: `fflate` (export bundling) and `js-yaml` (parse check before writing host patches, loaded lazily); `@deepseek-ai/*` all come from the host.

> **Deployment note**: the profile mirror produced by `npm run build` does **not** include `node_modules`, so a runtime dependency added locally (e.g. `js-yaml`) must either be installed on the profile side or accepted as "patch-write check skipped and reported" — the missing checker only disables that one safety net, it never blocks writes. Regular `npm install` deployments are unaffected (dependencies are installed with the package).

## License

MIT
