#!/usr/bin/env node
/**
 * install-seamless.js - Install agents-memory daemon as systemd service
 *                        AND OpenClaw plugin
 * 
 * This script is designed to work both:
 * 1. When run from the package directory (npm install)
 * 2. When run from the npm global prefix
 * 
 * NO HARDCODED PATHS - uses dynamic resolution
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'agents-memory';
const SERVICE_NAME = 'agents-memory-daemon';
const HOME = process.env.HOME || '/home/developer';
const SERVICE_FILE = path.join(HOME, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
const OPENCLAW_CONFIG = path.join(HOME, '.openclaw', 'openclaw.json');
const EXTENSION_DIR = path.join(HOME, '.openclaw', 'extensions', PLUGIN_ID);

// Dynamic package location resolver
function getPackageRoot() {
  // 1. Try npm global prefix
  try {
    const globalPrefix = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const globalPath = path.join(globalPrefix, 'agents-memory');
    if (fs.existsSync(path.join(globalPath, 'scripts', 'memory_daemon.py'))) {
      return globalPath;
    }
  } catch (e) {}
  
  // 2. Try __dirname (when run from package)
  if (__dirname) {
    const scriptsDir = path.dirname(__dirname);  // scripts -> package root
    if (fs.existsSync(path.join(scriptsDir, 'scripts', 'memory_daemon.py'))) {
      return scriptsDir;
    }
    
    // Maybe we're already at package root
    if (fs.existsSync(path.join(__dirname, 'memory_daemon.py'))) {
      return path.dirname(__dirname);
    }
  }
  
  // 3. Try environment variable
  if (process.env.AGENTS_MEMORY_ROOT) {
    return process.env.AGENTS_MEMORY_ROOT;
  }
  
  throw new Error(
    'Cannot find agents-memory package.\n' +
    'Solutions:\n' +
    '  1. Install globally: npm install -g agents-memory\n' +
    '  2. Set AGENTS_MEMORY_ROOT environment variable'
  );
}

// Dynamic paths
const PACKAGE_ROOT = getPackageRoot();
const DAEMON_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'memory_daemon.py');
const PLUGIN_SRC_DIR = path.join(PACKAGE_ROOT, 'plugin');
const MEMORY_DIR = path.join(HOME, '.memory', 'agents-memory');
const PID_FILE = path.join(MEMORY_DIR, 'daemon.pid');
const SOCKET_FILE = path.join(MEMORY_DIR, 'daemon.sock');

function getSystemdUnit() {
  return `[Unit]
Description=Agents Memory Daemon (semantic memory for AI CLI tools)
After=network.target

[Service]
Type=forking
PIDFile=${PID_FILE}
ExecStartPre=/bin/mkdir -p ${MEMORY_DIR}
ExecStart=/usr/bin/python3 ${DAEMON_SCRIPT} --daemon
ExecStop=/bin/kill -TERM $MAINPID
Environment="PYTHONPATH=${PACKAGE_ROOT}/scripts"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target`;
}

function installDaemon() {
  console.log('\n[Daemon Service]');
  console.log(`  Package root: ${PACKAGE_ROOT}`);
  console.log(`  Memory dir: ${MEMORY_DIR}`);
  console.log(`  Socket: ${SOCKET_FILE}`);
  
  // Ensure memory directory exists
  fs.mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
  
  // Write systemd service
  fs.writeFileSync(SERVICE_FILE, getSystemdUnit());
  console.log(`  Service file: ${SERVICE_FILE}`);
  
  // Reload systemd and enable
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable ${SERVICE_NAME}.service`, { stdio: 'pipe' });
    execSync(`systemctl --user start ${SERVICE_NAME}.service`, { stdio: 'pipe' });
    console.log('  ✅ Daemon service installed and started');
    return true;
  } catch (e) {
    // Service might already be running
    try {
      execSync(`systemctl --user restart ${SERVICE_NAME}.service`, { stdio: 'pipe' });
      console.log('  ✅ Daemon service restarted');
      return true;
    } catch (e2) {
      console.log('  ⚠️  Could not start systemd service (may need manual start)');
      console.log('      Try: agents-memory daemon-start');
      return false;
    }
  }
}

function installOpenClawPlugin() {
  console.log('\n[OpenClaw Plugin]');
  
  // Check if plugin directory exists
  if (!fs.existsSync(PLUGIN_SRC_DIR)) {
    console.log('  ℹ️  No OpenClaw plugin found in this package');
    return false;
  }
  
  // Check if OpenClaw config exists
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    console.log('  ℹ️  OpenClaw config not found, skipping plugin setup');
    console.log('      Run "openclaw" first, then: openclaw plugins enable agents-memory');
    return false;
  }
  
  // Copy plugin to extensions directory
  fs.mkdirSync(EXTENSION_DIR, { recursive: true });
  
  const files = fs.readdirSync(PLUGIN_SRC_DIR);
  for (const file of files) {
    const src = path.join(PLUGIN_SRC_DIR, file);
    const dst = path.join(EXTENSION_DIR, file);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
  console.log(`  ✅ Plugin installed to: ${EXTENSION_DIR}`);
  
  // Update openclaw.json config
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    let modified = false;
    
    // Ensure plugins section exists
    if (!config.plugins) {
      config.plugins = {};
    }
    
    // Add to allow list if not present
    if (!config.plugins.allow) {
      config.plugins.allow = [];
    }
    if (!config.plugins.allow.includes(PLUGIN_ID)) {
      config.plugins.allow.push(PLUGIN_ID);
      modified = true;
    }
    
    // Add to entries if not present
    if (!config.plugins.entries) {
      config.plugins.entries = {};
    }
    if (!config.plugins.entries[PLUGIN_ID]) {
      config.plugins.entries[PLUGIN_ID] = {
        enabled: true,
        config: {}
      };
      modified = true;
    }
    
    // Set install info
    config.plugins.installs = config.plugins.installs || {};
    config.plugins.installs[PLUGIN_ID] = {
      source: 'npm',
      sourcePath: EXTENSION_DIR,
      installPath: EXTENSION_DIR,
      version: require(path.join(PACKAGE_ROOT, 'package.json')).version,
      installedAt: new Date().toISOString()
    };
    modified = true;
    
    if (modified) {
      fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
      console.log('  ✅ Config updated: ~/.openclaw/openclaw.json');
      console.log('\n  ⚠️  Restart OpenClaw gateway to load plugin:');
      console.log('      openclaw gateway restart');
    } else {
      console.log('  ℹ️  Config already up-to-date');
    }
    
    return modified;
  } catch (err) {
    console.log(`  ⚠️  Could not update config: ${err.message}`);
    return false;
  }
}

function uninstall() {
  console.log('Uninstalling agents-memory...\n');
  
  // Stop and disable daemon service
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}.service`, { stdio: 'pipe' });
    execSync(`systemctl --user disable ${SERVICE_NAME}.service`, { stdio: 'pipe' });
    console.log('[Daemon] Stopped and disabled');
  } catch (e) {}
  
  if (fs.existsSync(SERVICE_FILE)) {
    fs.unlinkSync(SERVICE_FILE);
    console.log('[Daemon] Service file removed');
  }
  
  // Remove OpenClaw plugin
  if (fs.existsSync(EXTENSION_DIR)) {
    fs.rmSync(EXTENSION_DIR, { recursive: true });
    console.log('[OpenClaw] Plugin removed from extensions');
  }
  
  // Update config to remove plugin references
  if (fs.existsSync(OPENCLAW_CONFIG)) {
    try {
      const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
      let modified = false;
      
      if (config.plugins) {
        if (config.plugins.allow) {
          config.plugins.allow = config.plugins.allow.filter(p => p !== PLUGIN_ID);
          modified = true;
        }
        if (config.plugins.entries && config.plugins.entries[PLUGIN_ID]) {
          delete config.plugins.entries[PLUGIN_ID];
          modified = true;
        }
        if (config.plugins.installs && config.plugins.installs[PLUGIN_ID]) {
          delete config.plugins.installs[PLUGIN_ID];
          modified = true;
        }
      }
      
      if (modified) {
        fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
        console.log('[OpenClaw] Config updated');
      }
    } catch (e) {}
  }
  
  console.log('\n✅ Uninstall complete');
  console.log('\nNote: Memory data in ~/.memory/ was NOT deleted');
  console.log('      Remove manually with: rm -rf ~/.memory');
}

// CLI
const cmd = process.argv[2] || 'install';
if (cmd === 'uninstall') {
  uninstall();
} else {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         agents-memory Seamless Installer                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  const daemonOk = installDaemon();
  const pluginOk = installOpenClawPlugin();
  
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    Installation Summary                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`  Daemon service:  ${daemonOk ? '✅ Installed' : '⚠️  Skipped'}`);
  console.log(`  OpenClaw plugin:  ${pluginOk ? '✅ Installed' : '⚠️  Skipped'}`);
  
  if (daemonOk || pluginOk) {
    console.log('\n✅ Setup complete!');
    console.log('\nNext steps:');
    console.log('  1. Restart OpenClaw: openclaw gateway restart');
    console.log('  2. Verify: openclaw status | grep agents-memory');
    console.log('  3. Test memory: agents-memory write "test entry"');
  } else {
    console.log('\n⚠️  Installation incomplete. Check errors above.');
  }
}
