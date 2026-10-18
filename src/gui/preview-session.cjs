const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

module.exports = class PreviewSession {
  constructor(projectDir, send, registerFile, registerGraphics, unregisterFile = () => {}) {
    Object.assign(this, { projectDir, send, registerFile, registerGraphics, unregisterFile });
  }
  async open(project, mode) {
    this.close();
    const id = randomUUID(), root = path.resolve(this.projectDir, '.afclip', 'gui-preview', id);
    const session = { id, root, revision: project.revision, cancelFile: path.join(root, 'cancel') };
    this.current = session;
    await fs.mkdir(root, { recursive: true });
    if (this.current !== session) { this.clean(session); return { id, revision: project.revision }; }
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ projectDir: this.projectDir, project, kind: 'preview', mode, nativePreview: mode === 'gpu',
      output: path.join(root, 'unused.png'), jobId: id, cancelFile: session.cancelFile }));
    if (this.current !== session) { this.clean(session); return { id, revision: project.revision }; }
    const child = spawn(process.env.AFCLIP_NODE_PATH || 'node', [path.resolve(__dirname, '../render/job.cjs'), config], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.child = child;
    child.stdin.on('error', () => {});
    let buffer = '', errorLog = '', terminal = false;
    child.stderr.on('data', b => { errorLog = (errorLog + b).slice(-4000); });
    const send = value => { if (this.current === session) this.send({ ...value, sessionId: id, revision: session.revision }); };
    child.stdout.on('data', b => {
      buffer += b.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (this.current !== session) continue;
          if (value.type === 'ready' && value.audio) value.audioUrl = this.registerFile(value.audio, id);
          if (value.seekProxy) { value.seekProxy.url = this.registerFile(value.seekProxy.file, randomUUID()); delete value.seekProxy.file; }
          if (value.nativeSetup) {
            for (const media of Object.values(value.nativeSetup.media)) {
              if (media.file && ['video', 'image'].includes(media.kind)) media.url = this.registerFile(media.file, randomUUID());
              if (media.seekProxy) { media.seekProxy.url = this.registerFile(media.seekProxy.file, randomUUID()); delete media.seekProxy.file; }
              delete media.file;
            }
            this.registerGraphics(value.nativeSetup.graphics);
            for (const graphic of Object.values(value.nativeSetup.graphics)) delete graphic.root;
          }
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
  async audio(sessionId, project) {
    const session = this.current;
    if (!session || session.id !== sessionId) throw new Error('Preview replaced');
    const generation = session.audioGeneration = (session.audioGeneration || 0) + 1;
    if (session.audioCancel) await fs.writeFile(session.audioCancel, '').catch(() => {});
    const id = randomUUID(), root = path.join(session.root, id);
    await fs.mkdir(root, { recursive: true });
    const output = path.join(root, 'mix.wav'), config = path.join(root, 'config.json'), cancelFile = path.join(root, 'cancel');
    if (generation !== session.audioGeneration || this.current !== session) throw new Error('Preview replaced');
    session.audioCancel = cancelFile;
    await fs.writeFile(config, JSON.stringify({ projectDir: this.projectDir, project, kind: 'preview-audio',
      output, cancelFile }));
    if (this.current !== session || generation !== session.audioGeneration) throw new Error('Preview replaced');
    const work = new Promise((resolve, reject) => {
      const child = spawn(process.env.AFCLIP_NODE_PATH || 'node', [path.resolve(__dirname, '../render/job.cjs'), config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let error = '';
      child.stdout.resume(); child.stderr.on('data', b => { error = (error + b).slice(-4000); });
      child.on('error', reject);
      child.on('close', code => code ? reject(new Error(error || 'Audio preparation failed')) : resolve());
    });
    session.audioWork ||= new Set(); session.audioWork.add(work);
    try { await work; }
    catch (error) { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); throw error; }
    finally { session.audioWork.delete(work); }
    if (this.current !== session || generation !== session.audioGeneration) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      throw new Error('Preview replaced');
    }
    session.revision = project.revision;
    session.child?.stdin.write(JSON.stringify({ type: 'plan', plan: require('../render/timeline.cjs').compile(project) }) + '\n');
    session.audioFiles ||= [];
    session.audioFiles.push({ id, root });
    while (session.audioFiles.length > 2) {
      const previous = session.audioFiles.shift();
      this.unregisterFile(previous.id);
      fs.rm(previous.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
    return { audioUrl: this.registerFile(output, id), revision: project.revision };
  }
  clean(session) {
    if (path.dirname(session.root) === path.resolve(this.projectDir, '.afclip', 'gui-preview')) Promise.allSettled([...(session.audioWork || [])]).then(() => fs.rm(session.root, { recursive: true, force: true, maxRetries: 3 })).catch(() => {});
  }
  close() {
    const session = this.current; this.current = null;
    if (!session) return;
    if (session.audioCancel) fs.writeFile(session.audioCancel, '').catch(() => {});
    if (session.closed) { this.clean(session); return; }
    session.child?.stdin.end(JSON.stringify({ type: 'close' }) + '\n');
    fs.writeFile(session.cancelFile, '').catch(() => {});
  }
};
