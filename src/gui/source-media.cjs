const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const seconds = value => typeof value === 'number' ? value : value ? value.num / value.den : 0;

// Only project media IDs enter this bridge. Renderers never grant arbitrary paths.
module.exports = function sourceMedia({ projectDir, inspect, libraryEndpoint, grantFile, grantLibrary, invalidateLibrary = () => {} }) {
  const pending = new Map();
  let active = 0;
  const waiting = [];
  async function limited(work) {
    if (active >= 3) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  async function media(id) {
    const { project } = await inspect();
    const m = project.media.find(item => item.id === id);
    if (!m) throw new Error('Media is no longer in the project bin');
    return m;
  }
  async function thumbnail(m, fullSource = false) {
    if (m.kind === 'graphic') return { url: null };
    const file = path.resolve(projectDir, m.path), stat = await fs.stat(file);
    if (m.kind === 'image') return { url: grantFile(file) };
    const start = fullSource ? 0 : Math.max(0, seconds(m.metadata?.library?.start));
    const key = createHash('sha256').update(JSON.stringify([file, stat.size, stat.mtimeMs, start, m.kind, fullSource, 2])).digest('hex');
    const output = path.join(projectDir, 'cache', 'gui', 'thumbnails', key + '.png');
    try { await fs.access(output); return { url: grantFile(output) }; } catch {}
    if (!pending.has(key)) {
      const task = limited(async () => {
        await fs.mkdir(path.dirname(output), { recursive: true });
        const temp = output + '.' + randomUUID() + '.png';
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start)];
        if (m.kind === 'audio' && !fullSource) args.push('-t', '30');
        args.push('-i', file);
        if (m.kind === 'audio') args.push('-filter_complex', 'aformat=channel_layouts=mono,aresample=1000,showwavespic=s=320x180:colors=0x5fbf91', '-frames:v', '1');
        else args.push('-an', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x121316', '-frames:v', '1');
        args.push('-threads', '1', '-y', temp);
        try {
          await run(require('ffmpeg-static'), args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
          await fs.rename(temp, output);
          return { url: grantFile(output) };
        } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      });
      pending.set(key, task);
      task.finally(() => pending.delete(key)).catch(() => {});
    }
    return pending.get(key);
  }
  async function preview(m) {
    const link = m.metadata?.library, file = path.resolve(projectDir, m.path);
    const result = {
      mediaId: m.id, kind: m.kind, name: link?.name || path.basename(m.path),
      duration: seconds(m.duration) || 5, width: m.metadata?.width || 1920, height: m.metadata?.height || 1080,
      url: m.kind === 'graphic' ? null : grantFile(file),
      audioUrl: m.kind === 'audio' || m.kind === 'video' && m.metadata?.hasAudio !== false ? grantFile(file) : null,
      imageUrl: m.kind === 'image' ? grantFile(file) : null, pts: [], seekProxy: null,
      selection: link?.end != null ? { start: seconds(link.start), end: seconds(link.end) } : null,
      annotations: null, warning: m.kind === 'graphic' ? 'Preview this graphic on the timeline.' : null,
    };
    if (link) {
      try {
        const ep = await libraryEndpoint();
        const token = new URL(ep.readerGui).searchParams.get('token');
        const read = async payload => {
          const response = await fetch(ep.url + '/command', {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
          });
          const reply = await response.json();
          if (!reply.ok) throw new Error(reply.error?.message || 'Library unavailable');
          return reply.result;
        };
        const [asset, overview] = await Promise.all([
          read({ command: 'inspect', id: link.assetId }), read({ command: 'overview' }),
        ]);
        if (asset.libraryId !== link.libraryId || asset.sourceId !== link.sourceId) {
          result.warning = 'The library source has changed. Previewing the saved project source without its replacement annotations.';
        } else if (asset.purged || asset.deleted) {
          result.warning = 'This asset was removed from the library. Previewing the saved project source.';
        } else {
          const tags = new Map(overview.tags.map(tag => [tag.id, tag.name]));
          const names = ids => (ids || []).map(id => tags.get(id)).filter(Boolean);
          const ranges = [...(asset.ranges || [])];
          let page = asset.rangePage;
          while (page?.nextOffset != null) {
            const next = await read({ command: 'inspect', id: asset.id, rangeOffset: page.nextOffset });
            ranges.push(...next.ranges); page = next.rangePage;
          }
          result.annotations = {
            name: asset.name, notes: asset.notes || '', tags: names(asset.tags),
            tracks: asset.annotationTracks || [{ id: 'annotations', name: 'Annotations' }],
            ranges: ranges.map(range => ({ id: range.id, name: range.name, start: seconds(range.start), end: seconds(range.end),
              tags: names(range.tags), notes: range.notes || '', trackId: range.trackId || 'annotations' })),
            takes: asset.takes || [],
          };
          result.name = link?.rangeId || link?.temporary ? link.name || asset.name : asset.name;
          if (asset.availability === 'available') {
            const source = await read({ command: 'preview', id: asset.id });
            result.url = grantLibrary(source.url, ep);
            result.audioUrl = result.audioUrl ? grantLibrary(source.audioUrl, ep) : null;
            result.pts = source.pts;
            result.seekProxy = source.seekProxy ? { ...source.seekProxy, url: grantLibrary(source.seekProxy.url, ep) } : null;
          } else result.warning = 'Library source unavailable. Using the saved project path.';
          if (link.rangeId && !link.temporary) {
            const range = ranges.find(r => r.id === link.rangeId);
            if (!range || range.revision !== link.rangeRevision) result.warning = 'The library range has changed. The saved project selection is unchanged.';
          }
        }
      } catch {
        invalidateLibrary();
        result.warning = 'Library annotations unavailable. Using the saved project source.';
      }
    }
    return result;
  }
  return {
    thumbnail: async id => thumbnail(await media(id)),
    preview: async id => preview(await media(id)),
    waveform: async (id, options = {}) => {
      const m = await media(id);
      if (!['audio', 'video'].includes(m.kind)) throw new Error('This source has no audio waveform');
      const total = seconds(m.duration), start = Number(options?.start ?? 0), duration = Number(options?.duration ?? total - start);
      if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 || start + duration > total + 1e-6) throw new Error('Waveform range must be within the source');
      const channels = m.metadata?.streams?.find(s => s.codec_type === 'audio')?.channels;
      return require('../render/audio-waveform.cjs').audioWaveform(path.resolve(projectDir, m.path), {
        start, duration, bins: options?.bins, channels, cacheDir: path.join(projectDir, 'cache', 'gui', 'waveforms'),
      });
    },
  };
};
