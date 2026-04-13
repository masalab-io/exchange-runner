const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawn, exec } = require('child_process');

const AUTODESK_ROOT       = 'C:\\Program Files\\Autodesk';
const AUTODESK_DIR_PREFIX = 'InfoWorks ICM Ultimate';
const AUTODESK_EXE        = 'ICMExchange.exe';
const INNOVYZE_ROOTS      = [
  'C:\\Program Files\\Innovyze',
  'C:\\Program Files (x86)\\Innovyze'
];
const INNOVYZE_EXE        = 'IExchange.exe';
const MAX_RECURSE_DEPTH   = 3;

// ---------------------------------------------------------------------------
// Discovery helpers (unchanged)
// ---------------------------------------------------------------------------

function discoverAutodesk() {
  const list = [];
  if (!fs.existsSync(AUTODESK_ROOT)) return list;
  let dirs;
  try { dirs = fs.readdirSync(AUTODESK_ROOT, { withFileTypes: true }); } catch { return list; }
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith(AUTODESK_DIR_PREFIX)) continue;
    const dirPath = path.join(AUTODESK_ROOT, d.name);
    const exePath = path.join(dirPath, AUTODESK_EXE);
    if (fs.existsSync(exePath)) {
      const version = d.name.slice(AUTODESK_DIR_PREFIX.length).trim() || 'unknown';
      list.push({ version, exePath, label: `Autodesk ICM ${version}` });
    }
  }
  list.sort((a, b) => b.version.localeCompare(a.version));
  return list;
}

function findIExchangeRecursive(dir, results, depth) {
  if (depth > MAX_RECURSE_DEPTH || !fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === INNOVYZE_EXE) {
      const folder = path.basename(path.dirname(full));
      results.push({ version: folder, exePath: full, label: `Innovyze IExchange (${folder})` });
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      findIExchangeRecursive(full, results, depth + 1);
    }
  }
}

function discoverInnovyze() {
  const list = [];
  for (const root of INNOVYZE_ROOTS) findIExchangeRecursive(root, list, 0);
  return list;
}

function discoverAll() {
  return [
    ...discoverAutodesk().map(a => ({ label: a.label, description: a.exePath, exePath: a.exePath })),
    ...discoverInnovyze().map(i => ({ label: i.label, description: i.exePath, exePath: i.exePath }))
  ];
}

// ---------------------------------------------------------------------------
// Path persistence helpers (unchanged)
// ---------------------------------------------------------------------------

function getScriptsDir(context) {
  return path.join(context.extensionPath, 'scripts');
}

function writeIcmPathFile(scriptsDir, exePath) {
  try { fs.writeFileSync(path.join(scriptsDir, 'icm-path.txt'), exePath, 'utf8'); } catch (_) {}
}

function readIcmPathSetting() {
  const val = vscode.workspace.getConfiguration('icmRepl').get('icmExchangePath');
  return (typeof val === 'string' && val.trim()) ? val.trim() : '';
}

function parseExeShortName(exePath) {
  const dirName = path.basename(path.dirname(exePath));
  const stripped = dirName.startsWith('InfoWorks ') ? dirName.slice('InfoWorks '.length) : dirName;
  if (/icm|iexchange|exchange|innovyze/i.test(stripped) || /\d+[\.\d]*/.test(stripped)) return stripped;
  return path.basename(exePath, '.exe');
}

function updateStatusBar(item, exePath) {
  if (exePath) {
    item.text = `$(gear) ICM Exchange: ${parseExeShortName(exePath)}`;
    item.backgroundColor = undefined;
  } else {
    item.text = '$(gear) ICM Exchange: Not Set';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  item.show();
}

async function saveIcmPath(context, exePath, statusBarItem) {
  const config = vscode.workspace.getConfiguration('icmRepl');
  await config.update('icmExchangePath', exePath, vscode.ConfigurationTarget.Global);
  writeIcmPathFile(getScriptsDir(context), exePath);
  if (statusBarItem) updateStatusBar(statusBarItem, exePath);
}

async function promptSelectExecutable(context, statusBarItem) {
  const choices = [];
  const current = readIcmPathSetting();
  if (current) {
    choices.push({
      label: '$(check) ' + path.basename(current),
      description: current,
      detail: 'Currently configured',
      exePath: current
    });
  }
  const discovered = discoverAll();
  for (const d of discovered) {
    if (d.exePath !== current) choices.push(d);
  }
  choices.push({
    label: '$(folder-opened) Browse for executable\u2026',
    description: 'Pick ICMExchange.exe or IExchange.exe manually',
    exePath: '__browse__'
  });
  if (discovered.length === 0 && !current) {
    vscode.window.showInformationMessage(
      'No ICMExchange.exe or IExchange.exe found in default install folders. Please browse manually.'
    );
  }
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select the ICM Exchange executable to use',
    matchOnDescription: true
  });
  if (!picked) return '';
  let exePath = picked.exePath;
  if (exePath === '__browse__') {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Executable': ['exe'] },
      openLabel: 'Select ICMExchange.exe or IExchange.exe',
      title: 'Select ICM Exchange Executable'
    });
    if (!uris || uris.length === 0) return '';
    exePath = uris[0].fsPath;
  }
  await saveIcmPath(context, exePath, statusBarItem);
  vscode.window.showInformationMessage(`ICM REPL will use: ${exePath}`);
  return exePath;
}

async function ensureExePath(context, statusBarItem) {
  const exePath = readIcmPathSetting();
  if (exePath) return exePath;
  return promptSelectExecutable(context, statusBarItem);
}

// ---------------------------------------------------------------------------
// Diagnostic output channel (visible via "Output" panel → "ICM REPL Debug")
// ---------------------------------------------------------------------------
let _logChannel = null;
function logChannel() {
  if (!_logChannel) {
    _logChannel = vscode.window.createOutputChannel('ICM REPL Debug');
  }
  return _logChannel;
}
function _log(msg) {
  logChannel().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// Run a shell command and return { code, stdout, stderr } as a Promise
function _execAsync(command, timeoutMs = 10000) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Kill process tree by PID using PowerShell (recursive children then parent).
// More reliable than taskkill /T when the process spawns detached children.
async function _killProcessTreeWin(pid) {
  const script = [
    'function Kill-Tree($ppid) {',
    '  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $ppid } | ForEach-Object { Kill-Tree $_.ProcessId }',
    '  Stop-Process -Id $ppid -Force -ErrorAction SilentlyContinue',
    '}',
    'Kill-Tree ' + pid
  ].join('\n');
  const scriptPath = path.join(os.tmpdir(), 'icm_repl', 'kill_tree_' + pid + '.ps1');
  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, script, 'utf8');
  } catch (e) {
    _log('kill-tree: failed to write script: ' + (e && e.message));
    return;
  }
  try {
    const { code, stdout, stderr } = await _execAsync(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '"',
      15000
    );
    if (stdout && stdout.trim()) _log('kill-tree stdout: ' + stdout.trim());
    if (stderr && stderr.trim()) _log('kill-tree stderr: ' + stderr.trim());
    _log('kill-tree exit code: ' + code);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (_) {}
  }
}

// Enumerate all descendant processes of a given PID.
// Returns array of { pid, name, cmdLine }.
async function _enumerateProcessTree(pid) {
  const script = [
    'function Get-Descendants($ppid) {',
    '  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '    Where-Object { $_.ParentProcessId -eq $ppid } |',
    '    ForEach-Object {',
    '      $cmd = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(200, $_.CommandLine.Length)) } else { "" }',
    '      Write-Output "$($_.ProcessId)|$($_.Name)|$cmd"',
    '      Get-Descendants $_.ProcessId',
    '    }',
    '}',
    'Get-Descendants ' + pid
  ].join('\n');
  const scriptPath = path.join(os.tmpdir(), 'icm_repl', 'enum_tree_' + pid + '.ps1');
  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, script, 'utf8');
  } catch (e) {
    _log('enum-tree: failed to write script: ' + (e && e.message));
    return [];
  }
  const results = [];
  try {
    const { stdout } = await _execAsync(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '"',
      10000
    );
    for (const line of (stdout || '').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const s1 = t.indexOf('|');
      if (s1 < 0) continue;
      const s2 = t.indexOf('|', s1 + 1);
      results.push({
        pid:     parseInt(t.slice(0, s1), 10),
        name:    s2 > 0 ? t.slice(s1 + 1, s2) : t.slice(s1 + 1),
        cmdLine: s2 > 0 ? t.slice(s2 + 1) : ''
      });
    }
  } catch (e) {
    _log('enum-tree: error: ' + (e && e.message));
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (_) {}
  }
  return results;
}

