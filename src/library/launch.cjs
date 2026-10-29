const runtime = require('../shared/runtime.cjs');
const {spawn}=require('node:child_process');
const path=require('node:path');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const launch=runtime.electron('library',process.argv.slice(2));
const child=spawn(launch.binary,launch.args,{env,windowsHide:false,stdio:'inherit'});
child.on('exit',code=>process.exitCode=code||0);
