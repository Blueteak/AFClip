const {spawn}=require('node:child_process');
const path=require('node:path');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[path.join(__dirname,'main.cjs'),...process.argv.slice(2)],{env,windowsHide:false,stdio:'inherit'});
child.on('exit',code=>process.exitCode=code||0);