// ---------------------------------------------------------------------------
// ReplProcess — owns the child process lifetime
// ---------------------------------------------------------------------------

class ReplProcess {
  constructor(onLine, onExit) {
    this._proc          = null;
    this._buf           = '';
    this._onLine        = onLine;
    this._onExit        = onExit;
    this._killed        = false;
    this._exeName       = null;
    this._spawnedPid    = null;  // Persisted so we can kill even after process fires 'close'
    this._spawnedExe    = null;
    this._childExeNames = new Set(); // Exe names of child processes discovered after spawn
    this._stderrBuf     = [];    // Last ~10 stderr lines for diagnostics
    this._startupTimer  = null;  // 30s startup timeout
    this._gotFirstMarker = false;
    this._sessionDir    = null;  // Per-session temp dir for cleanup
  }

  /**
   * Spawn ICMExchange.exe (or IExchange.exe) directly — no cmd.exe wrapper.
   * The bat-file setup logic (temp-dir copy, ruby_path.txt) is now done here
   * so that this._proc.pid IS the ICMExchange.exe PID, making terminate() reliable.
   */
  start(scriptsDir, rubyFilePath, exePath) {
    // Safety: if somehow _proc is still set, destroy it synchronously
    if (this._proc) {
      _log('start: _proc was still set — force-closing stdin');
      try { this._proc.stdin.destroy(); } catch (_) {}
      this._proc = null;
    }
    this._buf           = '';
    this._killed        = false;
    this._exeName       = path.basename(exePath);
    this._spawnedPid    = null;
    this._spawnedExe    = path.basename(exePath);
    this._childExeNames = new Set();
    this._stderrBuf     = [];
    this._gotFirstMarker = false;
    if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }

    // --- replicate run_ruby_repl.bat setup (per-session temp dir) ---
    const sessionId   = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tempReplDir = path.join(os.tmpdir(), 'icm_repl', 'session_' + sessionId);
    this._sessionDir  = tempReplDir;
    try { fs.mkdirSync(tempReplDir, { recursive: true }); } catch (_) {}

    const srcRepl  = path.join(scriptsDir, 'repl.rb');
    const destRepl = path.join(tempReplDir, 'repl.rb');
    try { fs.copyFileSync(srcRepl, destRepl); } catch (err) {
      this._onLine('<<ERROR>>Failed to copy repl.rb: ' + err.message);
      this._onExit(null);
      return;
    }

    // Write ruby file path for repl.rb to discover
    const rubyPathFile = path.join(tempReplDir, 'ruby_path.txt');
    try { fs.writeFileSync(rubyPathFile, rubyFilePath, 'utf8'); } catch (err) {
      this._onLine('<<ERROR>>Failed to write ruby_path.txt: ' + err.message);
      this._onExit(null);
      return;
    }

    // ICMExchange.exe needs forward slashes
    const replRb = destRepl.replace(/\\/g, '/');

    // IExchange.exe needs the extra "ICM" argument
    const isIExchange = this._exeName.toLowerCase() === 'iexchange.exe';
    const args = isIExchange ? [replRb, 'ICM'] : [replRb];

    _log(`start: spawning "${exePath}" ${args.join(' ')}`);
    _log(`start: rubyFile=${rubyFilePath}, replRb=${replRb}`);

    try {
      this._proc = spawn(exePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      _log(`start: spawn failed: ${err.message}`);
      this._onLine('<<ERROR>>Failed to start process: ' + err.message);
      this._onExit(null);
      return;
    }

    this._spawnedPid = this._proc.pid;
    _log(`start: PID=${this._spawnedPid} (${this._exeName})`);

    this._proc.stdout.on('data', (chunk) => {
      if (this._killed) return;
      this._buf += chunk.toString('utf8');
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf  = this._buf.slice(nl + 1);
        if (!this._gotFirstMarker && line.startsWith('<<')) {
          this._gotFirstMarker = true;
          if (this._startupTimer) {
            clearTimeout(this._startupTimer);
            this._startupTimer = null;
          }
        }
        this._onLine(line);
      }
    });

    this._proc.stderr.on('data', (chunk) => {
      if (this._killed) return;
      const text = chunk.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      for (const line of text.split('\n')) {
        if (line.trim()) {
          this._stderrBuf.push(line.trim());
          if (this._stderrBuf.length > 10) this._stderrBuf.shift();
        }
      }
    });

    this._proc.on('close', (code) => {
      _log(`process closed (code ${code})`);
      this._proc = null;
      if (!this._killed) this._onExit(code);
    });

    this._proc.on('error', (err) => {
      _log(`process error: ${err.message}`);
      if (this._killed) { this._proc = null; return; }
      this._onLine('<<ERROR>>Process error: ' + err.message);
      this._proc = null;
      this._onExit(null);
    });

    // Startup timeout: if no protocol marker arrives within 30s, alert the user
    this._startupTimer = setTimeout(() => {
      if (!this._gotFirstMarker && !this._killed) {
        this._onLine('<<ERROR>>ICMExchange.exe did not respond within 30 seconds. It may be stuck initializing or the executable path may be incorrect.');
      }
    }, 30000);

    // ICMExchange.exe may be a launcher that spawns the actual REPL host under
    // a different exe name. After a short delay, enumerate child processes and
    // store their names so terminate() can kill them even if the launcher exits.
    const spawnedPid = this._spawnedPid;
    setTimeout(async () => {
      if (this._killed || !spawnedPid) return;
      try {
        const children = await _enumerateProcessTree(spawnedPid);
        if (children.length > 0) {
          _log('start: child processes of PID ' + spawnedPid + ':');
          for (const c of children) {
            _log('  PID=' + c.pid + ' Name=' + c.name + ' Cmd=' + (c.cmdLine || '').slice(0, 200));
            if (c.name) this._childExeNames.add(c.name);
          }
        } else {
          _log('start: no child processes found under PID ' + spawnedPid);
        }
      } catch (e) {
        _log('start: child enumeration error: ' + (e && e.message));
      }
    }, 3000);
  }

  send(text) {
    if (this._proc && this._proc.stdin && !this._proc.stdin.destroyed) {
      this._proc.stdin.write(text + '\n', 'utf8');
    }
  }

  get lastStderr() { return this._stderrBuf.slice(); }

  /**
   * Terminate the process tree.
   *
   * Uses three PID-scoped layers to avoid cross-session interference:
   *   1. Node proc.kill()     — TerminateProcess on the direct child
   *   2. taskkill /F /T /PID  — OS-level tree kill (fast, works if parent alive)
   *   3. PowerShell tree kill — recursive walk by ParentProcessId (works even
   *                             after parent exits, catches orphaned children)
   */
  async terminate() {
    this._killed = true;
    if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }
    const pid = this._proc ? this._proc.pid : this._spawnedPid;
    this._exeName       = null;
    this._spawnedPid    = null;
    this._spawnedExe    = null;
    this._childExeNames = new Set();

    // 1) Close stdin (unblocks STDIN.gets in repl.rb) + TerminateProcess
    if (this._proc) {
      try { this._proc.stdin.destroy(); } catch (_) {}
      try { this._proc.kill(); _log('terminate: proc.kill() sent'); } catch (_) {}
      this._proc = null;
    }

    if (!pid) {
      _log('terminate: nothing to kill (no pid)');
    } else {
      _log(`terminate: PID=${pid}`);

      // 2) taskkill /F /T /PID — fast OS tree kill (only works while parent alive)
      const r = await _execAsync(`taskkill /F /T /PID ${pid}`, 10000);
      _log(`terminate: taskkill /T /PID ${pid}: code=${r.code} out=${(r.stdout || '').trim()} err=${(r.stderr || '').trim()}`);

      // 3) PowerShell recursive tree kill (handles children whose ParentProcessId
      //    still references our PID even after the launcher has exited)
      try {
        await _killProcessTreeWin(pid);
      } catch (e) {
        _log('terminate: PS tree-kill error: ' + (e && e.message));
      }
    }

    // Clean up per-session temp directory
    if (this._sessionDir) {
      const dir = this._sessionDir;
      this._sessionDir = null;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  get running() { return this._proc !== null; }
}

