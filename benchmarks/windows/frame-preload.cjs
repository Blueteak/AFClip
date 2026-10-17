// Trusted renderer adapter. Graphic code receives only bounded frame IDs, never file paths or fs.
const { contextBridge } = require('electron');
const fs = require('node:fs');
const configArg = process.argv.find(x => x.startsWith('--frames-config='));
const config = JSON.parse(fs.readFileSync(configArg.slice('--frames-config='.length)));
const sources = new Map(Object.entries(config.frames).map(([id, s]) => [id, { ...s, fd: fs.openSync(s.file, 'r') }]));
const buffers = new Map();
contextBridge.exposeInMainWorld('frameSource', {
  draw(canvasId, sourceId, frame) {
    const source = sources.get(sourceId);
    if (!['a', 'b'].includes(canvasId) || !source || !Number.isInteger(frame) || frame < 0 || frame >= source.count) throw new Error('Invalid source frame');
    const canvas = document.getElementById(canvasId), length = source.width * source.height * 4;
    if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
    let buffer = buffers.get(canvasId);
    if (!buffer || buffer.length !== length) { buffer = Buffer.allocUnsafe(length); buffers.set(canvasId, buffer); }
    let read = 0;
    while (read < length) { const count = fs.readSync(source.fd, buffer, read, length - read, frame * length + read); if (!count) throw new Error('Incomplete frame'); read += count; }
    const pixels = new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    canvas.getContext('2d', { colorSpace: 'srgb' }).putImageData(new ImageData(pixels, source.width, source.height, { colorSpace: 'srgb' }), 0, 0);
  }
});
