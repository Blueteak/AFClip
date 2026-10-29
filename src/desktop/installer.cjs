// Invoked by NSIS before replacement/uninstall. Never terminates active work.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const runtime=require('../shared/runtime.cjs');
const lifecycle=require('../shared/lifecycle.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const action=process.argv[2],lock=path.join(lifecycle.directory,'updating.json');
  if(action==='prepare'){
    const owner=Number(process.argv[3]);if(!Number.isSafeInteger(owner)||owner<=0)throw new Error('Invalid installer process');
    // An in-app update has already drained work and is exiting. Allow that exit.
    let records=await lifecycle.processes();
    if(fs.existsSync(lock)){
      const prior=JSON.parse(fs.readFileSync(lock,'utf8'));
      if(prior.pid!==owner&&lifecycle.alive(prior.pid)){
        const deadline=Date.now()+15000;
        while(records.length&&Date.now()<deadline){await pause(250);records=await lifecycle.processes();}
      }
    }
    if(records.some(r=>r.busy))throw new Error('AFClip is still working. Finish exports, library jobs, and agent conversations, then run this installer again.');
    fs.mkdirSync(lifecycle.directory,{recursive:true});
    const existing=fs.existsSync(lock)?JSON.parse(fs.readFileSync(lock,'utf8')):null;
    // The old uninstaller runs inside replacement. Keep the outer installer's barrier.
    if(!existing||!lifecycle.alive(existing.pid))fs.writeFileSync(lock,JSON.stringify({pid:owner}),{mode:0o600});
    records=await lifecycle.processes();
    if(records.some(r=>r.busy)){fs.rmSync(lock,{force:true});throw new Error('AFClip is still working. Retry when it finishes.');}
    for(const record of records)await lifecycle.call(record,'close');
    const deadline=Date.now()+20000;
    while(records.some(r=>lifecycle.alive(r.pid))){if(Date.now()>deadline)throw new Error('AFClip could not close. Retry after closing its windows.');await pause(100);}
    return;
  }
  if(!['install','uninstall'].includes(action))throw new Error('Unknown installer action');
  const command=`$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $old=$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $parts=@($old -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $env:AFCLIP_COMMAND_DIR.TrimEnd('\\') }); if($env:AFCLIP_PATH_ACTION -eq 'install'){$parts+= $env:AFCLIP_COMMAND_DIR}; $key.SetValue('Path',($parts -join ';'),[Microsoft.Win32.RegistryValueKind]::ExpandString); $key.Close()`;
  try{
    execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,env:{...process.env,AFCLIP_COMMAND_DIR:path.join(runtime.resources,'bin'),AFCLIP_PATH_ACTION:action}});
  }finally{if(action==='install')fs.rmSync(lock,{force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
