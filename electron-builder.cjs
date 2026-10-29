const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  appId: 'com.afclip.desktop', productName: 'AFClip',
  executableName: 'AFClip', asar: false,
  forceCodeSigning: process.env.AFCLIP_RELEASE_UPDATES === '1',
  directories: {output:'dist',buildResources:'packaging'},
  files: ['src/**/*','assets/icons/afclip.*','package.json',
    '!**/*.cpp','!**/*.map','!**/node_modules/ffprobe-static/bin/linux/**',
    '!**/node_modules/ffprobe-static/bin/darwin/**',
    '!**/node_modules/ffprobe-static/bin/win32/ia32/**'],
  extraResources: [{from:'build/runtime',to:'runtime'},{from:'build/bin',to:'bin'}],
  npmRebuild: false,
  afterPack: async ({appOutDir}) => {
    // Explicitly stamp the packaged app. Generated files under build/ are excluded
    // by the application file collector even when included with a file mapping.
    fs.copyFileSync(path.join(__dirname,'build/release.json'),path.join(appOutDir,'resources/app/release.json'));
  },
  publish: [{provider:'github',owner:'Blueteak',repo:'AFClip',releaseType:'draft'}],
  win: {target:[{target:'nsis',arch:['x64']}],icon:'assets/icons/afclip.ico',
    artifactName:'AFClip-${version}-windows-${arch}-setup.${ext}'},
  nsis: {oneClick:true,perMachine:false,allowElevation:false,runAfterFinish:true,
    createDesktopShortcut:false,createStartMenuShortcut:true,deleteAppDataOnUninstall:false,
    include:'packaging/installer.nsh'},
  // macOS is deliberately left to the handoff, including helper signing.
};
