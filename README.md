# Exchange Runner

A VS Code / Cursor extension that lets you run Ruby scripts inside **Autodesk InfoWorks ICM Exchange** (`ICMExchange.exe`) or legacy **Innovyze IExchange** (`IExchange.exe`) — and drop into a live, interactive REPL — without ever leaving your editor.

Built for civil and hydraulic engineers who script and automate InfoWorks ICM models with Ruby.

---

## Demo

**Run a script and start the REPL:**

![Run script and open REPL](exchange-runner/images/Exchange%20REPL.gif)

**Evaluate expressions interactively:**

![Evaluate expressions](exchange-runner/images/Exchange%20Expression.gif)

---

## Features

- **One-key launch** — `Ctrl+Alt+R` runs the active `.rb` file in ICM Exchange and opens the REPL panel
- **Auto-discovery** — scans standard Autodesk and Innovyze install paths; lets you pick or browse manually on first run
- **Interactive REPL** — evaluate any Ruby expression against the running ICM context, with arrow-key history
- **Variable inspector** — expandable tree of local variables, updated after each evaluation, with per-variable search
- **Multi-session support** — run different scripts against different ICM versions simultaneously; each session is fully isolated
- **IExchange compatibility** — automatically handles the `ICM` positional argument required by the legacy Innovyze executable
- **Structured output** — colored result/error display, ANSI stripping, batched output for high-throughput scripts

---

## Requirements

- **Windows** — ICM Exchange is a Windows-only application
- **Autodesk InfoWorks ICM** (with `ICMExchange.exe`) or **Innovyze** (with `IExchange.exe`)
- VS Code ≥ 1.74 or Cursor

---

## Installation

### From the VS Code Marketplace _(not yet published)_

Search for **Exchange Runner** in the Extensions panel, or install via the CLI:

```bash
code --install-extension masalab-io.exchange-runner
```

### From a `.vsix` file

Download the latest `.vsix` from the [Releases](../../releases) page and install:

```bash
code --install-extension exchange-runner-0.1.0.vsix
# or for Cursor:
cursor --install-extension exchange-runner-0.1.0.vsix
```

---

## Getting Started

1. Open any `.rb` file in VS Code or Cursor.
2. Press `Ctrl+Alt+R`, click the play button in the editor title bar, or right-click and choose **Exchange Runner: Run Ruby in Exchange**.
3. On first run, Exchange Runner will scan for installed ICM versions and ask you to pick one. You can also browse manually.
4. The REPL panel opens. Type Ruby expressions to evaluate them in the ICM context. Type `exit` to quit.

---

## Commands

| Command | Description | Keybinding |
|---------|-------------|------------|
| **Exchange Runner: Run Ruby in Exchange** | Run the active `.rb` file and open the REPL | `Ctrl+Alt+R` |
| **Exchange Runner: Run Ruby in Exchange (choose executable...)** | Same, but prompts to pick the executable first | `Ctrl+Alt+Shift+R` |
| **Exchange Runner: Select IExchange executable** | Discover or change the active executable | — |

---

## Settings

| Setting | Description |
|---------|-------------|
| `exchangeRunner.icmExchangePath` | Full path to `ICMExchange.exe` or `IExchange.exe`. Leave empty to be prompted on first run. |

---

## Multiple Sessions / Multiple ICM Versions

You can run concurrent sessions against different ICM versions:

- Set `exchangeRunner.icmExchangePath` as a **workspace setting** in `.vscode/settings.json` for each folder to point each workspace at a different executable.
- Each session uses its own isolated temp directory under `%TEMP%\icm_repl\`, so sessions never interfere.

---

## Project Structure

```
exchange-runner/          # VS Code extension (publishable as .vsix)
├── extension.js          # All extension logic: discovery, process management, webview UI
├── package.json          # Extension manifest: commands, keybindings, settings, menus
├── scripts/
│   ├── repl.rb           # Ruby REPL engine that runs inside ICMExchange.exe
│   └── run_ruby_repl.bat # Standalone batch launcher (alternative to the extension)
└── images/               # Demo GIFs used in this README
ICM-EXCHANGE-REPL-PLUGIN-SPEC.md   # Original design spec (authoritative reference)
```

---

## How It Works

When you trigger a run:

1. **Extension** creates a per-session temp directory under `%TEMP%\icm_repl\`.
2. **`repl.rb`** is copied into the temp dir; the target `.rb` file path is written to `ruby_path.txt`.
3. **ICMExchange.exe** (or IExchange.exe) is spawned with `repl.rb` as its script argument.
4. **`repl.rb`** reads `ruby_path.txt`, evals the user's script in a live ICM binding, emits structured markers to stdout, then enters a REPL loop reading from stdin.
5. **Extension** pipes stdout/stderr, parses the markers, and forwards output to the webview REPL panel.

The temp-dir indirection is necessary because ICMExchange.exe fails to load scripts from long or deeply nested paths (such as the VS Code extension install directory).

### Stdout Marker Protocol

`repl.rb` communicates with the extension via markers on stdout:

| Marker | Meaning |
|--------|---------|
| `<<SCRIPT_START>>name` | About to eval the user's script |
| `<<SCRIPT_DONE>>` | Script loaded successfully |
| `<<SCRIPT_ERROR>>msg` | Script raised an exception |
| `<<RESULT>>val<<TYPE>>type` | Expression produced a value |
| `<<ERROR>>cls: msg` | Expression raised an exception |
| `<<READY>>` | REPL is waiting for input |
| `<<VARS>>json` | Local variable snapshot (JSON) |
| `<<EXIT>>` | REPL loop is exiting |

---

## Development

### Prerequisites

- Node.js
- `vsce` — VS Code Extension CLI: `npm install -g @vscode/vsce`

### Build

```bash
cd exchange-runner
vsce package
```

This produces `exchange-runner-0.1.0.vsix`.

### Dev workflow (Cursor)

```bash
cd exchange-runner
# build-and-run-dev.bat chains these:
cursor --uninstall-extension exchange-runner
vsce package
cursor --install-extension exchange-runner-0.1.0.vsix
```

### Key files to know

- **`extension.js`** — all Node.js extension code in one file (~800 lines). The two main classes are `ReplProcess` (child process lifecycle) and `ReplEditorSession` (one REPL panel per run, owns the webview and output routing). The webview HTML/CSS/JS is embedded as a template string inside `extension.js`.
- **`scripts/repl.rb`** — the Ruby REPL engine (~416 lines). This is what runs _inside_ ICMExchange.exe. It evals user scripts, introspects variables, and communicates via the marker protocol above.

---

## Contributing

Contributions are welcome. A few things to know before diving in:

- **No build step** — there is no transpiler, bundler, or test runner. Plain Node.js and `vsce package`.
- **Windows-only target** — the extension only makes sense on Windows (ICMExchange.exe is Windows-only), so process management, path handling, and temp-dir logic is Windows-specific.
- **Single-file extension** — `extension.js` is intentionally kept as one file. If it grows significantly, splitting it is reasonable, but don't introduce a build step without a good reason.
- **Ruby runs inside ICM** — `repl.rb` runs inside InfoWorks ICM's embedded Ruby interpreter, not a standard Ruby install. Changes to it must be compatible with that environment.

Please open an issue before starting work on a large change.

---

## License

MIT — see [LICENSE](LICENSE).

---

## About

Exchange Runner is built by [Masa Lab](https://masalab.io) — tools for engineers working with hydraulic and stormwater models.
