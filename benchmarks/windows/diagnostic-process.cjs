// Own only the diagnostic child. A completed measurement must not leave an
// Electron process behind when native teardown stalls after the quit event.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
module.exports = function finishDiagnostic(child, directory, resultName = 'results.json') {
  let finishedAt, forcedCode;
  const timer = setInterval(() => {
    if (child.exitCode !== null) return;
    const error = fs.existsSync(path.join(directory, 'error.json'));
    const result = path.join(directory, resultName);
    if (!error && !fs.existsSync(result)) return;
    finishedAt ??= Date.now();
    if (Date.now() - finishedAt < 5000) return;
    clearInterval(timer);
    forcedCode = error ? 1 : 0;
    try { if (!error) JSON.parse(fs.readFileSync(result, 'utf8')); }
    catch { forcedCode = 1; }
    fs.writeFileSync(path.join(directory, 'shutdown.json'), JSON.stringify({
      forced: true, measurementPassed: forcedCode === 0,
      reason: 'Electron remained alive five seconds after writing the diagnostic result',
    }, null, 2));
    console.warn('Diagnostic finished; closing its stalled Electron process. See shutdown.json.');
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' });
    else child.kill('SIGKILL');
  }, 250);
  child.once('exit', () => clearInterval(timer));
  child.once('error', () => clearInterval(timer));
  return code => forcedCode ?? code ?? 1;
};
