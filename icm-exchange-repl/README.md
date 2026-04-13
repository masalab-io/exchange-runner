# Exchange REPL

Run Ruby scripts inside **Autodesk InfoWorks ICM Exchange** (or legacy **Innovyze IExchange**) directly from VS Code / Cursor, then drop into an interactive REPL.

## Demo

**Run a script and start the REPL:**

![Exchange REPL](images/Exchange%20REPL.gif)

**Evaluate expressions interactively:**

![Exchange Expression](images/Exchange%20Expression.gif)

## Requirements

- **Windows** (ICM Exchange is a Windows-only application)
- **Autodesk InfoWorks ICM** with `ICMExchange.exe`, or **Innovyze** with `IExchange.exe`

## Getting Started

1. Install the extension.
2. Open any `.rb` file.
3. Run **Exchange REPL: Run Ruby in Exchange** from the Command Palette, the run button in the editor title bar, or the right-click context menu (`Ctrl+Alt+R`).
4. On first run, the extension will discover installed ICM versions and ask you to pick one. You can also browse manually for the executable.

After the script executes, an interactive REPL panel opens. Type Ruby expressions to evaluate them in the ICM context, or type `exit` to quit.

## Changing the Executable

- Run **Exchange REPL: Select IExchange executable** from the Command Palette at any time.
- Or edit **Settings > Exchange REPL > ICM Exchange Path** (user or workspace).

## Multiple Sessions and Different ICM Versions

You can run different scripts with different ICM versions at the same time (e.g. one window with ICM 2026, another with ICM 2025):

- **Workspace setting:** Set **ICM Exchange Path** in the workspace settings (`.vscode/settings.json`) for each folder. Each workspace can point to a different executable.
- **Per-run isolation:** Each run uses its own temp directory, so multiple concurrent sessions never interfere with each other.

## Supported Executables

| Vendor   | Executable         | Auto-discovered under |
|----------|--------------------|----------------------|
| Autodesk | `ICMExchange.exe`  | `C:\Program Files\Autodesk\InfoWorks ICM Ultimate *` |
| Innovyze | `IExchange.exe`    | `C:\Program Files\Innovyze` and `C:\Program Files (x86)\Innovyze` |

## Commands

| Command | Description | Keybinding |
|---------|-------------|------------|
| **Exchange REPL: Run Ruby in Exchange** | Run the active `.rb` file and open the REPL panel | `Ctrl+Alt+R` |
| **Exchange REPL: Run Ruby in Exchange (choose executable...)** | Same, but prompts to pick the executable first | `Ctrl+Alt+Shift+R` |
| **Exchange REPL: Select IExchange executable** | Discover and change the active executable | |

## About Masa Lab

Exchange REPL is built by [Masa Lab](https://masalab.io), tools for engineers working with hydraulic and stormwater models.

Visit [masalab.io](https://masalab.io) to learn more.
