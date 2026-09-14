# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)

[简体中文](README.md) · **English** · [Changelog](docs/Changelog.md) · [Release overview](docs/update.md)

**An MCP, skills & memory manager for DeepSeek Harness.** One **Tools** panel, eight tabs, five things under control:

- **MCP** — which servers are configured, what tools each exposes, and which ones the model may call: add, edit, remove, toggle, restart, effective immediately;
- **Skills** — every skill on the machine (DSH / Agents / Codex / Claude / project-level / any custom directory) at a glance, toggled individually or per source, created, imported, recycled;
- **AGENTS.md** — multiple global instruction baselines as presets, applied with one click into `~/.dsh/AGENTS.md`;
- **History** — archived sessions grouped by project, batch restore / delete, transcript import & export, retention-based cleanup;
- **Scene memory** — `memories/<scene>/<name>.md`, one folder per scene; the bodies of memories in an enabled scene are **injected into the system prompt in full**, so you never re-explain them.

No hand-editing of `cordis.patch.yml`, no skill source file ever touched, configuration survives restarts and upgrades.

```sh
dsh plugin --profile web add dsh-plugin-tool-management@latest
```

Hard-refresh the browser afterwards (Cmd/Ctrl+Shift-R); a **Tools** panel in Settings means the install worked.

## Screenshots

![Scenes](docs/images/1场景_en.png)

![MCP](docs/images/2MCP_en.png)

![Skills](docs/images/3技能_en.png)

![Subagents](docs/images/4子智能体_en.png)

![AGENTS.md presets](docs/images/5提示词_en.png)

![Memories](docs/images/6记忆_en.png)

![Sessions](docs/images/7会话_en.png)

![Host compatibility](docs/images/8兼容_en.png)

## Highlights

| Capability | In one line |
|---|---|
| Host compatibility | The **Host** tab is a read-only check-up: whether plugin and host load the same module instances, which route each action takes (host-native entry vs plugin adapter), and which capabilities are degraded — with reasons |
| Preset injection reach | Per Agent preset, whether "memory / AGENTS.md / skill catalog" reaches the model; suppressed presets are flagged in the Host tab, and the model tools state the boundary themselves so the model never assumes it has read the bodies |
| Per-tool switches | **Individual tools** inside one MCP server can be disabled: invisible to the model and blocked at call time, restorable at any moment; whole-server batch toggling too |
| Restart semantics | Restart only reconnects — it **never flips the enabled state** (restarting a disabled server does not silently enable it) |
| Secret safety | Secret-looking values in `env` / `headers` are masked by default and URL query strings are redacted; "Reveal" accepts only same-origin requests or local tooling holding a valid token |
| Write protection | Every patch rewrite keeps a timestamped `.bak` (last 5); duplicate loader ids are rejected before the write; failed cross-level migration rolls back; applying an `AGENTS.md` preset keeps 5 generations too |
| Skill sources | Hooks up `~/.agents` / `~/.codex` / `~/.claude` and any custom directory (read-only, overlapping paths rejected); the plugin's own landing spot is **Imported skills** |
| Skill permissions | The two source groups are exact opposites: default sources **must be read** (cannot be removed or disabled) but **their skills can be deleted**; external and custom directories **can be disabled or removed** but **their skills are read-only** |
| Skill operations | Create, ZIP / folder import, recycle bin (restore / permanent delete), open the source in the system editor; directories are watched, so edits show up automatically |
| AGENTS.md presets | Multiple global baselines: create / import / edit / apply / delete; "Apply" writes `~/.dsh/AGENTS.md` (new sessions pick it up, current sessions stay unchanged) |
| Archived sessions | Grouped by project, search, select-all, batch restore / permanent delete, retention cleanup; if a workspace registration is deleted, the group is rebuilt from session directories and can be re-registered with one click |
| Transcript import / export | Take over conversations from Claude Code / Cursor (JSONL), Codex (Markdown) or any text; export as Markdown / JSONL, defaulting to the desktop |
| Scene memory auto-injected | The body of every `.md` in an enabled scene goes into the system prompt (per-agent `systemPrompt` section) with no tool call, effective on the **very next request**; the reserved `global` scene is always injected |
| Memory management | Import `.md` / `.zip` (directory name = scene, bundles carry attachments), toggle individually, recycle bin; the injection budget is visible and oversized memories are skipped with a list |
| Scene profile | Every scene freely combines **MCP tool set / skill set / subagent bindings / memories**; a scene with tools or skills also gets "Enter this mode", and exiting restores the snapshot **verbatim** |
| Lightweight subagents | One file per persona in `agents/`; `subagent_list` / `subagent_run` run and discard, never entering History, inheriting the memories of currently enabled scenes |
| Prefix-cache friendly | Section text depends only on enabled scenes + file contents, so it is byte-stable; switching a scene or editing a memory changes it exactly once |
| Model tools | **14**, five prefixes: `skill_mcp_manager_*` (4), `skill_manager_*` (3), `agentsmd_*` (2), `rule_manager_*` (3), `subagent_*` (2); all three confirm gates respect the session approval policy |
| UI | Its own `dsm-*` design system, **eight tabs** (Scenes / MCP / Skills / Subagents / Prompts / Memories / Sessions / Host), bilingual and following the host language |

