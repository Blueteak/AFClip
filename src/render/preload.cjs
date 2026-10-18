// This adapter belongs to the trusted compositor. Graphic iframes have opaque origins and no Node.
const { contextBridge } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Decoder, frameIndex } = require('./decoder.cjs');
const file = process.argv.find(x => x.startsWith('--reelet-render='))?.slice(16);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const decoders = new Map();
const stats = { peakDecodedBytes: 0, peakDecoders: 0, decodedSourceFrames: 0, restarts: 0 };
async function draw(items) {
  const wanted = new Set(items.filter(i => i.kind === 'video' || i.kind === 'image').map(i => i.clipId));
  for (const [id, decoder] of decoders) if (!wanted.has(id)) {
    decoder.close(); decoders.delete(id);
    const canvas = document.getElementById(`media-${id}`);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
  for (const item of items) {
    if (!wanted.has(item.clipId)) continue;
    const media = config.media[item.mediaId], canvas = document.getElementById(`media-${item.clipId}`);
    if (!media || !canvas || item.sourceTime < -.00001) throw new Error('Invalid frame request');
    const index = frameIndex(media.pts, item.sourceTime);
    let decoder = decoders.get(item.clipId);
    if (decoder && (index < decoder.index || index - decoder.index > 300)) { decoder.close(); decoders.delete(item.clipId); decoder = null; }
    if (!decoder) {
      const total = [...decoders.values()].reduce((n, d) => n + d.buffer.length, 0) + media.width * media.height * 4;
      if (total > config.decodedBudgetBytes) throw new Error(`Active decoded frames exceed ${config.decodedBudgetBytes} byte budget`);
      decoder = new Decoder(media, config.ffmpeg, index, path.join(config.work, 'decode.log')); decoders.set(item.clipId, decoder); stats.restarts++;
    }
    const previous = decoder.index;
    let buffer;
    try { buffer = await decoder.read(index); }
    catch (error) {
      if (!media.hwaccel) throw error;
      decoder.close(); media.hwaccel = false;
      decoder = new Decoder(media, config.ffmpeg, index, path.join(config.work, 'decode.log'));
      decoders.set(item.clipId, decoder); buffer = await decoder.read(index);
    }
    stats.decodedSourceFrames += index - previous;
    if (canvas.width !== media.width || canvas.height !== media.height) { canvas.width = media.width; canvas.height = media.height; }
    canvas.getContext('2d', { colorSpace: 'srgb' }).putImageData(new ImageData(new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength), media.width, media.height, { colorSpace: 'srgb' }), 0, 0);
  }
  stats.peakDecodedBytes = Math.max(stats.peakDecodedBytes, [...decoders.values()].reduce((n, d) => n + d.buffer.length, 0));
  stats.peakDecoders = Math.max(stats.peakDecoders, decoders.size);
  return { ...stats };
}
contextBridge.exposeInMainWorld('reeletFrames', {
  getSetup: () => ({ width: config.width, height: config.height, compositionWidth: config.project.resolution.width, compositionHeight: config.project.resolution.height, graphics: config.graphics, clips: config.project.clips.filter(c => config.media[c.mediaId]?.file).map(c => ({ id: c.id, mediaId: c.mediaId, kind: c.stream === 'audio' ? 'audio' : config.media[c.mediaId].kind })) }),
  draw,
  close: () => { for (const d of decoders.values()) d.close(); decoders.clear(); return { ...stats }; }
});
window.addEventListener('beforeunload', () => { for (const d of decoders.values()) d.close(); });
