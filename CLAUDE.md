# CLAUDE.md — ICM Exchange REPL

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It also serves as a cross-project reference for related projects (e.g., landing page, auth/login, dashboard) that will integrate with this extension as a freemium product.

---

## Project Overview

**Name:** ICM Exchange REPL (`icm-exchange-repl`)
**Type:** VS Code / Cursor extension (`.vsix`)
**Version:** 0.1.0 (not yet published — publisher ID is placeholder)
**Tech stack:** Plain Node.js, VS Code Extension API, embedded HTML/CSS/JS webview, Ruby, Windows batch
**Build:** No transpiler, linter, or test runner — just `vsce package`
**Target platform:** Windows only (ICM Exchange is Windows-only software)

**What it does:** Provides an interactive Ruby REPL running inside **Autodesk InfoWorks ICM** (ICMExchange.exe) or **Innovyze IExchange.exe**. Users run `.rb` files against ICM's embedded Ruby interpreter and interactively evaluate expressions against the loaded hydraulic model — all within the editor.

**Target users:** Civil/hydraulic engineers using Autodesk InfoWorks ICM for stormwater, wastewater, and flood modeling who want to script and automate model operations via Ruby.

**Business model (planned):** Freemium VS Code extension — free tier with basic REPL, paid tiers with advanced features. A separate web project will handle landing page, auth/login workflow, and dashboards.

---

## Current Project Status

### What's Built (Complete & Working)

1. **Executable discovery** — Auto-scans standard install locations to find ICMExchange.exe (Autodesk) and IExchange.exe (Innovyze), presents via QuickPick, with manual file-browse fallback.

