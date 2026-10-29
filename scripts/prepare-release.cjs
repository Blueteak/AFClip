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
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Build the Windows installer on Windows x64. See docs/macos-setup-handoff.md for Mac.');
  const output=path.join(root,'build'),runtime=path.join(output,'runtime'),bin=path.join(output,'bin');
  fs.rmSync(runtime,{recursive:true,force:true});fs.rmSync(bin,{recursive:true,force:true});
  fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(bin,{recursive:true});
  const base=`https://nodejs.org/dist/v${nodeVersion}/`;
  const response=await fetch(base+'SHASUMS256.txt');if(!response.ok)throw new Error('Cannot fetch runtime checksums');
  const sums=await response.text();
  for(const name of ['node.exe']){
    const asset='win-x64/'+name,hash=sums.split('\n').map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]===asset)?.[0];
    if(!hash)throw new Error('Missing runtime checksum');
    await download(base+asset,path.join(runtime,name),hash);
  }
  await download(base+'LICENSE',path.join(runtime,'NODE-LICENSE.txt'));
  const encoder=await require('../src/render/native/build.cjs')();
  fs.copyFileSync(encoder,path.join(runtime,'texture-encoder.exe'));
  for(const [name,entry] of [['af-clip','src/cli.ts'],['af-lib','src/library/cli.ts']]){
    fs.writeFileSync(path.join(bin,name+'.cmd'),`@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\${entry.replaceAll('/','\\')}" %*\r\nexit /b %errorlevel%\r\n`);
  }
  const pkg=require('../package.json');
  const build=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const manifest={version:pkg.version,build,node:nodeVersion,platform:'win32',arch:'x64',projectFormats:[1],libraryFormats:[1],updatesEnabled:process.env.AFCLIP_RELEASE_UPDATES==='1'};
  fs.writeFileSync(path.join(output,'release.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Prepared Windows x64 ${pkg.version}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
