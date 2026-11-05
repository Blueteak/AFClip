const fs = require('node:fs');
const path = require('node:path');
const mac=process.platform==='darwin';
const publishing=process.env.AFCLIP_RELEASE_UPDATES==='1';
module.exports = {
  appId: 'com.afclip.desktop', productName: 'AFClip',
  executableName: 'AFClip', asar: false,
  forceCodeSigning: process.env.AFCLIP_RELEASE_UPDATES === '1',
  directories: {output:'dist',buildResources:'packaging'},
  files: ['src/**/*','assets/icons/afclip.*','package.json',
    '!**/*.cpp','!**/*.map','!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**',
    '!**/node_modules/ffprobe-static/bin/linux/**',
    '!**/node_modules/ffprobe-static/bin/darwin/**',
    mac?'!**/node_modules/ffprobe-static/bin/win32/**':'!**/node_modules/ffprobe-static/bin/win32/ia32/**'],
  extraResources: [{from:'build/runtime',to:'runtime'},{from:'build/bin',to:'bin'}],
  npmRebuild: false,
  afterPack: async ({appOutDir,electronPlatformName}) => {
    // Explicitly stamp the packaged app. Generated files under build/ are excluded
    // by the application file collector even when included with a file mapping.
    fs.copyFileSync(path.join(__dirname,'build/release.json'),path.join(appOutDir,electronPlatformName==='darwin'?'AFClip.app/Contents/Resources/app/release.json':'resources/app/release.json'));
  },
  publish: [{provider:'github',owner:'Blueteak',repo:'AFClip',releaseType:'draft'}],
  win: {target:[{target:'nsis',arch:['x64']}],icon:'assets/icons/afclip.ico',
    artifactName:'AFClip-${version}-windows-${arch}-setup.${ext}'},
  nsis: {oneClick:true,perMachine:false,allowElevation:false,runAfterFinish:true,
    createDesktopShortcut:false,createStartMenuShortcut:true,deleteAppDataOnUninstall:false,
    include:'packaging/installer.nsh'},
  mac: {
    target:[{target:'dmg',arch:['arm64']},{target:'zip',arch:['arm64']}],
    icon:'build/afclip.icns',category:'public.app-category.video',
    artifactName:'AFClip-${version}-macos-${arch}.${ext}',
    identity:publishing?undefined:'-',
    hardenedRuntime:publishing,
    entitlements:'packaging/entitlements.mac.plist',
    entitlementsInherit:'packaging/entitlements.mac.plist',
    notarize:publishing,
    binaries:['Contents/Resources/runtime/node',
      'Contents/Resources/app/node_modules/ffmpeg-static/ffmpeg',
      'Contents/Resources/app/node_modules/@ffprobe-installer/darwin-arm64/ffprobe'],
  },
  dmg: {contents:[{x:150,y:180,type:'file'},{x:420,y:180,type:'link',path:'/Applications'}]},
};
