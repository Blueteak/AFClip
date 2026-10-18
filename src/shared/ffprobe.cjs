// ffprobe-static 3.1.0 ships an Intel executable in its darwin/arm64 folder.
// Keep the existing binary on Windows and other platforms.
module.exports = process.platform === 'darwin' && process.arch === 'arm64'
  ? require.resolve('@ffprobe-installer/darwin-arm64/ffprobe')
  : require('ffprobe-static').path;
