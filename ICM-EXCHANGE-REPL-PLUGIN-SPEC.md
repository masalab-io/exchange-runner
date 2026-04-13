# ICM Exchange REPL — VS Code Extension Spec

Use this document to create and publish the **ICM Exchange REPL** VS Code (and Cursor) extension in a new project. When users install the extension, running a Ruby file (e.g. via Code Runner’s Run button) runs it in Autodesk InfoWorks ICM Exchange and then drops into an interactive REPL.

---

## 1. What the extension does

- **Bundles** a batch script and a Ruby REPL script in the extension’s `scripts/` folder.
- **On activation**: Writes the user’s ICM path (if set) to `scripts/icm-path.txt`, and updates **Code Runner** user settings so that the Ruby executor runs the bundled batch with the current file path. Also sets `code-runner.runInTerminal` to `true`.
- **Flow**: User opens a `.rb` file → clicks Run (Code Runner) → batch receives the file path → writes path to `current_file_path.txt` → launches `ICMExchange.exe` with `repl.rb` → `repl.rb` reads the path, runs that file in ICM, then starts the `Exchange>>>` REPL.

**Dependency:** Users need the **Code Runner** extension installed for the Run button to use this. The extension only configures Code Runner; it does not replace it.

---

## 2. Project layout

Create a new folder (e.g. `icm-exchange-repl`) with this structure:

```
icm-exchange-repl/
├── package.json          # Extension manifest
├── extension.js          # Activation + Code Runner config
├── README.md             # User-facing description + setup
└── scripts/
    ├── run_ruby_repl.bat # Windows: receives .rb path, writes to file, runs ICMExchange with repl.rb
    ├── repl.rb           # Ruby: reads path, evals that file in ICM, then REPL loop (STDIN.gets)
    └── (icm-path.txt     # Written by extension from setting icmRepl.icmExchangePath)
```

No build step: plain Node.js and bundled scripts.

---

## 3. File contents

### 3.1 `package.json`

```json
{
  "name": "icm-exchange-repl",
  "displayName": "ICM Exchange REPL",
  "description": "Run Ruby scripts in Autodesk InfoWorks ICM Exchange and drop into an interactive REPL. Configures Code Runner to use ICMExchange.exe with a script-then-REPL flow.",
  "version": "0.1.0",
  "publisher": "your-publisher-id",
  "engines": {
    "vscode": "^1.74.0"
  },
  "categories": [
    "Other"
  ],
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./extension.js",
  "contributes": {
    "configuration": {
      "title": "ICM Exchange REPL",
      "properties": {
        "icmRepl.icmExchangePath": {
          "type": "string",
          "default": "",
          "description": "Full path to ICMExchange.exe (e.g. C:\\Program Files\\Autodesk\\InfoWorks ICM Ultimate 2026\\ICMExchange.exe). If empty, the bundled batch script uses its default path."
        }
      }
    }
  }
}
```

Replace `your-publisher-id` with your Marketplace publisher ID when publishing.

---

### 3.2 `extension.js`

- Uses `context.extensionPath` to resolve `scripts/run_ruby_repl.bat`.
- If the user has set `icmRepl.icmExchangePath`, writes it to `scripts/icm-path.txt` so the batch can use it.
- Merges into Code Runner’s `executorMap` so only the `ruby` key is set; other languages are left unchanged. Path is escaped for JSON (backslashes doubled) so the stored value is valid.

