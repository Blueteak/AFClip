const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

module.exports = class PreviewSession {
  constructor(projectDir, send, registerFile) {
    Object.assign(this, { projectDir, send, registerFile });
  }
  async open(project, mode) {
    this.close();
    const id = randomUUID(), root = path.resolve(this.projectDir, '.reelet', 'gui-preview', id);
    const session = { id, root, revision: project.revision, cancelFile: path.join(root, 'cancel') };
    this.current = session;
    await fs.mkdir(root, { recursive: true });
    if (this.current !== session) { this.clean(session); return { id, revision: project.revision }; }
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ projectDir: this.projectDir, project, kind: 'preview', mode,
      output: path.join(root, 'unused.png'), jobId: id, cancelFile: session.cancelFile }));
    if (this.current !== session) { this.clean(session); return { id, revision: project.revision }; }
    const child = spawn(process.env.REELET_NODE_PATH || 'node', [path.resolve(__dirname, '../render/job.cjs'), config], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.child = child;
    child.stdin.on('error', () => {});
    let buffer = '', errorLog = '', terminal = false;
    child.stderr.on('data', b => { errorLog = (errorLog + b).slice(-4000); });
    const send = value => { if (this.current === session) this.send({ ...value, sessionId: id, revision: project.revision }); };
    child.stdout.on('data', b => {
      buffer += b.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'ready' && value.audio) value.audioUrl = this.registerFile(value.audio, id);
          if (value.type === 'error') terminal = true;
          send(value);
        } catch { /* Ignore non-protocol diagnostic lines. */ }
      }
    });
    child.on('error', error => { terminal = true; send({ type: 'error', error: { message: error.message } }); });
    child.on('close', code => {
      if (!terminal) send({ type: 'error', error: { message: `Preview worker exited (${code}). ${errorLog}` } });
      // root is a generated UUID directory inside this project's preview cache.
      session.closed = true;
      if (this.current !== session) this.clean(session);
    });
    return { id, revision: project.revision };
  }
  frame({ sessionId, time, epoch }) {
    const session = this.current;
    if (session?.id !== sessionId || !Number.isFinite(time) || !Number.isSafeInteger(epoch)) return;
    session.child?.stdin.write(JSON.stringify({ time, epoch }) + '\n');
  }
  clean(session) {
    if (path.dirname(session.root) === path.resolve(this.projectDir, '.reelet', 'gui-preview')) fs.rm(session.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  close() {
    const session = this.current; this.current = null;
    if (!session) return;
    if (session.closed) { this.clean(session); return; }
    session.child?.stdin.end(JSON.stringify({ type: 'close' }) + '\n');
    fs.writeFile(session.cancelFile, '').catch(() => {});
  }
};
