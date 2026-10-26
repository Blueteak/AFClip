const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32') {
  throw new Error('The development launcher installer currently supports Windows only.');
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

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
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
