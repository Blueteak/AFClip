const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const nodeVersion = '24.22.2';
async function download(url, target, expected) {
  if(fs.existsSync(target)&&(!expected||createHash('sha256').update(fs.readFileSync(target)).digest('hex')===expected))return;
  const response=await fetch(url);if(!response.ok)throw new Error(`Download failed: ${url}: ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());
  if(expected&&createHash('sha256').update(data).digest('hex')!==expected)throw new Error('Runtime checksum mismatch');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);
}
async function main(){
  const mac=process.platform==='darwin'&&process.arch==='arm64';
  if(!mac&&!(process.platform==='win32'&&process.arch==='x64'))throw new Error('Build on Windows x64 or an Apple Silicon Mac.');
  const output=path.join(root,'build'),runtime=path.join(output,'runtime'),bin=path.join(output,'bin');
  fs.rmSync(runtime,{recursive:true,force:true});fs.rmSync(bin,{recursive:true,force:true});
  fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(bin,{recursive:true});
  const base=`https://nodejs.org/dist/v${nodeVersion}/`;
  const response=await fetch(base+'SHASUMS256.txt');if(!response.ok)throw new Error('Cannot fetch runtime checksums');
  const sums=await response.text();
  const checksum=asset=>{
    const hash=sums.split('\n').map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]===asset)?.[0];
    if(!hash)throw new Error('Missing runtime checksum: '+asset);
    return hash;
  };
  if(mac){
    const archive=`node-v${nodeVersion}-darwin-arm64.tar.gz`,cache=path.join(root,'.cache/release-runtime');
    await download(base+archive,path.join(cache,archive),checksum(archive));
    execFileSync('/usr/bin/tar',['-xzf',path.join(cache,archive),'-C',cache]);
    const unpacked=path.join(cache,`node-v${nodeVersion}-darwin-arm64`);
    fs.copyFileSync(path.join(unpacked,'bin/node'),path.join(runtime,'node'));
    fs.chmodSync(path.join(runtime,'node'),0o755);
    fs.copyFileSync(path.join(unpacked,'LICENSE'),path.join(runtime,'NODE-LICENSE.txt'));
    const icons=path.join(output,'afclip.iconset');fs.mkdirSync(icons,{recursive:true});
    for(const size of [16,32,128,256,512])for(const scale of [1,2]){
      execFileSync('/usr/bin/sips',['-z',String(size*scale),String(size*scale),path.join(root,'assets/icons/afclip.png'),'--out',path.join(icons,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{stdio:'ignore'});
    }
    execFileSync('/usr/bin/iconutil',['-c','icns',icons,'-o',path.join(output,'afclip.icns')]);
  }else{
    await download(base+'win-x64/node.exe',path.join(runtime,'node.exe'),checksum('win-x64/node.exe'));
    await download(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,path.join(runtime,'NODE-LICENSE.txt'));
    fs.copyFileSync(await require('../src/render/native/build.cjs')(),path.join(runtime,'texture-encoder.exe'));
  }
  for(const [name,entry] of [['af-clip','src/cli.ts'],['af-lib','src/library/cli.ts']]){
    if(mac){
      // Resolve symlinks installed in ~/.local/bin before finding the bundled runtime.
      const script=`#!/bin/sh
script="$0"
while [ -L "$script" ]; do
  base=$(dirname "$script")
  script=$(readlink "$script")
  case "$script" in /*) ;; *) script="$base/$script" ;; esac
done
bin=$(CDPATH= cd -- "$(dirname "$script")" && pwd)
exec "$bin/../runtime/node" "$bin/../app/${entry}" "$@"
`;
      fs.writeFileSync(path.join(bin,name),script,{mode:0o755});
    }else fs.writeFileSync(path.join(bin,name+'.cmd'),`@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\${entry.replaceAll('/','\\')}" %*\r\nexit /b %errorlevel%\r\n`);
  }
  const pkg=require('../package.json');
  const build=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const manifest={version:pkg.version,build,node:nodeVersion,platform:process.platform,arch:process.arch,projectFormats:[1],libraryFormats:[1],updatesEnabled:process.env.AFCLIP_RELEASE_UPDATES==='1'};
  fs.writeFileSync(path.join(output,'release.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Prepared ${process.platform} ${process.arch} ${pkg.version}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