## Install & update

Prerequisites: DSH installed (`dsh web` runs), Node.js ≥ 18.

```sh
# Install / update (same command; installs the package and mounts it)
dsh plugin --profile web add dsh-plugin-tool-management@latest

# Uninstall
dsh plugin --profile web remove dsh-plugin-tool-management
```

Hard-refresh the browser (Cmd/Ctrl+Shift-R) afterwards — a **Tools** panel with eight tabs means it worked. Client changes are hot-loaded by DSH, no restart needed; **host-side changes need `dsh web` restarted** to take effect.

You can also tell any DSH session:

```text
Install the dsh-plugin-tool-management plugin:
dsh plugin --profile web add dsh-plugin-tool-management@latest
Then remind me to hard-refresh the browser.
```

## Feature guide

### Scenes and memories

> A scene is the grouping dimension, a memory (`.md`) is the content. A scene can carry a **profile**: MCP tool set / skill set / subagent bindings / memories, four freely combined sections.
> All data lives under `~/.dsh/tool-management/` (see [Where data lives](#where-data-lives)).

- **A scene is an explicit record**: `memories/<scene>/` holds its memories, and the scene itself carries a **description** and an order (in the `scenes` slice of `rules-index.json`). Scene names accept any Unicode (≤64 chars, no `/ \ < > : " | ? *`, must not start with a dot, **a single path segment**). `global` is the reserved always-on scene ("Global" in the UI) and `_shared/` is the legacy shared scene.
- **New scene**: "New scene" asks for a name and a one-line description; you can also just `mkdir` under `memories/` — a record is filled in on the next read. **An empty scene is valid**, so you can create scenes first and add memories later. **A new scene starts switched off.**
- **Every `.md` is one memory**: no frontmatter needed, the whole body is injected. Drop a file into the scene folder and it takes effect, or use "New memory" on the page — **file names can be non-ASCII** (e.g. `站会流程.md`). A memory whose scene does not exist is rejected outright (`scene not found`) instead of silently creating one.
- **Toggle a scene (single choice)**: besides the reserved `global` scene, **only one scene can be enabled at a time** — once one is on, the other switches are greyed out until you turn it off; turning everything off leaves just `global` and `_shared` injecting. Every `.md` inside the enabled scene is injected into the system prompt, effective on the **very next request** — no new session, no plugin reload.
- **A scene can bind one prompt preset**: pick a preset in the scene form (one preset per scene; it **defaults to the one currently in effect**). **Switching scenes rewrites `~/.dsh/AGENTS.md` directly** — the bound preset is written into the global baseline (multi-generation backup under `agents-md/__last-applied__/` first); **turning the scene off restores the baseline from before you entered it** (hand-written content comes back verbatim). Rebinding, or editing the body of the preset currently in effect, also syncs the file. The Prompts page marks that preset as **Active**, and **it cannot be deleted**. If the bound preset is deleted the card says "preset missing" instead of silently touching the file. "Entering a scene" (applying its profile) also enables it, so profile, memories and prompt take effect together.
- **Global memories**: memories of the reserved `global` scene are injected into **every** conversation (they ignore scene switches; the global group on the Memories page is tagged **"always injected"**), which suits universal preferences and conventions. Leaving the scene empty when creating a memory lands it there.
- **Import memories**: the page header's "Import memories" takes `.md` and `.zip` (multi-select, drag-and-drop). Inside a zip, a directory name is the scene (`工作/standup.md` → scene `工作`); **dropping a folder works the same way** (multi-level directories are kept as `A/B`); a bare `.md` lands in the scene picked in the dialog — **leaving it empty means the reserved "Global" scene**. `<scene>/<name>/SKILL.md` inside a zip is imported as a **bundle** (sibling files become attachments; an illegal name, empty content, a single file >8 MB or >16 MB in total is skipped and reported). Files are written verbatim, **same names are skipped and listed** (never overwritten), nothing is dropped silently — every discarded item is reported with a reason — and scenes referenced by an import are created automatically and listed in the result.
- **A memory is a Markdown file**: `<scene>/<name>.md` (flat) or `<scene>/<name>/SKILL.md` (bundle). Creating one asks for scene, name (= file name), description and body; frontmatter is entirely optional and derived automatically when missing.
- **Bundle attachments**: the bundle form lets you add attachments right in the dialog (multi-select, ≤8 MB each, ≤16 MB / 32 files per upload); they live in the memory folder and are **never injected into the prompt** (only the `SKILL.md` body is), and can be removed one by one while editing. The flat form is a single file, so it has nowhere to put attachments.
- **Toggle & recycle**: enable/disable each row (a disabled memory stays on disk, it is simply left out of the prompt), edit, move to trash; the header's "Trash" can **restore** or **permanently delete** (with a confirmation step). `enabled` and friends live in the sidecar index and are never written back to your files.
- **The injection budget is visible**: a budget bar (used / max bytes) sits under the header and turns red when over. Default cap 64 KiB; when one memory does not fit it is **skipped** while smaller ones behind it are still included, and the section tail carries a "not injected (over budget)" list — both the model and you can see what was left out.
- **Scenes page layout**: scenes form a **card grid** (single column below 640px). Each card carries exactly four things: the name (plus the on-disk folder name, status tags and the switch), a **one-line description**, and its action buttons ("Enter this mode" appears only when a profile exists; on the right "Profile / Edit / Delete scene"). Descriptions are capped at **60 characters** (enforced in the field, clipped with an ellipsis on the card with the full text in the tooltip) because cards carry **no counters at all**: what is in effect is told only by the **Active mode** bar at the top of the page, which **appears only while a mode is actually active** (no bar = no mode).
- **Scene profile (four free-form sections)**: "Profile" opens an editor where **MCP tools** (two levels: check a server first; unchecked = the whole server off, checked with no tool picked = all its tools off), **skills** (only currently discovered entries are listed; checked = enabled), **subagent bindings** (check personas; nothing checked = no restriction) and **memories** are added/removed independently. The memory section lists **only the memories of the scene being edited** and is filterable; it **only affects injection** — global memories are always injected and another scene's choices would have no effect, so neither appears here. **A newly added section starts with nothing checked**: the memory section pre-checks only the **enabled** memories of that same scene, the other three give an empty set (an empty MCP / skill / memory section disables that domain, an empty subagent section means no restriction — the section footer spells this out), and "Select all" covers the whole scene. Every section body has a filter box, memory descriptions are clipped at 80 characters with the full text in the tooltip, and the dialog keeps a fixed height so adding or removing sections never makes it jump.
- **Scene modes**: a scene with a tool or skill section gets "Enter this mode" — **entering takes a snapshot of the current toggles, persists it first, applies the selection and narrows memory injection to that scene**; exiting restores the snapshot **verbatim** (whole-server disable keys written during the mode disappear with it). Manual changes made while a mode is running are never silently written back — "Save to scene" does that. Any failed step rolls back and is reported honestly (an incomplete rollback goes into the error text instead of claiming success).

### Subagents (personas)

- **One file per persona**: `~/.dsh/tool-management/agents/<persona>.md`; every frontmatter key is optional — `description` (when to call it, one sentence is enough), `provider` + `model` (the model route, **a pair**: switching providers requires both; a bare `model` resolves against the main session's provider), `tools` allowlist, `toolsDeny` denylist. The body is the persona prompt.
- **Advanced options**: model and tool limits live in an "Advanced options" fold-out (auto-expanded for personas already using them). The model is a **dropdown** of `provider · model` pairs from the host LLM catalogue, with a "Custom" entry to type one it does not list; the tool allow/deny lists are **pickers** whose candidates are the **union of tool names across all agent presets**, grouped by preset — a persona can be reused under any preset, and listing only this session's tools would make the child fail to start after a preset switch (the official `toolFilter` rejects unknown names outright).
- **Import**: the header's "Import" takes `.md` and `.zip` (a `.md` at any depth inside a zip is imported by file name; **same names are skipped and listed**).
- **Running**: the model lists them with `subagent_list` and calls `subagent_run{agent, task}`; the child runs **with the persona**, inherits the memories of currently enabled scenes, returns only its final output (≤16 KiB) to the main model, and is discarded without entering History. A scene profile can bind "which personas are available in this scene" (a call outside the binding reports "persona unavailable"); running asks for confirmation by default (it spends real tokens), which `requireConfirmForModelSubagentRun: false` turns off.
- **Governance boundary**: all of the above covers only the `subagent_run` channel — DSH's own `subagent` / `subagent_fork` are host capabilities with no confirm gate and no notion of these personas, so they honour neither in any mode (see [FAQ](#faq)). Personas never enter a recycle bin (deleted is deleted), and v1 has no model tool that writes persona files.

### MCP servers

- **Add a server**: "Add server" asks for `serverName` (1–32 chars `[A-Za-z0-9_-]`, globally unique), the transport and its fields (`streamable-http` → URL / headers; `stdio` → command / args / env), and project or global level. The write lands as a loader row in `cordis.patch.yml` and applies via HMR.
- **See the state**: every card shows live status, loader phase and registered tool count; a summary bar sits on top, and fatal issues such as duplicate loader ids are flagged right on the page.
- **Turn off just one tool**: the "Details" dialog lists every tool — disable the ones the model keeps misusing; the schema disappears from the model's view and calls are denied, ready to re-enable anytime.
- **Inspect secrets safely**: secret-looking values render as `••••••` by default; click "Reveal" only when you need them.
- **Move and back up**: editing can rename a server or migrate it between project/global level (with automatic rollback on failure); JSON export/import covers full backups and machine moves.

### Skills

- **See everything**: skills are grouped by source — project, runtime, built-in, plugin-shipped, the four user directories (`~/.dsh` / `~/.agents` / `~/.codex` / `~/.claude`; the last three are hooked up by this plugin) and any custom directories you added.
- **Default sources must be read**: `DSH skills` (`~/.dsh/skills/`) and `Imported skills` (`~/.dsh/tool-management/skills/`) may not even be *disabled* — disabling means "still listed but not callable", which contradicts "the path may not go unread"; the server rejects it and the UI renders no source switch for these rows (they show a "Manageable" tag instead). Only the **source layer** is locked: the skills **inside** those two sources can still be deleted — the two are independent.
- **Toggle**: individual skills, whole sources or whole projects — implemented as an override-provider shadow policy, so not a single byte of the source file changes; moving machines is just copying the state file.
- **Remove a source**: unlike disabling one — a disabled source is still scanned and listed (its skills simply cannot be called) — **removing means the directory is not scanned at all**: its skills disappear from the list, drop out of the same-name priority and become invisible to the model (provider candidates). Not a single byte is touched on disk, and it can be restored at any time. Default and project-level sources cannot be removed and show no button.
- **Same-name skills**: when a name appears in several sources, the highest-priority source wins automatically (the others show "shadowed" and have no switch). To use another source's copy, click "Enable this one" on that row — the preference is written to the state file only (`preferredSkills`), never to a source file; the winner row can "Clear preference" to go back to automatic. When the whole source is disabled, "Enable this one" is refused with a hint to enable the source first.
- **Custom directories**: "Add directory" takes an absolute path and turns it into a read-only skill source — ideal for skill collections living in repos or synced folders; overlapping paths are rejected so the shadow policy stays sound.
- **Create / import / recycle**: create from a form; drag in a ZIP, a `.md` file or a skill folder, or use "Select folder" inside the import dialog; deleted skills go to the recycle bin first (restorable), and permanent delete still tries the OS trash as a last safety net. Deletion is available for sources the plugin itself manages (DSH skills / Imported skills / project `.dsh/skills`); external agent and custom directories are read-only and their skills cannot be deleted.

### AGENTS.md presets

- **Preset library**: create, import and edit multiple global instruction baselines (e.g. different teams' coding standards or role behaviours).
- **Apply = write**: "Apply" writes the selected preset to `~/.dsh/AGENTS.md` — **new sessions pick it up, current sessions stay unchanged**; "Apply again" syncs the latest content after editing. Every apply stores what it overwrites as a timestamped backup, **keeping the last 5 generations** (clicking twice cannot lose your original content); switch to another preset before deleting.

### Archived sessions

- **Grouped by project**: archived sessions are grouped by workspace; search by title / session ID / project path; sessions whose workspace folder no longer exists are flagged with ⚠. When a **workspace registration is deleted** (DSH deletes neither the folder nor the sessions), the group is rebuilt from session directories and marked "Workspace removed" / "Unregistered directory"; while the folder still exists one click re-registers it (a registration only — no file or session is touched), and restoring a session also attaches it back to its workspace (previously it simply fell into "Ungrouped").
- **Batch operations**: "Select all" then batch-restore or permanently delete; restored sessions return to the workspace list, and deletion cascades to their subagent sessions.
- **Retention**: pick the cleanup period from the dropdown (0 = keep forever); the expiry baseline is the later of the archive time and the last retention change, so changing the retention resets the countdown.
- **Import conversations**: take over sessions from other tools — Claude Code / Cursor JSONL, Codex Markdown, and arbitrary text — and keep chatting right after import.
- **Export conversations**: pick a session scope (all / archived only / by workspace); each session becomes a Markdown or JSONL file; the export directory defaults to the desktop, and the adjacent "Select" button opens a directory tree to browse and fill in the absolute path.

#### Archive service compatibility

- The plugin **neither disables nor replaces** the official `workspace` / `session-projection-cache`, registers no second service of the same name, and no longer guesses compatibility from a package name — `cordis.patch.yml` only inserts the plugin's own row.
- Archiving goes through the plugin's own facade: **a native entry when one exists, a checked adapter otherwise, and a refusal when neither works**. The decision is based on "are plugin and host the same physical module + does this capability exist on the live host object", **not on comparing official source text** — an upstream refactor can no longer kill the feature wholesale; the worst case is that one action is disabled with a reason, listed on the **Host** tab and in the refusal message.
- The adapter touches workspace internals (including methods the official API declares private) and, when the host lacks its own delete barrier, reversibly wraps the projection cache's `put` / `write`. **So "no longer replaces services / no longer competes for registration" does not mean "zero intrusion"**, nor "decoupled".
- Official durable events supply archive timestamps. Existing archives without a timestamp receive a fresh retention window on first observation instead of expiring from their older creation date.
- Legacy independent caches are retained untouched; official summaries may need rebuilding on demand. Explicit legacy `/workspace` or `/projcache` entries in user patches require review; the plugin does not rewrite those patches.
- Archive/restore/batch delete and late-cache-write protection were exercised with official services and isolated JSON storage. Actual co-installation with `@michengai/dsh-archive-manager` has not been verified; compatibility with arbitrary versions is not guaranteed.

### Host compatibility

At runtime the plugin uses the host's **own** `@deepseek-ai/*` libraries (`dsh-tools` / `dsh-workspace` / `dsh-session-projection-cache` / `cordis` / `dsh-storage-domain` / `dsh-spill-local`). Those must be the **same physical modules the host is running**: with two copies, `instanceof`, `===` and symbol lookups do not cross the boundary, and every "adapt to the host implementation" decision degrades into guesswork.

- **Settings → Tools → Host** (the eighth tab): the same check-up in the UI — host version and required range, verified plugin version, usable capability count, **which route each host action takes** (host-native entry / plugin adapter / unavailable), degraded capabilities with reasons, whether plugin and host share one module instance, and the blocker list. Read-only, nothing is modified.
- **Command line**:

```bash
node scripts/doctor.mjs               # read-only: same module instances? host capability overview
node scripts/host-deps.mjs            # report drift (dry run by default)
node scripts/host-deps.mjs --fix      # junction drifted packages into the host installation (originals backed up to .host-deps-backup/)
node scripts/host-deps.mjs --restore  # put the originals back
```

Re-run `--fix` after a DSH upgrade that moves the installation directory. When the host is missing a package, the plugin refuses the affected action and says why instead of guessing.

> `doctor.mjs` carries a **static subset** of the capability list (it only checks whether members exist, performs no runtime behaviour probe and does not cover the delete route); for the full runtime verdict, trust the **Host tab**.

### Agent preset compatibility (injection vs operation)

DSH's **Agent presets** (`standard` / `ptc` / `cordis` / `minimal`, from `@deepseek-ai/dsh-agent-presets`) are a per-session plugin assembly: each session gets its own tools, prompt sections and skills from its preset's `agent.cordis.yml`. This plugin is **in no preset's composition** — it mounts from the profile's `cordis.patch.yml` (the host plane), so switching presets does not change whether it loads.

But "does it work" splits into two classes with completely different boundaries:

| Capability | What makes it work | `standard` / `ptc` / `cordis` | `minimal` |
|---|---|---|---|
| The 14 model tools, the eight settings tabs, archive / MCP management | Registered on the host plane; preset-independent | ✅ | ✅ |
| Scene memory injection (a per-agent `systemPrompt` section) | The preset's persona is **not** `complete` | ✅ | ❌ suppressed |
| `~/.dsh/AGENTS.md` | The preset mounts `@deepseek-ai/dsh-agent-instructions` | ✅ | ❌ not mounted |
| Skill catalog (the `skill` tool) | The preset mounts `@deepseek-ai/dsh-tool-skill` | ✅ | ❌ not mounted |

**Why injection fails entirely under `minimal`**: its persona row sets `complete: true`, which officially means "the prompt registry restores this exact prefix as the sole section; no identity, suffix, tool guidance, or listener can append prompt text". That is the preset's **design intent** (a minimal configuration), not a defect — this plugin does not fight it, it only says so.

Measured, not inferred (2026-09-14, an empty `minimal` session):

| Probe | Result |
|---|---|
| Call `rule_manager_list` | ✅ Callable, returned the memory list → the tool layer is preset-independent |
| Call `skill` | ❌ No such tool → the skill catalog really is absent under that preset |
| Recite the system prompt | ❌ No memory marker, no AGENTS.md text → injection is suppressed |
| Read `~/.dsh/AGENTS.md` via shell | ✅ The marker is on disk → closed loop: the file is there, it just never reaches the prompt |

**How the plugin makes this visible**:

- **Host tab → Preset injection reach**: per preset, the reachability of "scene memory / AGENTS.md / skill catalog", with suppressed presets flagged and the reason spelled out. It reads preset composition text only — **it mounts nothing** and changes no data.
- **Model tools**: under a suppressing preset, `rule_manager_list` / `agentsmd_list` append a boundary notice telling the model that those memories are **not** in its context and that `rule_manager_read` is how to get the bodies — so listing memories can no longer be mistaken for having read them.
- Answers come from each preset's own composition text (via the roster's `read(id)`), never from a guess; anything unparsable reports "cannot tell", never "fine".

> "Agent presets" and "AGENTS.md presets" are two different things: the latter is this plugin's own preset library (see "AGENTS.md presets" above) and it writes the `~/.dsh/AGENTS.md` file — which is equally inert under `minimal`, for the reason in the table above.

### Let the model and scripts help

| Entry point | What it does |
|---|---|
| `skill_mcp_manager_list / set_enabled / restart / add` | Let the model query and operate MCP servers |
| `skill_manager_list / set_enabled / create` | Let the model query and operate skills (creating asks for your consent) |
| `agentsmd_list / agentsmd_apply` | Let the model list the AGENTS.md preset library and switch the active preset (writes `~/.dsh/AGENTS.md`, effective for new sessions); **no create or delete**, so the model cannot wipe your presets |
| `rule_manager_list / read / write` | Let the model query and write scene memories (writes ask for your consent; can be disabled in settings) |
| `subagent_list / subagent_run` | Let the model list personas and run a one-shot persona subagent (result only, discarded afterwards; running asks for your consent by default, can be disabled in settings) |
| `POST /dsh-plugin-tool-management/api` | HTTP API for scripts (`{op, args}` protocol) |

> v0.4 **no longer registers slash commands** (there used to be `/mcp`, `/skills`, `/agents-md`,
> `/scene-memory`): they could only print a text snapshot, could not operate anything, and drifted from
> the panel state. Every one of them has an equivalent entry in the settings panel.

## Where data lives

| Content | Location |
|---|---|
| MCP server definitions | `profiles/<profile>/cordis.patch.yml` (project) or `~/.dsh/cordis.patch.yml` (global), auto-`.bak` before every rewrite |
| Server notes / page settings / disabled tools / export | Sidecar JSON files under the DSH home (`dsh-plugin-tool-management-*.json`) |
| Skill toggle policy / same-name preferences / custom directories | `~/.dsh/tool-management/state.json` (`sources` / `enabledSkills` / `disabledSkills` / `preferredSkills` / `customRoots`). **The default sources `dsh` / `hub` are not in the `sources` map**: they must be read and have no source switch; `sources.hub` / `removedSources` entries written by older versions are dropped on read |
| Skill recycle bin / import staging | `~/.dsh/tool-management/trash`, `uploads` |
| Skills created/imported by the plugin | `~/.dsh/tool-management/skills/<skill>/` (the official `~/.dsh/skills/` is listed as a source too and is equally manageable: its skills can be deleted, the source itself cannot be removed or disabled) |
| AGENTS.md presets / applied file | `~/.dsh/tool-management/agents-md/<preset id>/AGENTS.md`; "Apply" writes `~/.dsh/AGENTS.md`, overwritten content is backed up under `__last-applied__/` (5 generations) |
| Archive ledger / retention / workspace registration snapshot | `~/.dsh/tool-management/history-archived-at.json`, `history-retention.json`, `history-workspaces.json` (the old location was the plugin dir `data/`, moved in on startup — moved, never overwritten. It **must not** live in the plugin directory: under an npm install `dsh plugin update` replaces that directory wholesale, and losing the ledger makes the retention baseline fall back to session creation time, so archived sessions get cleaned up too early) |
| Memory files (source of truth) | `~/.dsh/tool-management/memories/<scene>/<name>.md` (flat) or `<scene>/<name>/SKILL.md` (bundle); scene names may be non-ASCII; the reserved scene **`global`** (shown as "Global") is injected into every conversation; a bare `.md` in the `memories/` root belongs to no scene and is **never injected** (the check-up reports `noScene`) |
| Memory index / scene records / enabled scenes | `~/.dsh/tool-management/rules-index.json` (`enabled` / order / tags + `scenes` records (label / description / order) + `active` enabled-scene set (`null` = all) + `archives` profile selections + `mode` snapshot) |
| Persona files (source of truth) | `~/.dsh/tool-management/agents/<persona>.md` (frontmatter optional, body = persona prompt) |
| Page settings / confirm switches | `~/.dsh/dsh-plugin-tool-management-settings.json` (`requireConfirmForModelSubagentRun` etc.) |
| Memory recycle bin | `~/.dsh/tool-management/rules-trash/<trashId>/` (deleted memories land here and can be restored) |
| Runtime log | `~/.dsh/dsh-plugin-tool-management.log` (rolling) |

**No user data is ever stored inside the plugin's installation directory** — under an npm install, `dsh plugin update` replaces that directory wholesale.

## Configuration & security

Optional fields on the plugin loader row (`dsh plugin add` inserts it automatically):

| Field | Description |
|---|---|
| `token` | Optional access token. When set, **every write operation and "Reveal"** requires the `x-dsh-token` header. It also acts as the escape hatch from browser authentication: a correct token is accepted as authorization on its own, for curl/scripts and LAN deployments. The client reads it from localStorage (key `dsh-plugin-tool-management-token`; set it in the DevTools console and refresh), or via the `DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN` environment variable. |
| `maxBodyBytes` | Request body cap, default 88 MiB (skill ZIP uploads need it). |

How authentication works: the plugin route is **not** behind a host-wide auth gate, so it calls the host's `connection.requestRejection(req)` itself — first the Host / Origin fence (Host must be a loopback or deployment-derived LAN IP literal, the one header DNS rebinding cannot forge), then browser-session cookie authentication. If that host service is absent, a **local check** takes over that only requires "loopback Host + not a cross-site fetch + Origin matching Host" and **does not include cookie authentication** (weaker than the host fence — configure a token in such an environment). Therefore:

- **In the browser GUI**: authenticated by cookie, no token needed.
- **curl / scripts**: send a correct `x-dsh-token`, or carry the browser cookie.
- Endpoints that return plaintext secrets ("Reveal", config export) additionally require an `Origin` header — a same-origin browser request always sends one, which filters out local scripts that omit it.
- If you forward the port to a LAN or the public internet, a token remains the key defense against strangers injecting MCP commands (equivalent to remote code execution — `command` / `args` are spawned verbatim) and reading plaintext secrets, so **configure one**.
- The `x-dsh-plugin` custom header is only a contact-prevention token, not a credential.

## FAQ

| Symptom | Fix |
|---|---|
| Pages missing in Settings after install | Hard refresh; if that fails, restart DSH once. |
| Duplicate MCP tabs / duplicated tools | Stale loader row double-mounting the plugin — remove the old entry from `cordis.patch.yml` and restart. |
| Broken config, DSH won't boot | Restore the newest `cordis.patch.yml.bak-<timestamp>` next to it. |
| Page data not refreshing | Wait for the automatic polling (default 5s) or click "Refresh". |
| Latest version not found on a mirror | Add `--registry=https://registry.npmjs.org` and retry later. |
| An action stopped working after a DSH upgrade | Open Settings → Tools → **Host** for the reason; run `node scripts/doctor.mjs` first, and `node scripts/host-deps.mjs --fix` if it reports two copies. |
| Archive / restore / delete reports an unavailable capability | Same as above. The plugin prefers refusing over mutating data through an unknown implementation, and the message names the missing capability plus the recovery step. |
| Do the confirmations still apply in full access (`approval=never`)? | **No, and no card appears.** The three confirm gates (`rule_manager_write` / `skill_manager_create` / `subagent_run`) treat a `never` session as "the user has pre-approved", so they pass straight through and write a `confirm-bypass` line to `~/.dsh/dsh-plugin-tool-management.log`. Switch the access mode back to "workspace write" to get asked again, or turn off a single gate with the matching `requireConfirmForModel*` setting. |
| `subagent_run` reports "spawn provider unavailable" | **Conditional**: the host ships a `spawn` provider (recent versions need no extra package and no mount). It only appears when the host really registers none *and* this plugin cannot mount `@deepseek-ai/dsh-subagent-spawn-in-process` either — the message carries the original reason, and it is mostly an older version or a specific profile. Mount that package in the host profile and restart DSH: this plugin deliberately keeps it out of `cordis.patch.yml` so a host without the package still boots. |
| The scene binds only persona A, so why did an unbound subagent still run? | **There are two subagent channels.** This plugin's `subagent_run` goes through its confirm gate and the scene persona binding; DSH's own `subagent` / `subagent_fork` are host capabilities with **no confirm gate and no notion of this plugin's personas**, so they honour neither in any mode (verified live: in one message the official `subagent` returned with no approval card while the following `subagent_run` did prompt). This plugin's governance covers `subagent_run` only. |

## Development

```bash
npm install
npm run build        # build (tsc + sync client bundle)
npm run build:client # sync src/client.js → lib/client.js only
npm run lint         # syntax self-check (node --check on both artifacts)
npm run check:i18n   # dictionaries: key sets / duplicates / placeholders + every literal key referenced in code must exist
npm run check:host   # host dependency check (read-only, see "Host compatibility")
npm run host-deps    # point the plugin's shared deps at the host installation
npm run doctor       # print module identity + host capability probe results
npm test             # build + i18n check + semantic-contract tests (node --test test/*.test.mjs, 13 groups)
```

> `lib/` is generated by `npm run build` and is **not** tracked in git — build before anything else after cloning.
> The host loads `lib/` at startup, so **changes need `dsh web` restarted** (patch hot-reload does not re-import the plugin module).

### How this project verifies things

Verification means **actually exercising the real behaviour**, not asserting what the code currently does — the latter just copies the implementation and passes by construction.
**Wording and layout are not asserted line by line** (maintainer decision, 2026-09-14: those assertions chase a moving target — every style change would demand an assertion change, and the real look is confirmed by a human on the page).

What remains is 13 groups of **semantic-contract** tests (`npm test`, run against the built `lib/`):

| Test | Contract it asserts |
|---|---|
| `archive.test.mjs` | Scene engine state machine: section existence is independent of empty sets, selection → disable complement, deep-copied snapshots, failure rolls back and is reported honestly |
| `import.test.mjs` | Import expansion and landing plans: path traversal rejected, ZIP recognised by magic bytes not extension, over-limit and illegal entries each reported with a reason |
| `approval-policy.test.mjs` | The `approval=never` detection chain, driven by a real cordis context and a real `ApprovalService`; a missing service or a throw never means "allow" |
| `subagent-scene.test.mjs` | Scene persona bindings: a call outside the binding must be rejected **before** the subagent runs |
| `subagent-persona.test.mjs` | Persona frontmatter round-trip: `provider` / `model` / `toolsDeny` survive a UI save; creating a persona with no directory present |
| `hub-layout.test.mjs` | Unified data directory: legacy layouts move without overwriting, the reserved `global` scene always exists and cannot be deleted, a memory must belong to an existing scene, and the profile memory section only affects projection |
| `skills-state.test.mjs` | State-file read resilience: missing keys self-heal, type errors stay fail-closed, leftover policy bits for default sources are dropped |
| `skills-delete.test.mjs` | Default-source skills can be deleted and restored **byte-for-byte** from the recycle bin; read-only sources stay read-only |
| `skills-source-remove.test.mjs` | "Remove a source": it is no longer read, drops out of the same-name priority and is invisible to the model, while not a byte on disk changes and it can be restored; default sources can neither be removed nor disabled |
| `client-exports.test.mjs` | Client export contract: evaluating the factory alone — without running `apply` — must already expose `dict` / `pages`; exports written inside the `apply` method body are rejected |
| `client-render.test.mjs` | Assembly and rendering: a fake ctx drives the whole `apply`, `settings.section` is registered and the entire component tree renders without throwing (this is the one that caught a real blank screen), and again once data has arrived; the scenes page and profile dialog pin structure rather than wording; the Host tab colours only for real blockers or real degradation, and its summary line must contain no Chinese characters under the English dictionary |
| `compat-probe.test.mjs` | Host capability probing: host objects are built from the real official class prototypes, and a renamed member, a changed return shape or a wholly absent service must degrade into a **named** finding instead of a throw; the probe itself is read-only |
| `compat-fallback.test.mjs` | The capability gate really stops writes: with the serialized-write capability missing, archiving is refused and not a single host write method is called; the cache is wrapped only when the host lacks its own delete barrier, and restored on dispose |

Also `npm run check:i18n` (dictionary key sets, duplicates, placeholder alignment and literal-reference completeness — currently 722 keys per language, 454 referenced literals) and `node scripts/i18n-debt.mjs` (how much hard-coded Chinese is left — **214 lines today**: 15 on the prompts page, the rest spread across components and shared shells the script does not attribute to a page; the sessions page is at zero).

These tests assert contracts, not implementation copies; **real-behaviour acceptance still happens in the browser / host and these tests do not replace it**.

### Layout

Host half `src/index.ts` (object-form Cordis plugin, `lib/index.js` is the shipped artifact); host capability probe `src/compat/probe.ts` (the single place that decides what the plugin may do to the host, read-only); HTTP fence `src/http-fence.ts`; data-directory constants and migration `src/hub.ts`; skill core `src/skills/core.js` (pure Node); AGENTS.md presets `src/agents-md/service.ts`; archived session management `lib/history/` (`workspace.js` facade, `bridge.js` compatibility layer, `projcache.js`, `tombstone.js`); transcript import parsing `src/imports/parsers.js`; scene-memory store `src/rules/` (`service.ts` discovery, CRUD, index, check-up and two-phase section render; `provider.ts` registers the per-agent `systemPrompt` section — the module path and `rules-*` op names stay as internal protocol, while the user-visible page and folder are "Scene memory" / `memories/`); browser half `src/client.js` (ModuleLoader CJS bundle, `dsm-*` design system, talks to the host through the same-origin API); dev scripts `scripts/host-deps.mjs` (dependency alignment) and `scripts/doctor.mjs` (compatibility check).

The only runtime dependency is `fflate` (ZIP extraction); every `@deepseek-ai/*` package comes from the host (see "Host compatibility" above).

Publish: `npm publish` (`prepublishOnly` builds automatically; bump with `npm version <minor|patch>`).

## License

MIT