2. **Process management (`ReplProcess` class)** — Spawns ICMExchange.exe directly (no cmd.exe wrapper). Features:
   - Per-session temp directories (`%TEMP%\icm_repl\session_<id>\`)
   - PID-based temp file isolation for multi-session support
   - 30-second startup timeout with user notification
   - Child process enumeration via PowerShell
   - 3-layer terminate strategy: Node `proc.kill()` → `taskkill /F /T /PID` → PowerShell recursive tree kill
   - Stderr buffering (last 10 lines) for diagnostics on crash

3. **Stdout marker protocol** — Structured communication between `repl.rb` (inside ICMExchange.exe) and `extension.js`:

   | Marker | Meaning |
   |--------|---------|
   | `<<SCRIPT_START>>name` | About to eval user's script |
   | `<<SCRIPT_DONE>>` | Script loaded successfully |
   | `<<SCRIPT_ERROR>>msg` | Script raised exception |
   | `<<RESULT>>val<<TYPE>>type` | Expression produced a value |
   | `<<ERROR>>cls: msg` | Expression raised exception |
   | `<<READY>>` | REPL waiting for input |
   | `<<VARS>>json` | Local variable snapshot (JSON tree) |
   | `<<EXIT>>` | REPL loop exiting |

4. **Rich webview UI (`ReplEditorSession`)** — Opens as an editor tab (WebviewPanel):
   - **REPL pane** — output log with syntax-colored results/errors/script info, input bar with arrow-key command history
   - **Variables pane** — expandable tree of local variables (depth=3, max 200 chars/value), highlighted on change, per-variable search/filter
   - Resizable split layout with portrait/landscape toggle
   - CSS spinner and status dot animations (loading, running, ready, error, evaluating)
   - ANSI code stripping, batched output flushing (30ms) for high-throughput scripts
   - Message replay buffer (500 messages) for late-connecting webviews

5. **Ruby REPL engine (`repl.rb`)** — Runs inside ICMExchange.exe's embedded Ruby:
   - Evals user's script in a binding with real file paths for accurate backtraces
   - REPL loop on STDIN with structured marker output
   - Variable introspection: instance variables, Array/Hash elements, ICM `table_info` fields, safe probe methods (`Name`, `ID`, `Type`, etc.)
   - Circular reference detection via visited object IDs
   - Error formatting with source-line preview and user-frame extraction

6. **Keybindings & menus:**
   - `Ctrl+Alt+R` — Run Ruby in Exchange
   - Editor title run button (play icon, Ruby files only)
   - Right-click context menu entry

7. **IExchange compatibility** — Automatically appends the `ICM` positional argument when executable is IExchange.exe

### What's Not Done Yet

- **Publisher ID** — Still placeholder (`your-publisher-id`) in `package.json`
- **Marketplace publishing** — Not yet published to VS Code Marketplace or Open VSX
- **Freemium gating** — No license checking, feature flags, or tier enforcement
- **Auth integration** — No connection to any auth/login system
- **Telemetry/analytics** — None implemented
- **Tests** — No automated tests

---

## Architecture Details

### Process Launch Chain (Current Implementation)

```
User triggers Ctrl+Alt+R (or run button / context menu)
  → extension.js: ensureExePath()
      → reads icmRepl.icmExchangePath setting
      → if empty: promptSelectExecutable() → discoverAll() → QuickPick → save
  → ReplEditorSession created (new WebviewPanel tab)
  → ReplProcess.start(scriptsDir, rubyFilePath, exePath):
      1. Creates per-session temp dir: %TEMP%\icm_repl\session_<timestamp>_<random>\
      2. Copies repl.rb into session temp dir
      3. Writes ruby_path.txt (target .rb file path) into session temp dir
      4. Spawns: ICMExchange.exe <tempDir>/repl.rb
         (or: IExchange.exe <tempDir>/repl.rb ICM)
      5. Pipes stdout/stderr, parses protocol markers
  → repl.rb (inside ICMExchange.exe):
      1. Reads ruby_path.txt to find target .rb file
      2. Evals user's script in a binding (with real file path for backtraces)
      3. Emits <<SCRIPT_START>>, <<SCRIPT_DONE>> or <<SCRIPT_ERROR>>
      4. Emits <<VARS>> with full variable tree JSON
      5. REPL loop: <<READY>> → STDIN.gets → eval → <<RESULT>>/<<ERROR>> → <<VARS>>
      6. On exit: <<EXIT>>
```

**Why temp dir:** ICMExchange.exe fails to load Ruby scripts from long/deep extension install paths.

**Why ruby_path.txt (not ARGV):** ICMExchange.exe does not forward extra CLI arguments to the Ruby script.

### Key Classes (`extension.js`)

| Class | Responsibility |
|-------|---------------|
| `ReplProcess` | Child process lifecycle: spawn, stdin/stdout piping, line buffering, protocol marker detection, 3-layer terminate, startup timeout, child process enumeration |
| `ReplEditorSession` | One REPL session per editor tab. Owns a `ReplProcess`, the `WebviewPanel`, message replay buffer, output batching, and protocol-to-webview routing |

**Global state:** `activeReplSessions` (Set) tracks all open sessions.

### Executable Discovery

| Function | Scans | For |
|----------|-------|-----|
| `discoverAutodesk()` | `C:\Program Files\Autodesk\InfoWorks ICM Ultimate*\` | `ICMExchange.exe` |
| `discoverInnovyze()` | `C:\Program Files\Innovyze\` and `C:\Program Files (x86)\Innovyze\` (up to 3 levels deep) | `IExchange.exe` |

Results combined via `discoverAll()`, presented in QuickPick with a "Browse..." option. Selection saved to `icmRepl.icmExchangePath` (global VS Code setting) and `scripts/icm-path.txt` (for batch script fallback).

### Webview Communication

Extension → Webview (`postMessage`):
- `{ type: 'output', kind: 'result'|'error'|'plain'|'script_start'|'script_done'|'script_error'|'exit'|'source_preview', text, resultType? }`
- `{ type: 'output-batch', lines: [...] }` — batched plain output (30ms flush interval)
- `{ type: 'vars', vars: { varName: { value, type, children: {...} } } }`
- `{ type: 'ready' }` — REPL is waiting for input
- `{ type: 'status', running: boolean }`
- `{ type: 'clear' }` — clear output on restart

Webview → Extension (`postMessage`):
- `{ type: 'ready' }` — webview loaded, replay buffered messages
- `{ type: 'send', text }` — user typed a REPL expression

---

## Key Files

| File | Purpose |
|------|---------|
| `icm-exchange-repl/extension.js` | **Everything**: discovery, process management, webview HTML/CSS/JS (~800+ lines) |
| `icm-exchange-repl/package.json` | Extension manifest: commands, config, keybindings, menus, activation |
| `icm-exchange-repl/scripts/repl.rb` | Ruby REPL engine running inside ICMExchange.exe (~416 lines) |
| `icm-exchange-repl/scripts/run_ruby_repl.bat` | Standalone launcher (batch): temp-dir copy, exe detection, invocation |
| `ICM-EXCHANGE-REPL-PLUGIN-SPEC.md` | Original self-contained spec (authoritative design reference) |

---

## Build & Development Commands

All commands run from `icm-exchange-repl/`:

```bash
# Package the extension as a .vsix
vsce package

# Install into Cursor IDE (dev workflow)
cursor --uninstall-extension icm-exchange-repl
cursor --install-extension .\icm-exchange-repl-0.1.0.vsix
```

`build-and-run-dev.bat` chains these for convenience.

**Publishing (when ready):**
```bash
vsce publish                     # VS Code Marketplace
npx ovsx publish -p <token>      # Open VSX (Cursor/others)
```

---

## Integration Points for Freemium/Web Project

These are the areas where a landing page, auth, and dashboard project would need to connect:

### 1. License/Auth Gating (not yet implemented)
- **Where to add:** `extension.js` — likely a new `checkLicense()` async function called at activation or before `startRepl()`
- **What it would do:** Validate a license key or auth token against an API, determine user tier, gate features accordingly
- **User identity:** Could use VS Code's built-in `AuthenticationProvider` API or a simple API key stored in VS Code settings

### 2. Telemetry/Usage Tracking (not yet implemented)
- **Where to add:** `extension.js` — hook into `ReplEditorSession` lifecycle events
- **Events to track:** session starts, expressions evaluated, errors encountered, session duration, executable version used
- **Privacy:** Must be opt-in with clear disclosure

### 3. Feature Flags / Tier Enforcement (not yet implemented)
- **Potential free-tier limits:** session duration, number of sessions, variable depth, output history size
- **Potential paid features:** unlimited sessions, deep variable inspection, export functionality, multi-model support

### 4. Extension Settings That a Web Dashboard Could Manage
- `icmRepl.icmExchangePath` — currently the only user-facing setting
- Future: license key, telemetry opt-in, tier-specific feature toggles

### 5. User Flow for Freemium
```
Install extension (free)
  → First run: prompt login / sign up (link to web app)
  → Web app: landing page → sign up → email verify → dashboard
  → Dashboard: manage license, view usage, upgrade tier
  → Extension: validate token on activation, enforce tier limits
```

---

## Domain Context

**InfoWorks ICM** is Autodesk's (formerly Innovyze's) hydraulic modeling software for simulating stormwater, wastewater, and river/flood systems. It has an embedded Ruby scripting engine exposed via:
- **ICMExchange.exe** (Autodesk branding, newer) — headless scripting host
- **IExchange.exe** (Innovyze branding, legacy) — same purpose, requires `ICM` product argument

The Ruby API provides access to networks, nodes, links, subcatchments, simulation results, and model databases. Engineers use scripts to automate data import/export, batch simulations, QA checks, and report generation.
