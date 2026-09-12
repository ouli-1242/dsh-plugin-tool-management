# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)

**An MCP server & skills manager for DeepSeek Harness.** One settings panel keeps two things under control:

- **MCP**: which servers are configured, what tools each one exposes, and which tools the model may call — add, edit, remove, toggle, restart; every change takes effect immediately;
- **Skills**: every skill on the machine (DSH / Agents / Codex / Claude / project-level / any directory you add) at a glance — toggle individually or per source, create, import, recycle.

No hand-editing of `cordis.patch.yml`, and skill source files are never touched. Configuration survives restarts and upgrades.

---

<!-- Image slot 1: MCP management page screenshot → docs/images/mcp-page.png -->

![MCP management](https://raw.githubusercontent.com/ouli-1242/dsh-plugin-tool-management/main/docs/images/mcp-page.png)

<!-- Image slot 2: Skills management page screenshot → docs/images/skills-page.png -->

![Skills management](https://raw.githubusercontent.com/ouli-1242/dsh-plugin-tool-management/main/docs/images/skills-page.png)

## Highlights

| Capability | Description |
|---|---|
| Per-tool switches | **Toggle individual tools** inside one MCP server: hidden from the model and blocked at call time, restorable at any moment; whole-server batch enable/disable also supported |
| Restart semantics | Restart only reconnects — it **never flips the enabled state** (restarting a disabled server does not silently enable it) |
| Secret safety | Secret-looking values in `env` / `headers` are **masked by default**, URL query strings are always redacted; revealing plaintext is token-gated just like writes |
| Write protection | Every patch rewrite keeps a timestamped `.bak` backup (last 5); duplicate loader ids are rejected before write; failed cross-level migration rolls back |
| Backup / restore | JSON import supports `conflict: 'overwrite'` to replace entries with the same id, not just skip them |
| Skill sources | Hooks up `~/.agents` / `~/.codex` / `~/.claude` (three directories official DSH does not load) plus **any custom skill directory** you add (read-only, overlapping paths rejected) |
| Skill operations | Create skills, import ZIP / folders, plugin recycle bin (restore / permanent delete with OS-trash fallback), open the source file in the system editor |
| Live refresh | Skill directories are watched from a background thread — edits made in an editor show up automatically |
| Slash commands | `/mcp` and `/skills` right from the chat box |
| Model tools | **7 tools**: `skill_mcp_manager_*` for MCP servers, `skill_manager_*` for skills (creating asks for user confirmation first) |
| UI | Its own `dsm-*` design system, consistent across both pages |

## Getting started

Prerequisites: DSH installed (`dsh web` runs), Node.js ≥ 18.

```sh
# Install (package + auto-mount)
dsh plugin --profile web add dsh-plugin-tool-management@latest

# Update: run the same command again
# Uninstall:
dsh plugin --profile web remove dsh-plugin-tool-management
```

Hard-refresh the browser (Cmd/Ctrl+Shift-R) after installing — the **MCP** and **Skills** pages appear in Settings (client changes are hot-loaded by DSH, no restart needed).

You can also tell any DSH session:

```text
Install the dsh-plugin-tool-management plugin:
dsh plugin --profile web add dsh-plugin-tool-management@latest
Then remind me to hard-refresh the browser.
```

## Feature guide

### Managing MCP servers

- **Add a server**: fill in `serverName` (unique, 1–32 chars `[A-Za-z0-9_-]`), the transport and its fields (`streamable-http` → URL / headers; `stdio` → command / args / env), and choose project or global level. The write lands as a loader row in `cordis.patch.yml` and applies via HMR.
- **See the state**: every card shows live status, loader phase and registered tool count; a summary bar sits on top, and fatal issues such as duplicate loader ids are flagged right on the page.
- **Turn off just one tool**: the "Details" dialog lists every tool with its parameter summary — disable the ones the model keeps misusing; the schema disappears from the model's view and calls are denied, ready to re-enable anytime.
- **Inspect secrets safely**: secret-looking values render as `••••••` by default; click "Reveal" only when you need them.
- **Move and back up**: editing can rename a server or migrate it between project/global level (with automatic rollback on failure); JSON export/import covers full backups.

### Managing skills

- **See everything**: skills are grouped by source — project, runtime, built-in, plugin-shipped, the four user directories (`~/.dsh` / `~/.agents` / `~/.codex` / `~/.claude`; the last three are hooked up by this plugin) and any custom directories you added.
- **Toggle**: individual skills, whole sources or whole projects — implemented as an override-provider shadow policy, so not a single byte of the source file changes; moving machines is just copying the state file.
- **Custom directories**: click "Add directory", enter an absolute path, and that directory becomes a read-only skill source — ideal for skill collections living in repos or synced folders; overlapping paths are rejected to keep the shadow policy sound.
- **Create / import / recycle**: create from a form; drag in a ZIP, a `.md` file or a skill folder; deleted skills go to the plugin recycle bin first, and permanent delete still tries the OS trash as a last safety net.

### Let the model and scripts help

| Entry point | What it does |
|---|---|
| `/mcp`, `/skills` | Check the current state from the chat box |
| `skill_mcp_manager_list / set_enabled / restart / add` | Let the model query and operate MCP servers |
| `skill_manager_list / set_enabled / create` | Let the model query and operate skills (creating asks for your consent) |
| `POST /dsh-plugin-tool-management/api` | HTTP API for scripts (`{op, args}` protocol) |

## Configuration & security

Optional fields on the plugin loader row (`dsh plugin add` inserts it automatically):

| Field | Description |
|---|---|
| `token` | Optional access token. When set, **every write operation and "Reveal"** requires the `x-dsh-token` header. The client reads it from localStorage (key `dsh-plugin-tool-management-token`; set it in the DevTools console and refresh), or via the `DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN` environment variable. |
| `maxBodyBytes` | Request body cap, default 88 MiB (skill ZIP uploads need it). |

Why a token: the cross-site protection (POST-only + custom header + same-origin check) assumes DSH listens on localhost only. If you forward the port to a LAN or the public internet, the token is the last line of defense against strangers injecting MCP commands (equivalent to remote code execution) and reading plaintext secrets — not needed for local single-user setups.

## Where data lives

| Content | Location |
|---|---|
| MCP server definitions | `profiles/<profile>/cordis.patch.yml` (project) or `~/.dsh/cordis.patch.yml` (global), auto-`.bak` before every rewrite |
| Server notes / page settings / disabled tools / export | Sidecar JSON files under the DSH home (`dsh-plugin-tool-management-*.json`) |
| Skill toggle policy / custom directories | `~/.dsh/tool-management/state.json` |
| Skill recycle bin / import staging | `~/.dsh/tool-management/trash`, `uploads` |
| Runtime log | `~/.dsh/dsh-plugin-tool-management.log` (rolling) |

## FAQ

| Symptom | Fix |
|---|---|
| Pages missing in Settings after install | Hard refresh; if that fails, restart DSH once. |
| Duplicate MCP tabs / duplicated tools | Stale loader row double-mounting the plugin — remove the old entry from `cordis.patch.yml` and restart. |
| Broken config, DSH won't boot | Restore the newest `cordis.patch.yml.bak-<timestamp>` next to it. |
| Page data not refreshing | Wait for the automatic polling (default 5s) or click "Refresh". |
| Latest version not found on a mirror | Add `--registry=https://registry.npmjs.org` and retry later. |

## Development

```bash
npm install
npm test             # build + full test suite (node:test, ~1s)
npm run test:fast    # run tests without building
npm run build        # build only (tsc + sync client bundle)
```

Layout: host half `src/index.ts` (object-form Cordis plugin, `lib/index.js` is the shipped artifact); skill core `src/skills/core.js` (pure Node, unit-testable); browser half `src/client.js` (ModuleLoader CJS bundle, `dsm-*` design system, talks to the host through the same-origin API). The only runtime dependency is `fflate` (ZIP extraction).

Publish: `npm version patch && npm publish` (`prepublishOnly` builds automatically).

## License

MIT