```javascript
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const isWindows = process.platform === 'win32';
  const scriptsDir = path.join(context.extensionPath, 'scripts');
  const runnerPath = path.join(scriptsDir, isWindows ? 'run_ruby_repl.bat' : 'run_ruby_repl.sh');

  // Write ICM path to scripts/icm-path.txt if user set the setting
  const icmPath = vscode.workspace.getConfiguration('icmRepl').get('icmExchangePath');
  if (icmPath && typeof icmPath === 'string' && icmPath.trim()) {
    const icmPathFile = path.join(scriptsDir, 'icm-path.txt');
    try {
      fs.writeFileSync(icmPathFile, icmPath.trim(), 'utf8');
    } catch (_) {}
  }

  // Configure Code Runner: Ruby runs our batch/script with current file path
  const codeRunnerConfig = vscode.workspace.getConfiguration('code-runner');
  const executorMap = codeRunnerConfig.get('executorMap') || {};
  // Escape for JSON (backslashes) and quote for shell
  const pathForJson = runnerPath.replace(/\\/g, '\\\\');
  executorMap['ruby'] = `"${pathForJson}" "$fullFileName"`;
  try {
    await codeRunnerConfig.update('executorMap', executorMap, vscode.ConfigurationTarget.Global);
    await codeRunnerConfig.update('runInTerminal', true, vscode.ConfigurationTarget.Global);
  } catch (e) {
    console.warn('ICM Exchange REPL: Could not update code-runner settings. Install Code Runner extension.', e);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
```

Note: On non-Windows you would need a `run_ruby_repl.sh` that does the same as the batch (write path to a file, run ICMExchange with `repl.rb`). The current setup is Windows-only (ICM Exchange is typically used on Windows).

---

### 3.3 `scripts/run_ruby_repl.bat`

- Receives the first argument as the full path to the `.rb` file to run.
- Writes that path (one line) to `current_file_path.txt` in the same directory as the batch.
- Reads `icm-path.txt` in the same directory if present; otherwise uses a default `ICM_EXE` path.
- Runs `ICMExchange.exe` with `repl.rb` (same directory). `repl.rb` reads `current_file_path.txt`, runs that file in ICM, then starts the REPL.

```batch
@echo off
setlocal
REM Receives the full path to the .rb file to run (from Code Runner).
REM Writes it to current_file_path.txt so repl.rb can run it, then starts ICM Exchange with repl.rb (script + REPL).

set "RUBY_FILE=%~1"
set "REPL_DIR=%~dp0"
set "ICM_EXE=C:\Program Files\Autodesk\InfoWorks ICM Ultimate 2026\ICMExchange.exe"

REM Optional: use path from extension setting (written by extension to icm-path.txt)
if exist "%REPL_DIR%icm-path.txt" (
  set /p ICM_EXE=<"%REPL_DIR%icm-path.txt"
)

if "%RUBY_FILE%"=="" (
    echo Usage: run_ruby_repl.bat ^<path-to-ruby-file^>
    exit /b 1
)

(echo %RUBY_FILE%)> "%REPL_DIR%current_file_path.txt"

if not exist "%ICM_EXE%" (
    echo ICMExchange.exe not found: %ICM_EXE%
    exit /b 1
)

"%ICM_EXE%" "%REPL_DIR%repl.rb"
exit /b %ERRORLEVEL%
```

Adjust the default `ICM_EXE` path if you want a different default (e.g. another ICM version).

---

### 3.4 `scripts/repl.rb`

- Reads the path from `current_file_path.txt` in the same directory as the script (then deletes the file).
- Strips whitespace and optional surrounding double quotes from the path (Code Runner / batch may add quotes).
- Loads and evals the user’s Ruby file in the ICM Exchange environment, then runs a REPL loop.
- Uses `STDIN.gets` (not `gets`) so input comes from the terminal; ICM Exchange passes e.g. `"ADSK"` in `ARGV`, and plain `gets` would try to open that as a file.

```ruby
# Path of the .rb file to run is in current_file_path.txt (same dir as this script).
# We run that file in ICM Exchange, then start an interactive REPL (Exchange>>>).

text_file_path = File.join(File.dirname(__FILE__), 'current_file_path.txt')

if File.exist?(text_file_path)
  ruby_file_path = File.open(text_file_path, 'r', &:readline).chomp.strip
  ruby_file_path = ruby_file_path[1..-2] if ruby_file_path.size >= 2 && ruby_file_path.start_with?('"') && ruby_file_path.end_with?('"')
  File.delete(text_file_path)
else
  puts "File not found: #{text_file_path}"
  exit 1
end

def evaluate_and_print(expr, binding)
  result = eval(expr, binding)
  puts "Result: #{result}"
rescue => e
  puts "Error: #{e.message}"
end

def start_repl(ruby_file_path)
  repl_binding = binding
  puts "Executing ruby script -------------- #{ruby_file_path} --------------"
  ruby_content = File.read(ruby_file_path)
  begin
    eval(ruby_content, repl_binding)
  rescue => e
    puts "Error in input Ruby file: #{e.message}"
  end

  loop do
    print "Exchange>>>"
    input = STDIN.gets
    break unless input
    input = input.chomp
    break if input.downcase == 'exit'
    evaluate_and_print(input, repl_binding)
  end
end

start_repl(ruby_file_path)
```

