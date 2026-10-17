const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.slice(2), dev = args.includes('--dev');
const projectArgs = args.filter(arg => arg !== '--dev');
const child = spawn(require('electron'), [path.join(__dirname, 'main.cjs'), ...(projectArgs.length ? projectArgs : ['.']), ...(dev ? ['--dev'] : [])], { windowsHide: false, env, stdio: 'inherit' });
child.on('error', e => { console.error(e); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
