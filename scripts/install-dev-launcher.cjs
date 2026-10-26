const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

if (!['win32', 'darwin'].includes(process.platform)) {
  throw new Error('The development launcher installer supports Windows and macOS only.');
}

const root = path.resolve(__dirname, '..');
const electron = require('electron');
const entry = path.join(root, '.afclip', 'dev-launcher.cjs');
fs.accessSync(electron, fs.constants.F_OK);
fs.mkdirSync(path.dirname(entry), { recursive: true });
// Keep machine-specific paths out of Git. Finder/Start Menu launches do not
// necessarily inherit the terminal environment that installed the dependencies.
fs.writeFileSync(entry, [
  `process.env.AFCLIP_NODE_PATH = ${JSON.stringify(process.execPath)};`,
  `process.env.PATH = ${JSON.stringify(path.dirname(process.execPath) + path.delimiter)} + (process.env.PATH || '');`,
  `process.chdir(${JSON.stringify(root)});`,
  `require(${JSON.stringify(path.join(root, 'src', 'gui', 'main.cjs'))});`,
  '',
].join('\n'));

if (process.platform === 'darwin') {
  const bundle = path.join(os.homedir(), 'Applications', 'AFClip Dev.app');
  const contents = path.join(bundle, 'Contents');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  // Finder executes this directly; no Terminal or shell startup files needed.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const log = path.join(os.homedir(), 'Library', 'Logs', 'AFClip Dev.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const executable = path.join(contents, 'MacOS', 'AFClip Dev');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'unset ELECTRON_RUN_AS_NODE',
    `exec ${quote(electron)} ${quote(entry)} --dev >> ${quote(log)} 2>&1`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>AFClip Dev</string>
  <key>CFBundleDisplayName</key><string>AFClip Dev</string>
  <key>CFBundleIdentifier</key><string>com.afclip.dev-launcher</string>
  <key>CFBundleExecutable</key><string>AFClip Dev</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>afclip.icns</string>
</dict></plist>
`);
  const iconTemp = fs.mkdtempSync(path.join(path.dirname(entry), 'icon-'));
  const iconset = path.join(iconTemp, 'afclip.iconset');
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale),
          path.join(root, 'assets', 'icons', 'afclip.png'), '--out',
          path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'afclip.icns')]);
  } finally {
    fs.rmSync(iconTemp, { recursive: true, force: true });
  }
  console.log(bundle);
} else execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference = 'Stop'
  $shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'AFClip Dev.lnk'
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $env:AFCLIP_LAUNCHER_ELECTRON
  $shortcut.Arguments = '"' + $env:AFCLIP_LAUNCHER_ENTRY + '" --dev'
  $shortcut.WorkingDirectory = $env:AFCLIP_LAUNCHER_ROOT
  $shortcut.IconLocation = $env:AFCLIP_LAUNCHER_ICON + ',0'
  $shortcut.Description = 'AFClip development checkout with live reload'
  $shortcut.Save()
  Write-Output $shortcutPath
`], {
  windowsHide: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    AFCLIP_LAUNCHER_ELECTRON: electron,
    AFCLIP_LAUNCHER_ENTRY: entry,
    AFCLIP_LAUNCHER_ROOT: root,
    AFCLIP_LAUNCHER_ICON: path.join(root, 'assets', 'icons', 'afclip.ico'),
  },
});
