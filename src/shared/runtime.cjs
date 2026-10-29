const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '../..');
const manifest = path.join(root, 'release.json');
const release = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
const packaged = !!release;
const resources = path.dirname(root);
const node = packaged ? path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  : process.env.AFCLIP_NODE_PATH || (process.versions.electron ? 'node' : process.execPath);
const executable = packaged ? (process.platform === 'darwin' ? path.resolve(resources, '../MacOS/AFClip') : path.resolve(resources, '../AFClip.exe')) : null;
const dataRoot = process.env.AFCLIP_DATA_HOME || path.join(process.env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : path.join(os.homedir(), '.local/share')), 'AFClip');
const roles = {
  editor: 'src/gui/main.cjs', library: 'src/library/main.cjs',
  render: 'src/render/worker.cjs', preview: 'src/render/preview-worker.cjs',
  credentials: 'src/engine/elevenlabs-worker.cjs',
};
function initialize() {
  if (!packaged) return;
  process.env.AFCLIP_NODE_PATH = node;
  process.env.PATH = path.join(resources, 'bin') + path.delimiter + path.dirname(node) + path.delimiter + (process.env.PATH || '');
  delete process.env.ELECTRON_RUN_AS_NODE;
}
function electron(role, args = []) {
  if (!roles[role]) throw new Error('Unknown AFClip process role');
  return packaged ? {binary: executable, args: ['--afclip-role=' + role, ...args]}
    : {binary: require('electron'), args: [path.join(root, roles[role]), ...args]};
}
function compatible(other) {
  // Legacy development services have no release identity. Installed builds never use them.
  if (!packaged && !other) return;
  if (other?.build !== release?.build || other?.version !== release?.version || other?.installation !== root) {
    const error = new Error('A different AFClip release is using this project or library. Close its windows and background work, then retry.');
    error.code = 'RELEASE_MISMATCH'; throw error;
  }
}
const identity = packaged ? {...release, installation: root} : null;
initialize();
module.exports = {root, resources, release, identity, packaged, node, executable, dataRoot, roles, electron, compatible, initialize};