---

## 4. Discovery and user selection of executable

So users can pick the right executable without editing paths by hand, the extension can implement **installation discovery** (same idea as the Exter CLI) and a **command** that shows a list to choose from, then saves the selection to `icmRepl.icmExchangePath`.

### 4.1 Autodesk (ICMExchange.exe) discovery

Logic as implemented in this project’s `IcmDiscoverer`:

- **Root:** `C:\Program Files\Autodesk`
- **Folders:** all directories whose name starts with `InfoWorks ICM Ultimate` (e.g. `InfoWorks ICM Ultimate 2026`, `InfoWorks ICM Ultimate 2025.5`).
- **Exe:** in each such folder, look for `ICMExchange.exe`. If the file exists, the installation is valid.
- **Version:** take the folder name and strip the prefix `InfoWorks ICM Ultimate`; the rest (trimmed) is the version string (e.g. `2026`, `2025.5`).
- **Sort:** order installations by version descending (newest first).
- **Result:** list of `{ version, exePath, directory }`. `exePath` = `directory\ICMExchange.exe`.

**Pseudocode (e.g. in extension.js):**

```javascript
const fs = require('fs');
const path = require('path');

const AUTODESK_ROOT = 'C:\\Program Files\\Autodesk';
const DIR_PREFIX = 'InfoWorks ICM Ultimate';
const EXE_NAME = 'ICMExchange.exe';

function discoverAutodesk() {
  const list = [];
  if (!fs.existsSync(AUTODESK_ROOT)) return list;
  const dirs = fs.readdirSync(AUTODESK_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith(DIR_PREFIX));
  for (const d of dirs) {
    const dirPath = path.join(AUTODESK_ROOT, d.name);
    const exePath = path.join(dirPath, EXE_NAME);
    if (fs.existsSync(exePath)) {
      const version = d.name.slice(DIR_PREFIX.length).trim();
      list.push({ version, exePath, label: `Autodesk ICM ${version}` });
    }
  }
  list.sort((a, b) => (b.version.localeCompare(a.version)));
  return list;
}
```

### 4.2 Innovyze (IExchange.exe) discovery

For **Innovyze** (legacy) licensing, the headless executable is **IExchange.exe**. Invocation is:

`IExchange [options] [--] script [product] [args]`  
with `product` = `ICM`, `IA`, or `WS` for InfoWorks ICM.

**Typical install locations (Windows):**

- `C:\Program Files\Innovyze\` — subfolders may be product-specific (e.g. `InfoWorks ICM`, or versioned folders).
- `C:\Program Files (x86)\Innovyze\` — 32-bit installs.

**Discovery approach:**

- Scan under `C:\Program Files\Innovyze` and `C:\Program Files (x86)\Innovyze` for any file named `IExchange.exe` (e.g. recursively or in known depth). Each full path is one installation.
- Optionally derive a “version” from the parent folder name if it looks like a version (e.g. `2023`, `3.0`); otherwise label as “Innovyze IExchange” and show the path.
- **Result:** list of `{ versionOrLabel, exePath }` for IExchange.exe.

**Pseudocode:**

```javascript
const INNOVYZE_ROOTS = [
  'C:\\Program Files\\Innovyze',
  'C:\\Program Files (x86)\\Innovyze'
];
const IEXCHANGE_EXE = 'IExchange.exe';

