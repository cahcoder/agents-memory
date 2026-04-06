#!/usr/bin/env node
/**
 * install-seamless.js - Install agents-memory daemon + OpenClaw managed hook
 * 
 * This is the post-install step that runs after `npm install -g agents-memory`
 * 
 * What it does:
 * 1. Installs daemon systemd service (Type=forking + PIDFile)
 * 2. Installs OpenClaw managed hook at ~/.openclaw/hooks/agents-memory/
 * 3. Auto-configures OpenClaw to use the hook
 * 4. Auto-reloads OpenClaw gateway
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const PLUGIN_ID = 'agents-memory';
const SERVICE_NAME = 'agents-memory-daemon';

// Paths
const MEMORY_DIR = path.join(HOME, '.memory', 'agents-memory');
const PID_FILE = path.join(MEMORY_DIR, 'daemon.pid');
const SOCKET_FILE = path.join(MEMORY_DIR, 'daemon.sock');
const OPENCLAW_HOOKS_DIR = path.join(HOME, '.openclaw', 'hooks');
const OPENCLAW_HOOK_DIR = path.join(OPENCLAW_HOOKS_DIR, PLUGIN_ID);
const OPENCLAW_CONFIG = path.join(HOME, '.openclaw', 'openclaw.json');

// Resolve package root dynamically
function getPackageRoot() {
  // 1. Try npm global prefix
  try {
    const globalPrefix = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const globalPath = path.join(globalPrefix, 'agents-memory');
    if (fs.existsSync(path.join(globalPath, 'scripts', 'memory_daemon.py'))) {
      return globalPath;
    }
  } catch (e) {}

  // 2. Try __dirname (scripts/ -> package root)
  if (__dirname) {
    const scriptsDir = path.dirname(__dirname);
    if (fs.existsSync(path.join(scriptsDir, 'scripts', 'memory_daemon.py'))) {
      return scriptsDir;
    }
  }

  // 3. Environment variable
  if (process.env.AGENTS_MEMORY_ROOT) {
    return process.env.AGENTS_MEMORY_ROOT;
  }

  throw new Error(
    'Cannot find agents-memory package.\n' +
    'Try: npm install -g agents-memory'
  );
}

// ───────────────────────────────────────────────────────────────
// SYSTEMD SERVICE (Type=forking + PIDFile)
// ───────────────────────────────────────────────────────────────
function getSystemdUnit(daemonScript) {
  return `[Unit]
Description=Agents Memory Daemon (semantic memory for AI CLI tools)
After=network.target

[Service]
Type=forking
PIDFile=${PID_FILE}
ExecStartPre=/bin/mkdir -p ${MEMORY_DIR}
ExecStart=/usr/bin/python3 ${daemonScript} --daemon
ExecStop=/bin/kill -TERM $MAINPID
Environment="AGENTS_MEMORY_RUNTIME_DIR=${MEMORY_DIR}"
Environment="PYTHONPATH=${getPackageRoot()}/scripts"
Environment="AGENTS_MEMORY_PRODUCTION=1"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target`;
}

function installDaemon() {
  const PKG = getPackageRoot();
  const DAEMON_SCRIPT = path.join(PKG, 'scripts', 'memory_daemon.py');
  const SERVICE_FILE = path.join(HOME, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);

  console.log('\n[1/4] Installing daemon service...');
  console.log(`  Package root: ${PKG}`);
  console.log(`  Daemon script: ${DAEMON_SCRIPT}`);
  console.log(`  Memory dir: ${MEMORY_DIR}`);
  console.log(`  Socket: ${SOCKET_FILE}`);

  // Ensure memory directory
  fs.mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });

  // Write systemd unit (Type=forking is critical for auto-restart)
  fs.writeFileSync(SERVICE_FILE, getSystemdUnit(DAEMON_SCRIPT));
  console.log(`  Service file: ${SERVICE_FILE}`);

  // Enable and start
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable ${SERVICE_NAME}.service`, { stdio: 'pipe' });
    execSync(`systemctl --user start ${SERVICE_NAME}.service`, { stdio: 'pipe' });
    console.log('  ✅ Daemon service installed and started');
    return true;
  } catch (e) {
    try {
      execSync(`systemctl --user restart ${SERVICE_NAME}.service`, { stdio: 'pipe' });
      console.log('  ✅ Daemon service restarted');
      return true;
    } catch (e2) {
      console.log('  ⚠️  Could not start systemd service');
      console.log('      Manual start: agents-memory daemon-start');
      return false;
    }
  }
}

// ───────────────────────────────────────────────────────────────
// OPENCLAW MANAGED HOOK (NOT plugin)
// ───────────────────────────────────────────────────────────────
function installOpenClawHook() {
  const PKG = getPackageRoot();
  const HOOK_SRC = path.join(PKG, 'hook-packs', 'agents-memory');
  const HOOK_SRC_LEGACY = path.join(PKG, 'hooks', 'agents-memory'); // fallback

  console.log('\n[2/4] Installing OpenClaw managed hook...');
  console.log(`  Source: ${HOOK_SRC}`);

  // Check if hook-packs exists
  if (!fs.existsSync(HOOK_SRC)) {
    console.log('  ⚠️  hook-packs/agents-memory not found in package');
    // Try legacy location
    if (fs.existsSync(HOOK_SRC_LEGACY)) {
      console.log(`  Trying legacy: ${HOOK_SRC_LEGACY}`);
    } else {
      console.log('  ⚠️  No hook source found - managed hook not installed');
      return false;
    }
  }

  // Ensure hooks directory
  fs.mkdirSync(OPENCLAW_HOOKS_DIR, { recursive: true });
  fs.mkdirSync(OPENCLAW_HOOK_DIR, { recursive: true });

  // Copy hook files (dereference symlinks to avoid symlink issues)
  const srcDir = fs.existsSync(HOOK_SRC) ? HOOK_SRC : HOOK_SRC_LEGACY;
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    const src = path.join(srcDir, file);
    const dst = path.join(OPENCLAW_HOOK_DIR, file);
    if (fs.statSync(src).isDirectory()) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
  console.log(`  ✅ Hook installed to: ${OPENCLAW_HOOK_DIR}`);
  console.log('  ✅ Files: HOOK.md, handler.js');

  // Verify critical files
  const required = ['HOOK.md', 'handler.js'];
  for (const f of required) {
    const fp = path.join(OPENCLAW_HOOK_DIR, f);
    if (!fs.existsSync(fp)) {
      console.log(`  ⚠️  Missing: ${f}`);
    }
  }

  return true;
}

// ───────────────────────────────────────────────────────────────
// AUTO-CONFIGURE OPENCLAW
// ───────────────────────────────────────────────────────────────
function installOpenClawConfig() {
  console.log('\n[3/4] Configuring OpenClaw...');

  // Ensure config structure
  let config = {};
  if (fs.existsSync(OPENCLAW_CONFIG)) {
    try {
      const content = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
      config = JSON.parse(content);
    } catch (e) {
      console.log('  ⚠️  Could not parse existing openclaw.json - creating new');
    }
  }

  // Ensure nested structure
  if (!config.hooks) config.hooks = {};
  if (!config.hooks.internal) config.hooks.internal = {};
  if (!config.hooks.internal.entries) config.hooks.internal.entries = {};

  // Add agents-memory hook entry (NOT in plugins!)
  config.hooks.internal.entries['agents-memory'] = { enabled: true };

  // Remove any stale plugin entries for agents-memory
  if (config.plugins && config.plugins.entries && config.plugins.entries['agents-memory']) {
    delete config.plugins.entries['agents-memory'];
    console.log('  ℹ️  Removed stale plugins.entries.agents-memory (not a plugin)');
  }

  // Write updated config
  try {
    fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
    console.log('  ✅ Config updated: hooks.internal.entries.agents-memory');
    return true;
  } catch (e) {
    console.log(`  ⚠️  Could not write openclaw.json: ${e.message}`);
    console.log('  ℹ️  Manual config required - see below');
    return false;
  }
}

// ───────────────────────────────────────────────────────────────
// RELOAD OPENCLAW GATEWAY
// ───────────────────────────────────────────────────────────────
function reloadOpenClaw() {
  console.log('\n[4/4] Reloading OpenClaw gateway...');

  try {
    // Send SIGHUP to gateway for config reload
    const pidResult = execSync('pgrep -f "openclaw-gateway" | head -1', { encoding: 'utf8' }).trim();
    if (pidResult) {
      process.kill(parseInt(pidResult), 'SIGHUP');
      console.log('  ✅ Gateway reload signaled');
      return true;
    }
  } catch (e) {
    // Gateway might not be running, try restart
  }

  try {
    execSync('systemctl --user restart openclaw-gateway.service', { stdio: 'pipe' });
    console.log('  ✅ Gateway restarted via systemd');
    return true;
  } catch (e) {
    try {
      execSync('nohup openclaw gateway restart > /dev/null 2>&1 &', { stdio: 'pipe', shell: '/bin/bash' });
      console.log('  ✅ Gateway restart initiated');
      return true;
    } catch (e2) {
      console.log('  ⚠️  Could not reload gateway');
      console.log('      Manual: nohup openclaw gateway restart > /dev/null 2>&1 &');
      return false;
    }
  }
}

// ───────────────────────────────────────────────────────────────
// COPY SKILL FILES
// ───────────────────────────────────────────────────────────────
function installSkill() {
  const PKG = getPackageRoot();
  const SKILL_DIR = path.join(PKG, 'skill');

  console.log('\n[?] Verifying skill files...');

  if (!fs.existsSync(SKILL_DIR)) {
    console.log('  ℹ️  No skill/ directory in package (optional)');
    return false;
  }

  console.log(`  ✅ Skill files present at: ${SKILL_DIR}`);
  return true;
}

// ───────────────────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────────────────
function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         agents-memory Seamless Installer                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  const daemonOk = installDaemon();
  const hookOk = installOpenClawHook();
  const configOk = installOpenClawConfig();
  const skillOk = installSkill();

  // Reload gateway if everything is good
  let reloadOk = false;
  if (daemonOk && hookOk && configOk) {
    reloadOk = reloadOpenClaw();
  }

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                 Installation Summary                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`  Daemon service:  ${daemonOk ? '✅ Installed' : '⚠️  Skipped'}`);
  console.log(`  OpenClaw hook:   ${hookOk ? '✅ Installed' : '⚠️  Skipped'}`);
  console.log(`  OpenClaw config: ${configOk ? '✅ Updated' : '⚠️  Manual required'}`);
  console.log(`  Gateway reload:  ${reloadOk ? '✅ Reloaded' : '⚠️  Manual required'}`);
  console.log(`  Skill files:     ${skillOk ? '✅ Verified' : '⚠️  Skipped'}`);

  if (daemonOk && hookOk && configOk && reloadOk) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ✅ Installation complete!');
    console.log('  Hook is active - send a message to test.');
    console.log('═══════════════════════════════════════════════════════════');
  } else if (daemonOk && hookOk) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ⚠️  Setup partially complete.');
    console.log('  If config was not auto-added, manually add to openclaw.json:');
    console.log('');
    console.log('  "hooks": {');
    console.log('    "internal": {');
    console.log('      "entries": {');
    console.log('        "agents-memory": { "enabled": true }');
    console.log('      }');
    console.log('    }');
    console.log('  }');
    console.log('');
    console.log('  Then restart gateway:');
    console.log('  nohup openclaw gateway restart > /dev/null 2>&1 &');
    console.log('═══════════════════════════════════════════════════════════');
  } else {
    console.log('\n⚠️  Installation incomplete.');
    if (!daemonOk) {
      console.log('  - Daemon: Try starting manually with: agents-memory daemon-start');
    }
    if (!hookOk) {
      console.log('  - Hook: Check that hook-packs/agents-memory exists in package');
    }
  }
}

main();
