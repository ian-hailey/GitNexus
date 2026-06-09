#!/usr/bin/env node
/**
 * GitNexus Cline Hook — Self-Contained
 *
 * PostToolUse hook for Cline CLI that enriches Grep/Glob/Bash tool calls
 * with graph context from the GitNexus index.
 *
 * This file is self-contained and calls gitnexus directly via subprocess.
 * It includes all logic inline to work when installed globally (e.g., ~/.cline/hooks/).
 *
 * Install: copy this file to <project>/.cline/hooks/PostToolUse.js
 *    or:  ln -s ~/.cline/hooks/PostToolUse.js <project>/.cline/hooks/
 */

// ============================================================================
// LOCK ACQUISITION (from hook-lock.js)
// ============================================================================

const HOOK_LOCK_SUBDIR = '.hook-locks';
const HOOK_LOCK_MAX_INFLIGHT = 3;
const HOOK_LOCK_STALE_MS = 30000;

function acquireHookSlot(gitNexusDir) {
  const lockDir = path.join(gitNexusDir, HOOK_LOCK_SUBDIR);
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch {
    return null;
  }

  const myPidStr = String(process.pid);

  for (let slot = 0; slot < HOOK_LOCK_MAX_INFLIGHT; slot++) {
    const slotPath = path.join(lockDir, `slot-${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(slotPath, myPidStr, { flag: 'wx' });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try {
            const content = fs.readFileSync(slotPath, 'utf-8').trim();
            if (content === myPidStr) fs.unlinkSync(slotPath);
          } catch {}
        };
        process.on('exit', release);
        return release;
      } catch {
        let fd;
        try {
          fd = fs.openSync(slotPath, 'r');
        } catch {
          continue;
        }
        let isLive = false;
        let mtimeMs = Date.now();
        try {
          mtimeMs = fs.fstatSync(fd).mtimeMs;
          const buf = Buffer.alloc(32);
          const n = fs.readSync(fd, buf, 0, 32, 0);
          const ownerStr = buf.slice(0, n).toString('utf-8').trim();
          if (ownerStr === '') {
            isLive = true;
          } else {
            const owner = Number.parseInt(ownerStr, 10);
            if (Number.isFinite(owner) && owner > 0) {
              try {
                process.kill(owner, 0);
                isLive = true;
              } catch (e) {
                isLive = e.code !== 'ESRCH';
              }
            }
          }
        } catch {} finally {
          try { fs.closeSync(fd); } catch {}
        }
        if (isLive && Date.now() - mtimeMs > HOOK_LOCK_STALE_MS) {
          isLive = false;
        }
        if (isLive) break;
        try {
          fs.unlinkSync(slotPath);
        } catch {}
      }
    }
  }
  return null;
}

// ============================================================================
// DB LOCK DETECTION (from hook-db-lock-probe.cjs)
// ============================================================================

function isGitNexusServerCommand(command) {
  const hasServerMode = /(?:^|\s)(mcp|serve)(?:\s|$)/.test(command);
  const hasGitNexus =
    /(?:^|[/\\s])gitnexus(?:\.cmd)?(?:\s|$)/.test(command) ||
    /node_modules[/\\]gitnexus[/\\]/.test(command);
  return hasServerMode && hasGitNexus;
}

function resolveHookBinary(tool) {
  const candidates =
    tool === 'lsof'
      ? ['/usr/bin/lsof', '/usr/sbin/lsof', '/sbin/lsof', tool]
      : ['/bin/ps', '/usr/bin/ps', tool];
  for (const candidate of candidates) {
    if (candidate === tool) return tool;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return tool;
}

function readLinuxCmdline(pidStr) {
  try {
    return fs.readFileSync(`/proc/${pidStr}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
  } catch {
    return '';
  }
}

function linuxProcScanFindGitNexusServer(dbPathAbs, myPid) {
  const budget = Number(process.env.GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS) || 1200;
  const start = Date.now();
  let targetStat;
  try {
    targetStat = fs.statSync(dbPathAbs);
  } catch {
    return false;
  }
  let procEntries;
  try {
    procEntries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of procEntries) {
    if (Date.now() - start > budget) return false;
    if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
    const pid = Number.parseInt(ent.name, 10);
    if (!Number.isFinite(pid) || pid === myPid) continue;
    const fdDir = path.join('/proc', ent.name, 'fd');
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    let holds = false;
    for (const fd of fds) {
      if (Date.now() - start > budget) return false;
      try {
        const st = fs.statSync(path.join(fdDir, fd));
        if (st.dev === targetStat.dev && st.ino === targetStat.ino) {
          holds = true;
          break;
        }
      } catch {}
    }
    if (!holds) continue;
    if (isGitNexusServerCommand(readLinuxCmdline(ent.name))) return true;
  }
  return false;
}

function unixLsofPsFindGitNexusServer(dbPathAbs, myPid) {
  const lsofPath = resolveHookBinary('lsof');
  const lsof = spawnSync(lsofPath, ['-nP', '-t', '--', dbPathAbs], {
    encoding: 'utf-8',
    timeout: 1000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (lsof.error) return lsof.error.code === 'ETIMEDOUT';

  const pids = (lsof.stdout || '').split(/\s+/).filter(Boolean);
  const psPath = resolveHookBinary('ps');
  for (const pid of pids) {
    if (Number(pid) === myPid) continue;
    const ps = spawnSync(psPath, ['-p', pid, '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (ps.error) {
      if (ps.error.code === 'ETIMEDOUT') return true;
      continue;
    }
    if (isGitNexusServerCommand(ps.stdout || '')) return true;
  }
  return false;
}

function hasGitNexusDbLockedByGitNexusServer(dbPath, myPid) {
  if (!fs.existsSync(dbPath)) return false;
  const dbPathAbs = path.resolve(dbPath);

  if (process.platform === 'linux') {
    if (linuxProcScanFindGitNexusServer(dbPathAbs, myPid)) return true;
    return unixLsofPsFindGitNexusServer(dbPathAbs, myPid);
  }

  return unixLsofPsFindGitNexusServer(dbPathAbs, myPid);
}

// ============================================================================
// INVOCATION RESOLUTION (from resolve-analyze-cmd.cjs)
// ============================================================================

const NPX_REF = 'gitnexus@latest';

function resolveOnPath(command) {
  const pathValue = process.env.PATH || '';
  if (!pathValue) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`))
    : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function probeVersion(command) {
  try {
    const output = spawnSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const versionLine = (output.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^v?\d+\.\d+/.test(l));
    const match = versionLine ? versionLine.match(/^v?(\d+)\.(\d+)/) : null;
    return {
      major: match ? Number(match[1]) : null,
      minor: match ? Number(match[2]) : null,
    };
  } catch {
    return { major: null, minor: null };
  }
}

function getNpmMajorVersion() {
  return probeVersion('npm').major;
}

function resolveInvocationMode() {
  const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') {
    return forced;
  }
  if (resolveOnPath('gitnexus')) return 'gitnexus';

  const npmMajor = getNpmMajorVersion();
  const hasPnpm = Boolean(resolveOnPath('pnpm'));

  if (hasPnpm && npmMajor !== null && npmMajor >= 11) return 'pnpm';
  if (npmMajor !== null && npmMajor < 11) return 'npx';
  if (hasPnpm) return 'pnpm';

  return 'npx';
}

function formatAnalyzeCommand(options = {}) {
  const suffix = options.embeddings ? ' --embeddings' : '';
  const mode = resolveInvocationMode();
  if (mode === 'gitnexus') return `gitnexus analyze${suffix}`;
  if (mode === 'pnpm') return `pnpm dlx ${NPX_REF} analyze${suffix}`;
  return `npx ${NPX_REF} analyze${suffix}`;
}

// ============================================================================
// CORE HOOK LOGIC
// ============================================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Read JSON input from stdin synchronously.
 */
function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Find the .gitnexus directory by walking up from startDir.
 */
function isGlobalRegistryDir(candidate) {
  if (fs.existsSync(path.join(candidate, 'meta.json'))) return false;
  return (
    fs.existsSync(path.join(candidate, 'registry.json')) ||
    fs.existsSync(path.join(candidate, 'repos'))
  );
}

function walkForGitNexusDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) {
      if (!isGlobalRegistryDir(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the canonical worktree root for `cwd`.
 */
function findCanonicalRepoRoot(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8',
      timeout: 2000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    const commonDir = (result.stdout || '').trim();
    if (!commonDir || !path.isAbsolute(commonDir)) return null;
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

function findGitNexusDir(startDir) {
  const cwd = startDir || process.cwd();
  const fromCwd = walkForGitNexusDir(cwd);
  if (fromCwd) return fromCwd;

  const canonicalRoot = findCanonicalRepoRoot(cwd);
  if (canonicalRoot && canonicalRoot !== cwd) {
    return walkForGitNexusDir(canonicalRoot);
  }
  return null;
}

/**
 * Run gitnexus CLI command synchronously.
 */
function runGitNexus(args, cwd) {
  const isWin = process.platform === 'win32';

  // Check for direct binary
  const which = spawnSync(isWin ? 'where' : 'which', ['gitnexus'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const useDirectBinary = which.status === 0 && which.stdout.includes('gitnexus');

  if (useDirectBinary) {
    return spawnSync(isWin ? 'gitnexus.cmd' : 'gitnexus', args, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  // Fall back to npx
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * Extract search pattern from tool input.
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      '-e', '-f', '-m', '-A', '-B', '-C', '-g', '--glob',
      '-t', '--type', '--include', '--exclude',
    ]);

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      return token;
    }
  }

  return null;
}

/**
 * Check if output suggests a stale index.
 */
function needsReindex(output, toolName) {
  const staleMessages = [
    'index is stale',
    'index outdated',
    'run gitnexus analyze',
    'gitnexus analyze',
  ];

  if (toolName === 'Bash') {
    // Only check Bash output for git commands that modify the index
    const cmd = arguments?.tool_result?.input?.command || '';
    const gitMutations = /\bgit\s+(add|commit|push|pull|merge|rebase|checkout|reset|restore|clean)\b/;
    if (!gitMutations.test(cmd)) return false;
  }

  const lower = (output || '').toLowerCase();
  return staleMessages.some((msg) => lower.includes(msg));
}

/**
 * Extract augmentation context from stderr.
 */
function extractAugmentContext(stderr) {
  const output = (stderr || '').trim();
  const marker = output.indexOf('[GitNexus]');
  const debug = process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true';
  if (debug && output.length > 0) {
    const discarded = marker === -1 ? output : output.slice(0, marker).trim();
    if (discarded.length > 0) {
      process.stderr.write(`[GitNexus hook] augment stderr discarded:\n${discarded}\n`);
    }
  }
  return marker === -1 ? '' : output.slice(marker).trim();
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const input = readInput();
  const { hookName, tool_result, cwd: inputCwd } = input;
  const toolName = tool_result?.name;
  const toolOutput = typeof tool_result?.output === 'string'
    ? tool_result.output
    : JSON.stringify(tool_result?.output || '');

  if (hookName !== 'tool_result' || !toolName) {
    return;
  }

  const supportedTools = ['Grep', 'Glob', 'Bash'];
  if (!supportedTools.includes(toolName)) {
    return;
  }

  const cwd = inputCwd || process.cwd();
  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) {
    return;
  }

  // Check for GitNexus server lock
  const dbPath = path.join(gitNexusDir, 'lbug');
  if (hasGitNexusDbLockedByGitNexusServer(dbPath, process.pid)) {
    return;
  }

  // Acquire hook slot
  const release = acquireHookSlot(gitNexusDir);
  if (!release) {
    return;
  }

  try {
    const pattern = extractPattern(toolName, tool_result?.input || {});
    if (!pattern) {
      return;
    }

    const augmentArgs = ['augment', '--pattern', pattern, '--context', '2'];
    const result = runGitNexus(augmentArgs, cwd);

    if (result.error) {
      if (process.env.GITNEXUS_DEBUG) {
        process.stderr.write(`[GitNexus hook] augment error: ${result.error.message}\n`);
      }
      return;
    }

    const augmentContext = extractAugmentContext(result.stderr);
    if (!augmentContext) {
      // Check if we need to reindex
      if (needsReindex(toolOutput, toolName)) {
        const analyzeCmd = formatAnalyzeCommand();
        const msg = `\n[GitNexus] Index may be stale. Run: ${analyzeCmd}\n`;
        console.log(JSON.stringify({ contextModification: msg }));
      }
      return;
    }

    // Check for stale index
    let finalContext = augmentContext;
    if (needsReindex(toolOutput, toolName)) {
      const analyzeCmd = formatAnalyzeCommand();
      finalContext += `\n[GitNexus] Index may be stale. Run: ${analyzeCmd}\n`;
    }

    console.log(JSON.stringify({ contextModification: finalContext }));
  } finally {
    release();
  }
}

main();