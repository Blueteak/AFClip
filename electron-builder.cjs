module.exports = {
  appId: 'com.afclip.desktop', productName: 'AFClip',
  executableName: 'AFClip', asar: false,
  directories: {output:'dist',buildResources:'packaging'},
  files: ['src/**/*','assets/icons/afclip.*','package.json',
    {from:'build/release.json',to:'release.json'},
    '!**/*.cpp','!**/*.map','!**/node_modules/ffprobe-static/bin/linux/**',
    '!**/node_modules/ffprobe-static/bin/darwin/**',
    '!**/node_modules/ffprobe-static/bin/win32/ia32/**'],
  extraResources: [{from:'build/runtime',to:'runtime'},{from:'build/bin',to:'bin'}],
  npmRebuild: false,
  publish: [{provider:'github',owner:'Blueteak',repo:'AFClip',releaseType:'draft'}],
  win: {target:[{target:'nsis',arch:['x64']}],icon:'assets/icons/afclip.ico',
    artifactName:'AFClip-${version}-windows-${arch}-setup.${ext}'},
  nsis: {oneClick:true,perMachine:false,allowElevation:false,runAfterFinish:true,
    createDesktopShortcut:false,createStartMenuShortcut:true,deleteAppDataOnUninstall:false,
    include:'packaging/installer.nsh'},
  // macOS is deliberately left to the handoff, including helper signing.
};