// ---------------------------------------------------------------------------
// ReplEditorSession — one REPL session in an editor tab (WebviewPanel).
// Closing the tab disposes the session and terminates the process.
// ---------------------------------------------------------------------------

const activeReplSessions = new Set();

class ReplEditorSession {
  constructor(panel, rubyFilePath, exePath, context) {
    this._panel        = panel;
    this._rubyFilePath = rubyFilePath;
    this._exePath      = exePath;
    this._context      = context;
    this._scriptsDir   = getScriptsDir(context);
    this._replay       = [];
    this._outBuffer    = [];
    this._outTimer     = null;
    this._cleanExit    = false;

    this._proc = new ReplProcess(
      (line) => this._handleLine(line),
      (code) => this._handleExit(code)
    );

    this._panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    this._panel.webview.html   = buildHtml();

    this._panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ready':
          for (const m of this._replay) {
            if (this._panel && this._panel.webview) this._panel.webview.postMessage(m);
          }
          this._post({ type: 'status', running: this._proc.running });
          break;
        case 'send':
          this._proc.send(msg.text);
          break;
      }
    });

    this._panel.onDidDispose(() => this._onPanelDispose());
    activeReplSessions.add(this);
  }

  _onPanelDispose() {
    activeReplSessions.delete(this);
    this._proc.terminate();
    this._panel = null;
  }

  _queueOutput(kind, text, resultType) {
    this._outBuffer.push({ kind, text, resultType });
    if (!this._outTimer) {
      this._outTimer = setTimeout(() => this._flushOutput(), 30);
    }
  }

  _flushOutput() {
    this._outTimer = null;
    if (this._outBuffer.length === 0) return;
    const lines = this._outBuffer.splice(0);
    this._post({ type: 'output-batch', lines });
  }

  _cancelOutput() {
    if (this._outTimer) { clearTimeout(this._outTimer); this._outTimer = null; }
    this._outBuffer = [];
  }

  startRepl() {
    this._cancelOutput();
    this._cleanExit = false;
    this._setSessionRunning(true);
    this._post({ type: 'clear' });
    this._post({ type: 'status', running: true });
    this._proc.start(this._scriptsDir, this._rubyFilePath, this._exePath);
  }

  dispose() {
    activeReplSessions.delete(this);
    this._proc.terminate();
    this._panel = null;
  }

  _handleLine(line) {
    if (line.startsWith('<<VARS>>')) {
      try {
        const vars = JSON.parse(line.slice(8));
        this._post({ type: 'vars', vars });
      } catch (_) {
        // Malformed JSON — show raw line as plain output
        this._post({ type: 'output', kind: 'plain', text: line });
      }
      return;
    }
    if (line.startsWith('<<RESULT>>')) {
      const rest = line.slice(10);
      const sep  = rest.indexOf('<<TYPE>>');
      this._post({
        type: 'output', kind: 'result',
        text:       sep === -1 ? rest       : rest.slice(0, sep),
        resultType: sep === -1 ? ''         : rest.slice(sep + 8)
      });
      return;
    }
    if (line.startsWith('<<ERROR>>')) {
      this._post({ type: 'output', kind: 'error', text: line.slice(9) });
      return;
    }
    // Source-preview lines emitted right after errors (e.g. "   42 | code_here")
    if (/^\s+\d+\s*\|\s/.test(line)) {
      this._post({ type: 'output', kind: 'source_preview', text: line });
      return;
    }
    if (line.startsWith('<<SCRIPT_START>>')) {
      this._post({ type: 'output', kind: 'script_start', text: line.slice(16) });
      return;
    }
    if (line === '<<SCRIPT_DONE>>') {
      this._post({ type: 'output', kind: 'script_done', text: '' });
      return;
    }
    if (line.startsWith('<<SCRIPT_ERROR>>')) {
      this._post({ type: 'output', kind: 'script_error', text: line.slice(16) });
      return;
    }
    if (line === '<<READY>>') {
      this._post({ type: 'ready' });
      return;
    }
    if (line === '<<EXIT>>') {
      this._cleanExit = true;
      this._setSessionRunning(false);
      this._post({ type: 'output', kind: 'exit', text: 'Session ended.' });
      this._post({ type: 'status', running: false });
      return;
    }
    // Strip residual ANSI codes defensively, then queue as plain output.
    // Queued lines are flushed in 30ms batches to keep the event loop responsive
    // when scripts emit thousands of lines per second (e.g. a 1M-iteration loop).
    const clean = line.replace(/\x1b\[[0-9;]*[mGKJH]/g, '');
    if (clean.trim()) this._queueOutput('plain', clean);
  }

  _setSessionRunning(on) {
    vscode.commands.executeCommand('setContext', 'icmRepl.sessionRunning', on);
  }

  _handleExit(code) {
    this._flushOutput();
    this._setSessionRunning(false);
    this._post({ type: 'status', running: false });
    if (this._cleanExit) return;
    if (code !== 0 && code !== null) {
      this._post({ type: 'output', kind: 'error', text: `Process exited with code ${code}.` });
      const stderr = this._proc.lastStderr;
      for (const line of stderr) {
        this._post({ type: 'output', kind: 'plain', text: line });
      }
      this._post({ type: 'output', kind: 'exit', text: 'Use Ctrl+Alt+R to restart the REPL session.' });
    }
  }

  _post(msg) {
    if (msg.type === 'clear') {
      this._replay = [msg];
    } else {
      this._replay.push(msg);
      if (this._replay.length > 500) this._replay.shift();
    }
    if (this._panel && this._panel.webview) this._panel.webview.postMessage(msg);
  }
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function buildHtml() {
  const css = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 12px);
      color: var(--vscode-foreground);
      background: var(--vscode-panel-background, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Vertical layout: REPL (top) | resizer | Variables (bottom) ──── */
    #repl-pane {
      flex: 1 1 0;
      min-height: 120px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #resizer {
      flex: 0 0 5px;
      cursor: row-resize;
      background: transparent;
      transition: background 0.15s;
    }
    #resizer:hover, #resizer.dragging {
      background: var(--vscode-focusBorder, rgba(128,128,128,0.4));
    }

    /* Layout toggle button */
    .layout-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 3px;
      padding: 2px;
      flex-shrink: 0;
      opacity: 0.6;
      transition: opacity 0.15s, background 0.15s;
    }
    .layout-toggle:hover {
      opacity: 1;
      background: rgba(128, 128, 128, 0.15);
    }
    .layout-toggle svg { width: 14px; height: 14px; }

    /* Landscape mode */
    body.landscape {
      flex-direction: row;
    }
    body.landscape #repl-pane {
      min-height: unset;
      min-width: 200px;
    }
    body.landscape #resizer {
      flex: 0 0 5px;
      cursor: col-resize;
    }
    body.landscape #vars-pane {
      flex: 0 0 280px;
      min-height: unset;
      max-height: unset;
      min-width: 120px;
      max-width: 50%;
    }

    #vars-pane {
      flex: 0 0 220px;
      min-height: 80px;
      max-height: 50%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Section headers ──────────────────────────────────── */
    .pane-hdr {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 3px 10px;
      flex-shrink: 0;
      background: var(--vscode-panelSectionHeader-background, var(--vscode-sideBarSectionHeader-background, rgba(0,0,0,0.12)));
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--vscode-panelSectionHeader-foreground, var(--vscode-descriptionForeground));
      user-select: none;
    }
    .hdr-spacer { flex: 1; }

    /* ── Status indicator (dot + spinner) ─────────────────── */
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-descriptionForeground, #666);
      flex-shrink: 0;
      transition: background 0.3s;
    }
    .status-dot.running { background: var(--vscode-terminal-ansiGreen, #4ec9b0); }
    .status-dot.ready   { background: var(--vscode-terminal-ansiCyan,  #9cdcfe); }
    .status-dot.error   { background: var(--vscode-terminal-ansiRed,   #f44747); }
    .status-dot.loading {
      background: var(--vscode-charts-yellow, #d4ac0a);
      animation: dot-pulse 0.9s ease-in-out infinite;
    }
    @keyframes dot-pulse {
      0%, 100% { opacity: 1;   transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.8); }
    }
    .status-dot.evaluating {
      background: var(--vscode-charts-yellow, #d4ac0a);
      animation: dot-eval 0.5s ease-in-out infinite;
    }
    @keyframes dot-eval {
      0%, 100% { transform: scale(1.5); opacity: 1;   }
      50%       { transform: scale(0.6); opacity: 0.35; }
    }

    /* CSS spinner (no emoji, pure CSS) */
    .spinner {
      width: 10px; height: 10px; flex-shrink: 0;
      border: 1.5px solid rgba(128,128,128,0.3);
      border-top-color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
      border-radius: 50%;
      animation: spin 0.65s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Variables panel ──────────────────────────────────── */
    #vars-body {
      flex: 1;
      overflow-y: auto;
      padding: 2px 0;
    }
    .v-empty {
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 0.9em;
    }
    .v-row {
      display: flex; align-items: center;
      padding: 1px 0; padding-right: 6px; line-height: 22px;
      cursor: default; white-space: nowrap; overflow: hidden;
    }
    .v-row:hover { background: var(--vscode-list-hoverBackground); }
    .v-row.expandable { cursor: pointer; }
    .v-indent  { display: inline-block; width: 16px; flex-shrink: 0; }
    .v-toggle  { width: 16px; flex-shrink: 0; font-size: 9px; text-align: center;
                 color: var(--vscode-descriptionForeground); }
    .v-name    { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); font-weight: 500; }
    .v-colon   { color: var(--vscode-descriptionForeground); margin: 0 2px; }
    .v-value   { overflow: hidden; text-overflow: ellipsis; }
    .v-type    { margin-left: 6px; font-style: italic; font-size: 0.85em;
                 color: var(--vscode-descriptionForeground); }
    .v-kids    { display: none; }
    .v-kids.open { display: block; }

    @keyframes var-flash {
      0%   { background: rgba(14, 165, 233, 0.18); }
      100% { background: transparent; }
    }
    .v-flash { animation: var-flash 0.8s ease-out; }

    /* ── Per-variable search/filter ─────────────────────── */
    .v-search-btn {
      cursor: pointer;
      opacity: 0.4;
      padding: 0 3px;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      margin-left: auto;
      transition: opacity 0.15s;
    }
    .v-search-btn:hover { opacity: 1; }
    .v-search-btn svg { width: 12px; height: 12px; }

    .v-search-bar {
      display: flex;
      align-items: center;
      padding: 3px 8px 3px 22px;
      gap: 6px;
      background: var(--vscode-input-background, rgba(0,0,0,0.1));
    }
    .v-search-bar input {
      flex: 1;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }
    .v-search-bar input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .v-search-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .v-search-clear {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      line-height: 1;
      display: none;
      align-items: center;
    }
    .v-search-clear:hover { opacity: 1; }
    .v-search-clear svg { width: 12px; height: 12px; }
    .v-search-close {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      line-height: 1;
      display: inline-flex;
      align-items: center;
    }
    .v-search-close:hover { opacity: 1; }
    .v-search-close svg { width: 12px; height: 12px; }

    .v-filter-hidden { display: none !important; }

    /* ── REPL output ──────────────────────────────────────── */
    #output-log {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 12px);
    }

    .repl-line {
      padding: 0 10px;
      line-height: 1.55;
      animation: line-in 0.12s ease-out;
    }
    @keyframes line-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: none; }
    }

    /* Welcome message (shown when no session is active) */
    #welcome {
      padding: 16px 10px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 12px);
    }
    .welcome-box {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 3px;
      padding: 10px 14px;
      line-height: 1.7;
    }
    .welcome-title {
      color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .welcome-kbd {
      display: inline-block;
      background: rgba(128,128,128,0.15);
      border: 1px solid rgba(128,128,128,0.35);
      border-radius: 3px;
      padding: 0 5px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }

    /* Script info lines */
    .line-script_start {
      display: flex; align-items: center; gap: 7px;
      color: var(--vscode-descriptionForeground);
      padding-top: 6px;
    }
    .line-script_done {
      display: flex; align-items: center; gap: 6px;
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
      padding-bottom: 4px;
      font-weight: 500;
    }
    .line-script_done::before { content: '\\2713 '; font-weight: 700; }
    .line-script_error {
      display: flex; align-items: baseline; gap: 8px;
      flex-wrap: wrap;
      color: var(--vscode-terminal-ansiRed, #f44747);
    }

    /* Shared badge styles */
    .error-badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 3px;
      font-size: 0.82em;
      font-weight: 600;
      letter-spacing: 0.3px;
      background: rgba(244, 71, 71, 0.12);
      color: var(--vscode-terminal-ansiRed, #f44747);
      border: 1px solid rgba(244, 71, 71, 0.2);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .error-msg {
      color: var(--vscode-terminal-ansiRed, #f44747);
      opacity: 0.85;
      word-break: break-word;
    }
    .type-badge {
      display: inline-block;
      padding: 0 6px;
      border-radius: 3px;
      font-size: 0.8em;
      font-weight: 500;
      background: rgba(78, 201, 176, 0.08);
      color: var(--vscode-descriptionForeground);
      border: 1px solid rgba(128, 128, 128, 0.15);
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* Eval result */
    .line-result {
      display: flex; align-items: baseline; gap: 7px;
      padding-left: 4px;
    }
    .result-arrow {
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
      font-weight: 700;
      opacity: 0.6;
      font-size: 0.9em;
      flex-shrink: 0;
    }
    .result-val  { color: var(--vscode-terminal-ansiGreen, #4ec9b0); word-break: break-word; }

    /* Eval error */
    .line-error {
      display: flex; align-items: baseline; gap: 8px;
      flex-wrap: wrap;
      padding-left: 4px;
    }

    /* Source preview (shown after errors) */
    .line-source_preview {
      color: var(--vscode-terminal-ansiBrightBlack, #888);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      padding-left: 12px;
      white-space: pre;
      margin-top: -2px;
    }

    /* Plain stdout */
    .line-plain { color: var(--vscode-foreground); }

    /* Input echo */
    .line-input {
      display: flex; align-items: baseline; gap: 6px;
      margin-top: 6px;
      color: var(--vscode-foreground);
      opacity: 0.85;
    }
    .echo-arrow {
      color: #cc342d;
      font-weight: 600;
      font-size: 0.9em;
      flex-shrink: 0;
      opacity: 0.7;
    }

    /* Exit / session end */
    .line-exit { color: var(--vscode-descriptionForeground); font-style: italic; }

    /* Rule line between runs */
    .repl-rule {
      margin: 5px 10px 6px;
      border: none;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }

    /* ── Input bar (Ruby expression) — visually part of Exchange Terminal ──── */
    #input-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      flex-shrink: 0;
      border-top: 1px solid rgba(128,128,128,0.15);
      border-bottom: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      background: var(--vscode-editor-background, rgba(0,0,0,0.2));
    }
    .input-prompt {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(204, 52, 45, 0.08);
      border: 1px solid rgba(204, 52, 45, 0.2);
      color: #cc342d;
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 600;
      font-size: 11px;
      flex-shrink: 0;
      user-select: none;
      letter-spacing: 0.3px;
    }
    .input-chevron {
      opacity: 0.6;
      font-size: 10px;
    }
    #repl-input {
      flex: 1;
      min-height: 28px;
      padding: 5px 10px;
      background: var(--vscode-input-background, rgba(0,0,0,0.25));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 6px;
      outline: none;
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      caret-color: var(--vscode-editorCursor-foreground);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #repl-input:focus {
      border-color: var(--vscode-focusBorder, #007acc);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc), 0 0 8px rgba(0, 122, 204, 0.15);
    }
    #repl-input:disabled { opacity: 0.45; cursor: not-allowed; }
    #repl-input::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6)); }
    #repl-input.evaluating::placeholder { color: var(--vscode-charts-yellow, #d4ac0a); opacity: 0.9; }

    /* ── Eval bar spinner ─────────────────────────────────── */
    #eval-bar-spinner {
      border-top-color: var(--vscode-charts-yellow, #d4ac0a);
      flex-shrink: 0;
    }



    /* ── Session banner ──────────────────────────────────── */
    .session-banner {
      padding: 5px 10px 6px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      overflow: hidden;
    }
    /* Single flex row; height is driven by the SVG — no fixed height set here */
    .banner-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ── Masa Lab logo (black & white) ──────────────────── */
    /* overflow:hidden keeps the SVG self-contained within its declared size */
    .ml-logo { flex-shrink: 0; display: block; overflow: hidden; }
    .ml-tri-solid {
      fill: var(--vscode-foreground, #d4d4d4);
      opacity: 0;
      animation: ml-solid-in 0.5s ease-out 0.1s forwards;
    }
    @keyframes ml-solid-in { from { opacity: 0; } to { opacity: 1; } }
    .ml-tri-outline {
      fill: none;
      stroke: var(--vscode-foreground, #d4d4d4);
      stroke-width: 22;
      stroke-linejoin: miter;
      stroke-dasharray: 1200;
      stroke-dashoffset: 1200;
      animation: ml-draw 1.2s ease-out 0.2s forwards;
    }
    @keyframes ml-draw { to { stroke-dashoffset: 0; } }
    .ml-node {
      fill: var(--vscode-editor-background, #1e1e1e);
      stroke: var(--vscode-foreground, #d4d4d4);
      stroke-width: 20;
    }

    /* Running: logo solid pulses */
    .session-banner.running .ml-tri-solid {
      animation: logo-run-pulse 1.4s ease-in-out infinite;
    }
    @keyframes logo-run-pulse {
      0%, 100% { opacity: 1;    }
      50%       { opacity: 0.35; }
    }
    /* Idle: logo breathes gently */
    .session-banner.idle .ml-tri-solid {
      animation: logo-idle-pulse 2.5s ease-in-out infinite;
    }
    @keyframes logo-idle-pulse {
      0%, 100% { opacity: 1;    }
      50%       { opacity: 0.65; }
    }

    /* ── Fish swim track ────────────────────────────────── */
    /* Height matches the SVG height so fish and logo sit on the same baseline */
    .fish-track {
      flex: 1;
      position: relative;
      height: 26px;
      overflow: hidden;
    }
    /* Vertically centred with top:50% + translateY so it stays aligned with logo */
    .fish-swimmer {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      left: -80px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 0.85em;
      color: var(--vscode-foreground, #d4d4d4);
      white-space: nowrap;
      animation: fish-intro 2.5s ease-in-out 0.6s forwards;
    }
    @keyframes fish-intro { 0% { left: -80px; } 100% { left: 110%; } }

    /* Running: fish loops back and forth */
    .fish-swimmer.running {
      animation: fish-loop 3.0s ease-in-out infinite alternate;
    }
    @keyframes fish-loop {
      0%   { left: 2%;  transform: translateY(-50%); }
      100% { left: 58%; transform: translateY(-50%); }
    }

    /* Idle: fish hovers at a fixed spot and bobs gently */
    .fish-swimmer.idle {
      animation: fish-bob 2.0s ease-in-out infinite;
    }
    @keyframes fish-bob {
      0%, 100% { left: 16%; transform: translateY(-50%);       opacity: 1;    }
      50%       { left: 16%; transform: translateY(calc(-50% - 3px)); opacity: 0.65; }
    }

    /* Evaluating: fish zips urgently back and forth */
    .fish-swimmer.evaluating {
      color: var(--vscode-charts-yellow, #d4ac0a);
      animation: fish-eval 0.6s linear infinite alternate;
    }
    @keyframes fish-eval {
      0%   { left: 3%;  transform: translateY(-50%); }
      100% { left: 54%; transform: translateY(-50%); }
    }

    /* Evaluating: banner logo pulses orange */
    .session-banner.evaluating .ml-tri-solid {
      fill: var(--vscode-charts-yellow, #d4ac0a);
      animation: logo-eval-pulse 0.5s ease-in-out infinite;
    }
    @keyframes logo-eval-pulse {
      0%, 100% { opacity: 1;   }
      50%       { opacity: 0.3; }
    }

    .bubble {
      position: absolute;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 0.65em;
      color: var(--vscode-descriptionForeground, #888);
      pointer-events: none;
      opacity: 0;
      animation: bubble-float 0.8s ease-out forwards;
    }
    @keyframes bubble-float {
      0%   { opacity: 0.7; transform: translateY(0);    }
      100% { opacity: 0;   transform: translateY(-10px); }
    }

    /* ── Brand line ─────────────────────────────────────── */
    .banner-brand {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      opacity: 0;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 0.85em;
      animation: brand-in 0.5s ease-out 3.4s forwards;
    }
    @keyframes brand-in {
      from { opacity: 0; transform: translateY(2px); }
      to   { opacity: 1; transform: none;            }
    }
    .brand-fish { color: var(--vscode-foreground, #d4d4d4); letter-spacing: -1px; }
    .brand-name { color: var(--vscode-foreground, #d4d4d4); font-weight: 600; }
    .brand-dot  { color: var(--vscode-descriptionForeground, #888); margin: 0 3px; }
    .brand-by   { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
  `;

  const html = `
    <!-- Exchange Terminal pane (top) -->
    <div id="repl-pane">
      <div class="pane-hdr">
        Exchange Terminal
        <span class="hdr-spacer"></span>
        <button class="layout-toggle" id="layout-toggle" title="Switch to landscape layout"></button>
        <span class="status-dot" id="status-dot"></span>
      </div>
      <div id="output-log">
        <div id="welcome">
          <div class="welcome-box">
            <div class="welcome-title">Exchange Ruby REPL</div>
            <div>Open a <code>.rb</code> file and press
              <span class="welcome-kbd">Ctrl+Alt+R</span>
              to open a REPL in a new tab. Close the tab to stop the session.
            </div>
          </div>
        </div>
      </div>
      <div id="input-bar">
        <span class="input-prompt">ruby<span class="input-chevron">&gt;&gt;</span></span>
        <input id="repl-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="Type an expression\u2026" disabled />
        <span class="spinner" id="eval-bar-spinner" style="display:none"></span>
      </div>
    </div>

    <!-- Resizer -->
    <div id="resizer"></div>

    <!-- Variables pane (bottom) -->
    <div id="vars-pane">
      <div class="pane-hdr">
        Variables
        <span class="hdr-spacer"></span>
        <span class="spinner" id="vars-spinner" style="display:none"></span>
      </div>
      <div id="vars-body">
        <div class="v-empty">Run a Ruby script to see variables.</div>
      </div>
    </div>
  `;

  const js = `
    const vscode     = acquireVsCodeApi();
    const varsBody   = document.getElementById('vars-body');

    /* ── Per-variable search SVG icon ────────────────────────── */
    var searchSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4"/><line x1="9.5" y1="9.5" x2="14" y2="14"/></svg>';
    var clearSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg>';
    var closeSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';

    /* ── Layout toggle ──────────────────────────────────────── */
    let isLandscape = false;
    const layoutToggle = document.getElementById('layout-toggle');

    function updateLayoutIcon() {
      if (isLandscape) {
        // In landscape — show portrait icon (what clicking will switch to)
        layoutToggle.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="14" height="6.5" rx="1.5" opacity="0.9"/><rect x="1" y="8.5" width="14" height="6.5" rx="1.5" opacity="0.45"/></svg>';
        layoutToggle.title = 'Switch to portrait layout';
      } else {
        // In portrait — show landscape icon (what clicking will switch to)
        layoutToggle.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6.5" height="14" rx="1.5" opacity="0.9"/><rect x="8.5" y="1" width="6.5" height="14" rx="1.5" opacity="0.45"/></svg>';
        layoutToggle.title = 'Switch to landscape layout';
      }
    }

    layoutToggle.addEventListener('click', function() {
      isLandscape = !isLandscape;
      document.body.classList.toggle('landscape', isLandscape);
      updateLayoutIcon();
      // Reset vars pane size so CSS default kicks in
      document.getElementById('vars-pane').style.flex = '';
    });
    updateLayoutIcon();

    /* ── Resizer drag logic (works in both portrait and landscape) ──── */
    (function() {
      const resizer  = document.getElementById('resizer');
      const varsPane = document.getElementById('vars-pane');
      let startPos, startSize;
      resizer.addEventListener('mousedown', (e) => {
        startPos  = isLandscape ? e.clientX : e.clientY;
        startSize = isLandscape
          ? varsPane.getBoundingClientRect().width
          : varsPane.getBoundingClientRect().height;
        resizer.classList.add('dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
      function onMove(e) {
        var pos     = isLandscape ? e.clientX : e.clientY;
        var maxSize = isLandscape ? window.innerWidth - 200 : window.innerHeight - 200;
        var minSize = isLandscape ? 120 : 80;
        var size    = Math.min(Math.max(startSize - (pos - startPos), minSize), maxSize);
        varsPane.style.flex = '0 0 ' + size + 'px';
      }
      function onUp() {
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
    })();
    const outputLog      = document.getElementById('output-log');
    const replInput      = document.getElementById('repl-input');
    const statusDot      = document.getElementById('status-dot');
    const spinner        = document.getElementById('vars-spinner');
    const welcome        = document.getElementById('welcome');
    const evalBarSpinner = document.getElementById('eval-bar-spinner');

    let prevVarMap     = {};   // name -> JSON string of last seen node (for flash detection)
    let cmdHistory     = [];
    let histIdx        = -1;
    let histDraft      = '';
    let bannerShown    = false;
    let sessionRunning = false; // true while a session process is alive
    let sessionBanner  = null;   // current banner DOM element
    let sessionFish    = null;   // current fish DOM element
    let bannerRunTimer = null;  // timeout to switch fish to running after intro

    // ── Input handling ────────────────────────────────────────

    function submit() {
      const text = replInput.value.trim();
      if (!text || replInput.disabled) return;
      if (cmdHistory[0] !== text) cmdHistory.unshift(text);
      if (cmdHistory.length > 200) cmdHistory.pop();
      histIdx = -1; histDraft = '';
      replInput.value = '';
      appendInputEcho(text);
      setInputEnabled(false);
      setEvaluating(true);
      vscode.postMessage({ type: 'send', text: text });
    }

    replInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault(); submit();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (histIdx === -1) histDraft = replInput.value;
        if (histIdx < cmdHistory.length - 1) {
          histIdx++;
          replInput.value = cmdHistory[histIdx];
          setTimeout(function() {
            replInput.setSelectionRange(replInput.value.length, replInput.value.length);
          }, 0);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (histIdx > 0) {
          histIdx--;
          replInput.value = cmdHistory[histIdx];
        } else if (histIdx === 0) {
          histIdx = -1;
          replInput.value = histDraft;
        }
      }
    });

    function setInputEnabled(on) {
      replInput.disabled = !on;
      if (on) replInput.focus();
    }

    function setEvaluating(on) {
      if (on) {
        replInput.classList.add('evaluating');
        replInput.placeholder = 'Evaluating\u2026';
        evalBarSpinner.style.display = 'inline-block';
        statusDot.className = 'status-dot evaluating';
        setFishState('evaluating');
      } else {
        replInput.classList.remove('evaluating');
        replInput.placeholder = 'Type an expression\u2026';
        evalBarSpinner.style.display = 'none';
      }
    }

    // ── Output helpers ────────────────────────────────────────

    function removeWelcome() {
      if (welcome && welcome.parentNode === outputLog) {
        outputLog.removeChild(welcome);
      }
    }

    function scrollBottom() {
      outputLog.scrollTop = outputLog.scrollHeight;
    }

    function appendInputEcho(text) {
      removeWelcome();
      var d = document.createElement('div');
      d.className = 'repl-line line-input';
      var arrow = document.createElement('span');
      arrow.className = 'echo-arrow';
      arrow.textContent = '>';
      var code = document.createElement('span');
      code.textContent = text;
      d.appendChild(arrow);
      d.appendChild(code);
      outputLog.appendChild(d);
      scrollBottom();
    }

    function appendLine(kind, text, resultType) {
      removeWelcome();

      if (kind === 'script_start') {
        var d = document.createElement('div');
        d.className = 'repl-line line-script_start';
        var sp = document.createElement('span');
        sp.className = 'spinner';
        sp.id = 'load-spinner';
        var t = document.createTextNode(' Loading ' + text + '...');
        d.appendChild(sp);
        d.appendChild(t);
        d.id = 'loading-line';
        outputLog.appendChild(d);
        spinner.style.display = 'inline-block';
        scrollBottom();
        return;
      }

      if (kind === 'script_done') {
        // Mutate the loading line in place (no duplicate entry)
        var loadLine = document.getElementById('loading-line');
        if (loadLine) {
          loadLine.className = 'repl-line line-script_done';
          loadLine.textContent = 'Script loaded';
          loadLine.id = '';
        } else {
          var d2 = document.createElement('div');
          d2.className = 'repl-line line-script_done';
          d2.textContent = 'Script loaded';
          outputLog.appendChild(d2);
        }
        spinner.style.display = 'none';
        // Add a visual rule after the script banner
        var hr = document.createElement('hr');
        hr.className = 'repl-rule';
        outputLog.appendChild(hr);
        scrollBottom();
        return;
      }

      if (kind === 'script_error') {
        var loadLine2 = document.getElementById('loading-line');
        if (loadLine2) {
          loadLine2.className = 'repl-line line-script_error';
          loadLine2.innerHTML = '';
          loadLine2.id = '';
          var ci2 = text.indexOf(':');
          if (ci2 > 0 && ci2 < 40) {
            var seBadge = document.createElement('span');
            seBadge.className = 'error-badge';
            seBadge.textContent = text.substring(0, ci2).trim();
            var seMsg = document.createElement('span');
            seMsg.className = 'error-msg';
            seMsg.textContent = text.substring(ci2 + 1).trim();
            loadLine2.appendChild(seBadge);
            loadLine2.appendChild(seMsg);
          } else {
            loadLine2.textContent = text;
          }
        } else {
          var de = document.createElement('div');
          de.className = 'repl-line line-script_error';
          var ci3 = text.indexOf(':');
          if (ci3 > 0 && ci3 < 40) {
            var seBadge2 = document.createElement('span');
            seBadge2.className = 'error-badge';
            seBadge2.textContent = text.substring(0, ci3).trim();
            var seMsg2 = document.createElement('span');
            seMsg2.className = 'error-msg';
            seMsg2.textContent = text.substring(ci3 + 1).trim();
            de.appendChild(seBadge2);
            de.appendChild(seMsg2);
          } else {
            de.textContent = text;
          }
          outputLog.appendChild(de);
        }
        spinner.style.display = 'none';
        scrollBottom();
        return;
      }

      if (kind === 'result') {
        var dr = document.createElement('div');
        dr.className = 'repl-line line-result';
        var rarr = document.createElement('span');
        rarr.className = 'result-arrow';
        rarr.textContent = '=>';
        var val = document.createElement('span');
        val.className = 'result-val';
        val.textContent = text;
        dr.appendChild(rarr);
        dr.appendChild(val);
        if (resultType) {
          var typ = document.createElement('span');
          typ.className = 'type-badge';
          typ.textContent = resultType;
          dr.appendChild(typ);
        }
        outputLog.appendChild(dr);
        scrollBottom();
        return;
      }

      if (kind === 'error') {
        var derr = document.createElement('div');
        derr.className = 'repl-line line-error';
        var eci = text.indexOf(':');
        if (eci > 0 && eci < 40) {
          var eBadge = document.createElement('span');
          eBadge.className = 'error-badge';
          eBadge.textContent = text.substring(0, eci).trim();
          var eMsg = document.createElement('span');
          eMsg.className = 'error-msg';
          eMsg.textContent = text.substring(eci + 1).trim();
          derr.appendChild(eBadge);
          derr.appendChild(eMsg);
        } else {
          derr.textContent = text;
        }
        outputLog.appendChild(derr);
        scrollBottom();
        return;
      }

      var dl = document.createElement('div');
      dl.className = 'repl-line line-' + kind;
      dl.textContent = text;
      outputLog.appendChild(dl);
      scrollBottom();
    }

    // ── Session banner ────────────────────────────────────────

    function setFishState(state) {
      if (!sessionFish) return;
      sessionFish.classList.remove('running', 'idle', 'evaluating');
      if (sessionBanner) sessionBanner.classList.remove('running', 'idle', 'evaluating');
      if (state === 'running') {
        sessionFish.classList.add('running');
        if (sessionBanner) sessionBanner.classList.add('running');
      } else if (state === 'idle') {
        sessionFish.classList.add('idle');
        if (sessionBanner) sessionBanner.classList.add('idle');
        if (bannerRunTimer) { clearTimeout(bannerRunTimer); bannerRunTimer = null; }
      } else if (state === 'evaluating') {
        sessionFish.classList.add('evaluating');
        if (sessionBanner) sessionBanner.classList.add('evaluating');
        if (bannerRunTimer) { clearTimeout(bannerRunTimer); bannerRunTimer = null; }
      }
    }

    function appendBanner() {
      bannerShown   = true;
      sessionBanner = null;
      sessionFish   = null;
      if (bannerRunTimer) { clearTimeout(bannerRunTimer); bannerRunTimer = null; }
      removeWelcome();

      var banner = document.createElement('div');
      banner.className = 'session-banner';

      // Top row: Masa Lab logo SVG + fish swim track
      var top = document.createElement('div');
      top.className = 'banner-top';

      // Inline Masa Lab logo — two rightward-pointing triangles + node circles.
      // viewBox is padded by 50px on all sides beyond the outermost circle edges
      // so no circle is ever clipped. Display at 43×26px (aspect ≈ 1.65:1).
      // r=45 gives clearly visible nodes at that display size.
      var logoWrap = document.createElement('span');
      logoWrap.innerHTML =
        '<svg class="ml-logo" xmlns="http://www.w3.org/2000/svg" viewBox="5 0 850 550" width="43" height="26">' +
          '<polygon class="ml-tri-solid"   points="430,90 759.09,280 430,470"/>' +
          '<polygon class="ml-tri-outline" points="100.91,90 430,280 100.91,470"/>' +
          '<circle class="ml-node" cx="430"    cy="90"  r="45"/>' +
          '<circle class="ml-node" cx="100.91" cy="90"  r="45"/>' +
          '<circle class="ml-node" cx="430"    cy="280" r="45"/>' +
          '<circle class="ml-node" cx="100.91" cy="470" r="45"/>' +
          '<circle class="ml-node" cx="430"    cy="470" r="45"/>' +
          '<circle class="ml-node" cx="759.09" cy="280" r="45"/>' +
        '</svg>';

      // Fish swim track — fish swims out of the logo rightward
      var track = document.createElement('div');
      track.className = 'fish-track';
      var fish = document.createElement('span');
      fish.className = 'fish-swimmer';
      fish.textContent = '><(((\u00ba>';   // ><(((º>
      track.appendChild(fish);

      // Bubbles timed to match the intro animation (delay 0.6s, duration 2.5s)
      var swimStartMs = 600;
      var swimDurMs   = 2500;
      var numBubbles  = 7;
      for (var bi = 0; bi < numBubbles; bi++) {
        (function(i) {
          var frac  = i / numBubbles;
          var delay = swimStartMs + Math.round(frac * swimDurMs);
          setTimeout(function() {
            if (!fish.parentNode) return;
            var tw = track.getBoundingClientRect().width || 400;
            var b  = document.createElement('span');
            b.className   = 'bubble';
            b.style.left  = Math.round(frac * tw * 0.88) + 'px';
            b.style.top   = Math.round(6 + Math.random() * 8) + 'px';
            b.textContent = '\u00b0';   // °
            track.appendChild(b);
          }, delay);
        })(bi);
      }

      top.appendChild(logoWrap);
      top.appendChild(track);

      // Brand line — fades in after fish exits (matches brand-in CSS delay 6.3s)
      var brand = document.createElement('div');
      brand.className = 'banner-brand';
      [
        { cls: 'brand-fish', text: '><(\u00ba>'        },
        { cls: 'brand-name', text: 'Exchange REPL'     },
        { cls: 'brand-dot',  text: '\u00b7'            },
        { cls: 'brand-by',   text: 'by Masa Lab'       }
      ].forEach(function(p) {
        var s = document.createElement('span');
        s.className   = p.cls;
        s.textContent = p.text;
        brand.appendChild(s);
      });

      banner.appendChild(top);
      banner.appendChild(brand);
      outputLog.appendChild(banner);
      scrollBottom();

      // Store references for state switching
      sessionBanner = banner;
      sessionFish   = fish;

      // After the intro swim completes, switch to the running loop animation.
      // Total intro: 0.6s delay + 2.5s duration + 200ms buffer = 3300ms
      bannerRunTimer = setTimeout(function() {
        bannerRunTimer = null;
        setFishState('running');
      }, swimStartMs + swimDurMs + 200);
    }

    // ── Variables rendering ───────────────────────────────────

    function makeVarNode(name, data, depth, changedSet) {
      var hasKids = data.children && Object.keys(data.children).length > 0;
      var wrap = document.createElement('div');
      var row  = document.createElement('div');
      row.className = 'v-row' + (hasKids ? ' expandable' : '');

      if (changedSet && changedSet[name]) {
        row.classList.add('v-flash');
        row.addEventListener('animationend', function() {
          row.classList.remove('v-flash');
        }, { once: true });
      }

      for (var i = 0; i < depth; i++) {
        var ind = document.createElement('span');
        ind.className = 'v-indent';
        row.appendChild(ind);
      }

      var tog = document.createElement('span');
      tog.className = 'v-toggle';
      tog.textContent = hasKids ? '\u25b6' : '';
      row.appendChild(tog);

      var nm = document.createElement('span');
      nm.className = 'v-name';
      nm.textContent = name;
      var col = document.createElement('span');
      col.className = 'v-colon';
      col.textContent = ':';
      var vv = document.createElement('span');
      vv.className = 'v-value';
      vv.textContent = data.value;
      var ty = document.createElement('span');
      ty.className = 'v-type';
      ty.textContent = data.type;

      row.appendChild(nm);
      row.appendChild(col);
      row.appendChild(vv);
      row.appendChild(ty);

      // Search button for any expandable variable with children (right side)
      if (hasKids) {
        var searchBtn = document.createElement('span');
        searchBtn.className = 'v-search-btn';
        searchBtn.title = 'Filter properties of ' + name;
        searchBtn.innerHTML = searchSvg;
        row.appendChild(searchBtn);
      }
      wrap.appendChild(row);

      if (hasKids) {
        // Search bar (hidden by default)
        var searchBar = document.createElement('div');
        searchBar.className = 'v-search-bar';
        searchBar.style.display = 'none';
        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Filter ' + name + ' properties\u2026';
        searchInput.spellcheck = false;
        var searchCount = document.createElement('span');
        searchCount.className = 'v-search-count';
        var searchClear = document.createElement('span');
        searchClear.className = 'v-search-clear';
        searchClear.title = 'Clear search text';
        searchClear.innerHTML = clearSvg;
        var searchClose = document.createElement('span');
        searchClose.className = 'v-search-close';
        searchClose.title = 'Close search bar';
        searchClose.innerHTML = closeSvg;
        searchBar.appendChild(searchInput);
        searchBar.appendChild(searchCount);
        searchBar.appendChild(searchClear);
        searchBar.appendChild(searchClose);
        wrap.appendChild(searchBar);

        var kids = document.createElement('div');
        kids.className = 'v-kids';
        Object.keys(data.children).forEach(function(k) {
          kids.appendChild(makeVarNode(k, data.children[k], depth + 1, null));
        });
        wrap.appendChild(kids);

        // Filter function for this variable's children
        function filterKids(query) {
          var q = query.toLowerCase().trim();
          var childWraps = kids.querySelectorAll(':scope > div');
          var matchCount = 0;
          var totalCount = childWraps.length;
          for (var ci = 0; ci < childWraps.length; ci++) {
            var nameEl = childWraps[ci].querySelector('.v-name');
            var valEl  = childWraps[ci].querySelector('.v-value');
            var childName  = nameEl ? nameEl.textContent.toLowerCase() : '';
            var childValue = valEl  ? valEl.textContent.toLowerCase()  : '';
            if (!q || childName.indexOf(q) !== -1 || childValue.indexOf(q) !== -1) {
              childWraps[ci].classList.remove('v-filter-hidden');
              matchCount++;
            } else {
              childWraps[ci].classList.add('v-filter-hidden');
            }
          }
          searchCount.textContent = q ? (matchCount + ' / ' + totalCount) : '';
        }

        // Toggle search bar
        if (hasKids) {
          searchBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var visible = searchBar.style.display !== 'none';
            searchBar.style.display = visible ? 'none' : 'flex';
            if (!visible) {
              // Auto-expand if collapsed
              if (!kids.classList.contains('open')) {
                kids.classList.add('open');
                tog.textContent = '\u25bc';
              }
              searchInput.focus();
            } else {
              searchInput.value = '';
              filterKids('');
              searchClear.style.display = 'none';
            }
          });
        }

        searchInput.addEventListener('input', function() {
          filterKids(this.value);
          searchClear.style.display = this.value ? 'inline-flex' : 'none';
        });

        searchClear.addEventListener('click', function() {
          searchInput.value = '';
          filterKids('');
          searchClear.style.display = 'none';
          searchInput.focus();
        });

        searchClose.addEventListener('click', function() {
          searchBar.style.display = 'none';
          searchInput.value = '';
          filterKids('');
          searchClear.style.display = 'none';
        });

        searchInput.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            searchBar.style.display = 'none';
            searchInput.value = '';
            filterKids('');
            searchClear.style.display = 'none';
          }
        });

        // Prevent clicks on search bar from toggling expand/collapse
        searchBar.addEventListener('click', function(e) {
          e.stopPropagation();
        });

        row.addEventListener('click', function(e) {
          var open = kids.classList.toggle('open');
          tog.textContent = open ? '\u25bc' : '\u25b6';
        });
      }
      return wrap;
    }

    function renderVars(vars) {
      var keys = Object.keys(vars || {});
      if (!keys.length) {
        varsBody.innerHTML = '<div class="v-empty">No variables defined yet.</div>';
        prevVarMap = {};
        return;
      }
      var changed = {};
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var serial = JSON.stringify(vars[k]);
        if (prevVarMap[k] !== undefined && prevVarMap[k] !== serial) changed[k] = true;
        prevVarMap[k] = serial;
      }
      varsBody.innerHTML = '';
      for (var j = 0; j < keys.length; j++) {
        varsBody.appendChild(makeVarNode(keys[j], vars[keys[j]], 0, changed));
      }
    }

    // ── Output line cap ───────────────────────────────────────

    function trimOutputLog() {
      var MAX_LINES = 2000;
      var lines = outputLog.querySelectorAll('.repl-line, .repl-rule');
      if (lines.length > MAX_LINES) {
        for (var ti = 0; ti < lines.length - MAX_LINES; ti++) {
          if (lines[ti].parentNode) lines[ti].parentNode.removeChild(lines[ti]);
        }
      }
    }

    // ── Message handler ───────────────────────────────────────

    window.addEventListener('message', function(e) {
      var msg = e.data;
      switch (msg.type) {
        case 'clear':
          sessionRunning = false;
          bannerShown = false;
          sessionBanner = null;
          sessionFish   = null;
          if (bannerRunTimer) { clearTimeout(bannerRunTimer); bannerRunTimer = null; }
          outputLog.innerHTML = '';
          outputLog.appendChild(welcome);
          varsBody.innerHTML = '<div class="v-empty">Run a Ruby script to see variables.</div>';
          prevVarMap = {};
          spinner.style.display = 'none';
          statusDot.className = 'status-dot';
          setEvaluating(false);
          setInputEnabled(false);
          break;

        case 'output':
          appendLine(msg.kind, msg.text, msg.resultType);
          if (msg.kind === 'script_done' || msg.kind === 'script_error') {
            setFishState('idle');
          }
          break;

        case 'output-batch':
          for (var bi = 0; bi < msg.lines.length; bi++) {
            var bl = msg.lines[bi];
            appendLine(bl.kind, bl.text, bl.resultType);
          }
          trimOutputLog();
          break;

        case 'vars':
          renderVars(msg.vars);
          break;

        case 'ready':
          setEvaluating(false);
          statusDot.className = 'status-dot ready';
          setInputEnabled(true);
          setFishState('idle');
          break;

        case 'status':
          if (msg.running) {
            sessionRunning = true;
            statusDot.className = 'status-dot running';
            if (!bannerShown) appendBanner();
          } else {
            sessionRunning = false;
            setEvaluating(false);
            statusDot.className = 'status-dot';
            setInputEnabled(false);
            spinner.style.display = 'none';
          }
          break;
      }
    });

    // Signal to the extension that the webview is ready
    vscode.postMessage({ type: 'ready' });
  `;

  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
    '<style>' + css + '</style></head>' +
    '<body>' + html +
    '<script>' + js + '<\/script>' +
    '</body></html>'
  );
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'icmRepl.selectExecutable';
  statusBarItem.tooltip = 'Click to select ICM Exchange executable';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(statusBarItem, readIcmPathSetting());
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('icmRepl.icmExchangePath')) {
        updateStatusBar(statusBarItem, readIcmPathSetting());
      }
    })
  );

  const scriptsDir = getScriptsDir(context);
  const icmPath    = readIcmPathSetting();
  if (icmPath) writeIcmPathFile(scriptsDir, icmPath);

  context.subscriptions.push(
    vscode.commands.registerCommand('icmRepl.runRubyInIcm', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Exchange REPL: No active editor. Open a .rb file first.');
        return;
      }
      const filePath = editor.document.uri.fsPath;
      if (!filePath.toLowerCase().endsWith('.rb')) {
        vscode.window.showWarningMessage('Exchange REPL: The active file is not a Ruby (.rb) file.');
        return;
      }
      await editor.document.save();
      const exePath = await ensureExePath(context, statusBarItem);
      if (!exePath) return;

      const title = 'Exchange REPL: ' + path.basename(filePath);
      const panel = vscode.window.createWebviewPanel(
        'icmRepl.repl',
        title,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const session = new ReplEditorSession(panel, filePath, exePath, context);
      session.startRepl();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('icmRepl.runRubyInIcmChooseExe', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Exchange REPL: No active editor. Open a .rb file first.');
        return;
      }
      const filePath = editor.document.uri.fsPath;
      if (!filePath.toLowerCase().endsWith('.rb')) {
        vscode.window.showWarningMessage('Exchange REPL: The active file is not a Ruby (.rb) file.');
        return;
      }
      await editor.document.save();
      const exePath = await promptSelectExecutable(context, statusBarItem);
      if (!exePath) return;

      const title = 'Exchange REPL: ' + path.basename(filePath);
      const panel = vscode.window.createWebviewPanel(
        'icmRepl.repl',
        title,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const session = new ReplEditorSession(panel, filePath, exePath, context);
      session.startRepl();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('icmRepl.selectExecutable',
      () => promptSelectExecutable(context, statusBarItem))
  );

  context.subscriptions.push({
    dispose() {
      for (const session of activeReplSessions) {
        session.dispose();
      }
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
