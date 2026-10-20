const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Credentials stay in OS-encrypted application storage, never in project data.
function filePath() { return path.join(app.getPath('userData'), 'generative-api-keys.json'); }
function read() {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Could not read saved API keys.'); }
}
function encryptionAvailable() {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
function write(keys) {
  const file = filePath(), temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(keys), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { throw new Error('Could not save API keys.'); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}

module.exports = async (action, payload = {}) => {
  if (action === 'get') return { elevenlabs: { configured: !!read().elevenlabs } };
  if (!['set', 'validate'].includes(action) || payload?.provider !== 'elevenlabs') throw new Error('Unknown API key action or provider.');
  if (action === 'set') {
    if (typeof payload.key !== 'string' || payload.key.length > 4096) throw new Error('Invalid API key.');
    const key = payload.key.trim(), keys = read();
    if (key) {
      if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('API key must not contain spaces or control characters.');
      if (!encryptionAvailable()) throw new Error('OS credential encryption is unavailable.');
      keys.elevenlabs = safeStorage.encryptString(key).toString('base64');
    } else delete keys.elevenlabs;
    write(keys);
    return { configured: !!key };
  }
  const encrypted = read().elevenlabs;
  if (!encrypted) return { status: 'empty', message: 'No API key saved.' };
  if (!encryptionAvailable()) return { status: 'unknown', message: 'OS credential encryption is unavailable.' };
  let key;
  try { key = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
  catch { return { status: 'unknown', message: 'Could not decrypt the saved key. Paste it again.' }; }
  try {
    // Read-only authentication check: https://elevenlabs.io/docs/api-reference/user/get
    const response = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (response.ok) {
      await response.body?.cancel();
      return { status: 'valid', message: 'ElevenLabs API key verified.' };
    }
    const detail = await response.json().catch(() => null);
    const status = detail?.detail?.status;
    if (['invalid_api_key', 'invalid_authorization_header', 'api_key_not_found', 'api_key_disabled'].includes(status)) {
      return { status: 'invalid', message: 'ElevenLabs rejected this API key.' };
    }
    if (status === 'missing_permissions') {
      return { status: 'unknown', message: 'Key verification needs ElevenLabs User read permission.' };
    }
    if (response.status === 403) return { status: 'unknown', message: 'ElevenLabs denied access. Check key permissions and IP restrictions.' };
    if (response.status === 401) return { status: 'invalid', message: 'ElevenLabs rejected this API key.' };
    return { status: 'unknown', message: `Could not verify key. ElevenLabs returned HTTP ${response.status}. Try again.` };
  } catch {
    return { status: 'unknown', message: 'Could not reach ElevenLabs. Check your connection and try again.' };
  }
};
