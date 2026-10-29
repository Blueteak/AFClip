// Local build only. No system installation, PATH changes, or driver updates.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
async function build() {
  const runtime = require('../../shared/runtime.cjs');
  if (runtime.packaged) {
    const binary = path.join(runtime.resources, 'runtime', 'texture-encoder.exe');
    if (!fs.existsSync(binary)) throw new Error('Hardware encoder is unavailable. Choose software rendering.');
    return binary;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Shared-texture benchmark requires Windows x64.');
  const out = path.resolve(__dirname, '../../../.cache/afclip-native'); fs.mkdirSync(out, { recursive: true });
  const executable = path.join(out, 'texture-encoder.exe');
  if (fs.existsSync(executable) && fs.statSync(executable).mtimeMs >= Math.max(fs.statSync(__filename).mtimeMs, fs.statSync(path.join(__dirname, 'texture-encoder.cpp')).mtimeMs)) return executable;
  const header = path.join(out, 'nvEncodeAPI.h');
  if (!fs.existsSync(header)) {
    const r = await fetch('https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/n12.1.14.0/include/ffnvcodec/nvEncodeAPI.h');
    if (!r.ok) throw new Error(`NVENC header download: ${r.status}`);
    fs.writeFileSync(header, Buffer.from(await r.arrayBuffer()));
  }
  if (createHash('sha256').update(fs.readFileSync(header)).digest('hex') !== 'dbdaa8bcbc2b9325bd24bc68b36170a8432411518040e8d4c8421608cf217425') throw new Error('NVENC header checksum mismatch');
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installations = JSON.parse(execFileSync(vswhere, ['-all', '-products', '*', '-format', 'json'], { encoding: 'utf8', windowsHide: true }));
  const vc = installations.flatMap(i => {
    const root = path.join(i.installationPath, 'VC/Tools/MSVC');
    return fs.existsSync(root) ? fs.readdirSync(root).sort().reverse().map(v => path.join(root, v)) : [];
  }).find(p => fs.existsSync(path.join(p, 'bin/Hostx64/x64/cl.exe')));
  if (!vc) throw new Error('Install Visual Studio C++ Build Tools with the Windows SDK.');
  const sdk = path.join(process.env['ProgramFiles(x86)'], 'Windows Kits/10');
  const version = fs.readdirSync(path.join(sdk, 'Include')).sort().reverse().find(v => fs.existsSync(path.join(sdk, 'Lib', v, 'um/x64/d3d11.lib')));
  if (!version) throw new Error('Windows SDK with D3D11 libraries is required.');
  const args = ['/nologo', '/std:c++17', '/EHsc', '/O2', '/MT', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX', `/I${out}`, `/I${path.join(vc, 'include')}`,
    ...['ucrt', 'shared', 'um', 'winrt'].map(d => `/I${path.join(sdk, 'Include', version, d)}`),
    path.join(__dirname, 'texture-encoder.cpp'), `/Fo${path.join(out, 'texture-encoder.obj')}`, `/Fe${executable}`, '/link',
    `/LIBPATH:${path.join(vc, 'lib/x64')}`, ...['ucrt', 'um'].map(d => `/LIBPATH:${path.join(sdk, 'Lib', version, d, 'x64')}`), 'd3d11.lib', 'dxgi.lib'];
  execFileSync(path.join(vc, 'bin/Hostx64/x64/cl.exe'), args, { windowsHide: true, stdio: 'inherit' });
  return executable;
}
module.exports = build;
if (require.main === module) build().then(console.log).catch(e => { console.error(e); process.exitCode = 1; });
