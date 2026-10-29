const path = require('node:path');
const runtime = require('../shared/runtime.cjs');
const supplied = process.argv.slice(1);
const flag = supplied.find(arg => arg.startsWith('--afclip-role='));
const role = flag ? flag.slice('--afclip-role='.length) : 'editor';
if (!runtime.roles[role]) throw new Error('Unknown AFClip process role');
const entry = path.join(runtime.root, runtime.roles[role]);
process.argv = [process.execPath, entry, ...supplied.filter(arg => arg !== flag)];
require(entry);
