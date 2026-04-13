# Handover Context
_Saved: 2026-03-14_

## Project
VS Code/Cursor extension **ICM Exchange REPL** that runs Ruby scripts in Autodesk InfoWorks ICM Exchange (or Innovyze IExchange), drops into an interactive REPL, and (per an earlier plan) can show a Variables view. Primary goal: run the active .rb file via the extension and interact in the REPL.

## Current State
- **Extension** invokes `run_ruby_repl.bat` with two args: Ruby file path (active editor) and ICM exe path; no temp file is created by the extension.
- **Batch** (`scripts/run_ruby_repl.bat`) copies `repl.rb` to `%TEMP%\icm_repl\repl.rb` because ICMExchange.exe fails to load the script from the long extension path (e.g. `...\your-publisher-id.icm-exchange-repl-0.1.0\scripts\repl.rb`).
- **Path passing**: The exe does **not** forward command-line arguments to the Ruby script. So the batch writes the Ruby file path to a **per-run temp file** `%TEMP%\icm_ruby_%PID%.txt`, sets env `ICM_REPL_PID=%PID%`, and invokes the exe with only the path to `repl.rb`. This keeps parallel runs safe (each process has its own PID and file).
- **repl.rb** reads the path via `read_ruby_path_from_pid_file` (uses `ENV['ICM_REPL_PID']` and `%TEMP%\icm_ruby_<pid>.txt`), then deletes the file; falls back to `ARGV[0]` for manual runs.
- **Build**: `build-and-run-dev.bat` packages with `vsce package`, uninstalls then installs the extension via `cursor` CLI so it appears in Cursor’s extension list. Uses `icm-exchange-repl-0.1.0.vsix` (not publisher-prefixed name).

## Active Task
Confirming that the REPL runs successfully when launched from the extension. User had previously seen "File not found: ADSK" and "error reading file $...repl.rb$" from ICMExchange.exe; the copy-to-temp and PID-based path file were the latest fixes. No outstanding code change was in progress at handover.

## Next Steps
1. Run the extension (e.g. "ICM REPL: Run Ruby in ICM Exchange") with a .rb file open and confirm the REPL starts and reads the correct file.
2. If "File not found: ADSK" still appears, treat it as an ICM/Autodesk environment or license issue (not fixable in extension/batch).
3. If the PID-based path file fails (e.g. exe not inheriting env), consider verifying that the batch’s child process actually has `ICM_REPL_PID` set when the exe runs.

## Key Files
- `icm-exchange-repl/extension.js` — Extension entry; discovers ICM exe, runs batch with file path + exe path via terminal.
- `icm-exchange-repl/package.json` — Commands, config, views (if variable view was added).
- `icm-exchange-repl/scripts/run_ruby_repl.bat` — Copies repl.rb to %TEMP%\icm_repl, writes path to %TEMP%\icm_ruby_%PID%.txt, sets ICM_REPL_PID, invokes ICMExchange.exe with path to repl.rb only.
- `icm-exchange-repl/scripts/repl.rb` — Reads path from PID temp file or ARGV[0]; evals user script in binding, then REPL loop; supports `__list_vars__` for variable view.
- `icm-exchange-repl/build-and-run-dev.bat` — Package, uninstall, install via `cursor` for testing in Cursor.

## Decisions & Context
- **No shared env for path**: A single env var like `ICM_RUBY_FILE` was rejected so that parallel runs (multiple scripts/terminals) don’t overwrite each other; hence per-PID temp file.
- **Exe does not pass args**: ICMExchange.exe is invoked with script path + (for IExchange) "ICM"; any extra args are not forwarded to the embedded Ruby script, so path must be communicated via env + file (PID file).
- **repl.rb in temp**: The exe fails to load repl.rb from the extension’s long path; copying to `%TEMP%\icm_repl\repl.rb` is required for the exe to load it.
- **Cursor vs code**: Install/uninstall use `cursor` so the extension shows in Cursor; previously using `code` installed into VS Code only.

## Blockers / Open Questions
- "File not found: ADSK" from ICMExchange.exe may still appear; likely license/config on the host, not something the extension can fix.
- Whether the PID-based temp file is actually read by repl.rb in the user’s environment (exe inheriting batch env) may need one more run to confirm.
