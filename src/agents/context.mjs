import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {root} from './local.mjs';

const bundled = fileURLToPath(new URL('./prompts/', import.meta.url));
const custom = path.join(root, 'prompts');
function read(base, name) {
  try { return fs.readFileSync(path.join(base, name), 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
// Read on every submission so edits also reach resumed and already-open chats.
export function chatContext(anchor, captured) {
  const types = new Set([anchor?.kind]);
  for (const item of [...(anchor?.items || []), ...(captured?.anchor?.items || [])]) {
    types.add(item.kind);
    if (item.mediaKind) types.add(item.mediaKind);
  }
  const files = ['global.md', ...[...types].filter(t => /^[a-z][a-z0-9-]*$/.test(t || '')).sort().map(t => `item-types/${t}.md`)];
  return files.flatMap(name => [read(bundled, name), read(custom, name)]).filter(Boolean).join('\n\n');
}