function findIExchangeRecursive(dir, results) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === IEXCHANGE_EXE) {
      const version = path.basename(path.dirname(full));
      results.push({ version, exePath: full, label: `Innovyze IExchange (${version})` });
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      findIExchangeRecursive(full, results);
    }
  }
}

function discoverInnovyze() {
  const list = [];
  for (const root of INNOVYZE_ROOTS) {
    findIExchangeRecursive(root, list);
  }
  return list;
}
```

(If you want to avoid deep recursion, you can limit to one or two levels under each root and only look for `IExchange.exe` in those folders.)

### 4.3 Combined list and user selection

- Run **Autodesk** discovery and **Innovyze** discovery.
- Build one list of choices, e.g. label + `exePath` (and optionally “Autodesk” vs “Innovyze” for display).
- Register a command (e.g. **ICM REPL: Select executable**) that:
  1. Calls `discoverAutodesk()` and `discoverInnovyze()`.
  2. Shows `vscode.window.showQuickPick(items)` with `items = list.map(x => ({ label: x.label, description: x.exePath }))`.
  3. On pick, set `icmRepl.icmExchangePath` to the selected `exePath` (global config), then write the same path to `scripts/icm-path.txt` so the batch uses it.

Add to `package.json`:

```json
"contributes": {
  "commands": [
    {
      "command": "icmRepl.selectExecutable",
      "title": "ICM REPL: Select ICM / IExchange executable"
    }
  ]
}
```

In `extension.js` in `activate()`:

```javascript
context.subscriptions.push(
  vscode.commands.registerCommand('icmRepl.selectExecutable', async () => {
    const autodesk = discoverAutodesk();
    const innovyze = discoverInnovyze();
    const choices = [
      ...autodesk.map(a => ({ label: a.label, description: a.exePath, exePath: a.exePath })),
      ...innovyze.map(i => ({ label: i.label, description: i.exePath, exePath: i.exePath }))
    ];
    if (choices.length === 0) {
      vscode.window.showWarningMessage('No ICMExchange.exe or IExchange.exe found in default install folders.');
      return;
    }
    const picked = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Select executable for ICM REPL',
      matchOnDescription: true
    });
    if (picked) {
      const config = vscode.workspace.getConfiguration('icmRepl');
      await config.update('icmExchangePath', picked.exePath, vscode.ConfigurationTarget.Global);
      const scriptsDir = path.join(context.extensionPath, 'scripts');
      fs.writeFileSync(path.join(scriptsDir, 'icm-path.txt'), picked.exePath, 'utf8');
      vscode.window.showInformationMessage(`ICM REPL will use: ${picked.exePath}`);
    }
  })
);
```

### 4.4 Batch / script support for IExchange.exe

The batch script currently invokes the chosen exe with only the script path: `"%ICM_EXE%" "%REPL_DIR%repl.rb"`.

- **ICMExchange.exe (Autodesk):** `ICMExchange.exe script [args]` — no product argument; the single argument is the script path. Current batch is correct.
- **IExchange.exe (Innovyze):** `IExchange.exe script [product] [args]` — `product` is required (e.g. `ICM`). So if the path in `icm-path.txt` points to **IExchange.exe**, the batch must call it with the script path **and** the product. For example:

  - If the exe path ends with `IExchange.exe`, call: `"%ICM_EXE%" "%REPL_DIR%repl.rb" ICM`
  - Otherwise call: `"%ICM_EXE%" "%REPL_DIR%repl.rb"`

So in the batch you can do:

```batch
set "EXE_NAME=%~nx1"
if /i "%EXE_NAME%"=="IExchange.exe" (
  "%ICM_EXE%" "%REPL_DIR%repl.rb" ICM
) else (
  "%ICM_EXE%" "%REPL_DIR%repl.rb"
)
```

Except the batch doesn’t receive the exe path as %1; it reads it from `icm-path.txt`. So the extension can either:

- Write a small config next to `icm-path.txt` (e.g. `icm-product.txt` containing `ICM` when the user selected an IExchange.exe), and the batch reads both files and passes the product when present; or
- Write a single line in `icm-path.txt` that encodes both path and product (e.g. `path|ICM`), and the batch parses it and calls with product when needed.

**Example: batch that supports both**

Read the exe path from `icm-path.txt` into `ICM_EXE`. Get the filename with a `for` loop; if it is `IExchange.exe`, call with script + `ICM`, else script only:

```batch
setlocal enabledelayedexpansion
REM ... set ICM_EXE from icm-path.txt ...
for %%A in ("%ICM_EXE%") do set "EXE_BASENAME=%%~nxA"
if /i "!EXE_BASENAME!"=="IExchange.exe" (
  "%ICM_EXE%" "%REPL_DIR%repl.rb" ICM
) else (
  "%ICM_EXE%" "%REPL_DIR%repl.rb"
)
```

---

## 5. User flow after install

1. Install the extension (and **Code Runner** if not already installed).
2. (Optional) Run the command **ICM REPL: Select ICM / IExchange executable** to discover Autodesk and Innovyze installations and pick one; the selection is saved to settings and written to `scripts/icm-path.txt`. Or set **ICM Exchange REPL > Icm Exchange Path** manually.
3. Open any `.rb` file and run it with Code Runner (Run button or shortcut). The script runs in ICM Exchange (or IExchange with product ICM), then the `Exchange>>>` REPL appears; type expressions and `exit` to quit.

---

## 6. Publishing the extension

### 6.1 Prerequisites

- Node.js and npm.
- Install the packaging tool: `npm install -g @vscode/vsce`.
- A Microsoft account and a **publisher** on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/).

### 6.2 Create publisher (once)

1. Go to [Visual Studio Marketplace](https://marketplace.visualstudio.com/) → sign in.
2. Click your profile → **Create Publisher**.
3. Choose a **Publisher ID** (eatching as `your-publisher-id` in `package.json`).

### 6.3 Package and publish

From the extension root (e.g. `icm-exchange-repl/`):

```bash
# Login once (then you can publish)
vsce login <your-publisher-id>

# Package (creates .vsix)
vsce package

# Publish to Marketplace
vsce publish
```

For a patch release, bump `version` in `package.json` (e.g. `0.1.1`), then run `vsce publish` again.

### 6.4 Optional: Open VSX (Cursor / other editors)

To list the extension on [Open VSX](https://open-vsx.org/) (used by Cursor and others):

```bash
npx ovsx publish -p <your-open-vsx-token>
```

Create a token at [open-vsx.org](https://open-vsx.org/) under your user → tokens.

---

## 7. README.md (suggested content for the repo)

- **What it does:** Run Ruby in ICM Exchange, then REPL.
- **Requires:** Code Runner extension, Autodesk InfoWorks ICM with ICMExchange.exe (Windows).
- **Setup:** Install this extension and Code Runner. Optionally set **Icm Exchange Path** in settings to your `ICMExchange.exe`.
- **Usage:** Open a `.rb` file, use Run (Code Runner). After the script runs, type expressions at `Exchange>>>` and `exit` to quit.

---

## 8. Summary checklist for a new project

1. Create folder and `package.json` (replace `your-publisher-id` when publishing). Include `contributes.commands` for **ICM REPL: Select executable** if you implement discovery.
2. Add `extension.js` with `async function activate`, Code Runner config, and (optional) discovery + `icmRepl.selectExecutable` command.
3. Implement **Autodesk discovery** (scan `C:\Program Files\Autodesk` for `InfoWorks ICM Ultimate*` → `ICMExchange.exe`) and **Innovyze discovery** (scan `C:\Program Files\Innovyze` and `Program Files (x86)\Innovyze` for `IExchange.exe`).
4. Add `scripts/run_ruby_repl.bat` (read `icm-path.txt`; if exe is `IExchange.exe`, call with script + `ICM`, else script only).
5. Add `scripts/repl.rb` (path from `current_file_path.txt`, then REPL with `STDIN.gets`).
6. Add `README.md` for users (mention Run command to select executable).
7. Run `vsce package` and `vsce publish` (after `vsce login <publisher>`).

This spec is self-contained so you can copy it into a new repo and publish the plugin without the rest of the ExchangeTerminal project.
