const fs = require('node:fs/promises');

// Fragmented MP4 keeps sample counts in each track run instead of stsz/nb_frames.
// Read box headers and counts only; skip mdat payloads. This deliberately supports
// empty initial sample tables, not hybrid or otherwise ambiguous layouts.
async function fragmentSampleCount(file, trackId) {
  if (trackId != null && (!Number.isSafeInteger(trackId) || trackId <= 0)) return null;
  let handle, boxesRead = 0;
  try {
    handle = await fs.open(file, 'r');
    const size = (await handle.stat()).size;
    async function read(offset, length, end) {
      if (offset + length > end) throw new Error('Truncated MP4 box');
      const buffer = Buffer.alloc(length);
      if ((await handle.read(buffer, 0, length, offset)).bytesRead !== length) throw new Error('Truncated MP4 file');
      return buffer;
    }
    async function boxes(start, end) {
      const result = [];
      for (let offset = start; offset < end;) {
        if (++boxesRead > 100000) throw new Error('MP4 box limit');
        const header = await read(offset, 8, end);
        let length = header.readUInt32BE(0), bytes = 8;
        if (length === 1) {
          length = Number((await read(offset + 8, 8, end)).readBigUInt64BE(0));
          bytes = 16;
        } else if (length === 0) length = end - offset;
        if (!Number.isSafeInteger(length) || length < bytes || length > end - offset) throw new Error('Invalid MP4 box size');
        result.push({ type: header.toString('ascii', 4, 8), start: offset + bytes, end: offset + length });
        offset += length;
      }
      return result;
    }
    const children = box => boxes(box.start, box.end);
    function one(list, type) {
      const found = list.filter(box => box.type === type);
      if (found.length !== 1) throw new Error(`Expected one ${type}`);
      return found[0];
    }
    const top = await boxes(0, size);
    const movie = await children(one(top, 'moov'));
    let selected;
    for (const track of movie.filter(box => box.type === 'trak')) {
      const entries = await children(track), header = one(entries, 'tkhd');
      const version = (await read(header.start, 1, header.end))[0];
      if (version !== 0 && version !== 1) return null;
      const id = (await read(header.start + (version === 1 ? 20 : 12), 4, header.end)).readUInt32BE(0);
      const media = await children(one(entries, 'mdia')), handler = one(media, 'hdlr');
      if ((await read(handler.start + 8, 4, handler.end)).toString('ascii') !== 'vide') continue;
      if (trackId != null && id !== trackId) continue;
      if (selected) return null;
      selected = { id, media };
    }
    if (!selected) return null;
    // Older ffprobe does not expose MOV track IDs. Accept only a single video
    // track in that case, so audio/alternate video counts cannot be mistaken.
    trackId = selected.id;
    if (!trackId) return null;
    const media = selected.media;
    const info = await children(one(media, 'minf'));
    const table = await children(one(info, 'stbl')), sizes = one(table, 'stsz');
    const initial = await read(sizes.start, 12, sizes.end);
    if (initial.readUInt32BE(0) !== 0 || initial.readUInt32BE(8) !== 0 || sizes.end - sizes.start !== 12) return null;
    const extensions = await children(one(movie, 'mvex'));
    let defaults = 0;
    for (const entry of extensions.filter(box => box.type === 'trex')) {
      const data = await read(entry.start, 24, entry.end);
      if (data.readUInt32BE(0) !== 0) return null;
      if (data.readUInt32BE(4) === trackId) defaults++;
    }
    if (defaults !== 1) return null;

    let count = 0;
    for (const fragment of top.filter(box => box.type === 'moof')) {
      for (const track of (await children(fragment)).filter(box => box.type === 'traf')) {
        const entries = await children(track), header = one(entries, 'tfhd');
        const data = await read(header.start, 8, header.end);
        if (data.readUInt32BE(4) !== trackId) continue;
        const flags = data.readUInt32BE(0);
        if (flags & ~0x02003b) return null; // No unknown version/flags or duration-is-empty.
        const headerBytes = 8 + (flags & 1 ? 8 : 0) + [2, 8, 16, 32].filter(flag => flags & flag).length * 4;
        if (header.end - header.start !== headerBytes) return null;
        const runs = entries.filter(box => box.type === 'trun');
        if (!runs.length) return null;
        for (const run of runs) {
          const data = await read(run.start, 8, run.end), version = data[0], flags = data.readUIntBE(1, 3);
          if (version > 1 || flags & ~0x000f05 || (flags & 4 && flags & 0x400)) return null;
          const samples = data.readUInt32BE(4);
          const fields = [0x100, 0x200, 0x400, 0x800].filter(flag => flags & flag).length;
          const bytes = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0) + samples * fields * 4;
          if (run.end - run.start !== bytes) return null;
          count += samples;
          if (!Number.isSafeInteger(count)) return null;
        }
      }
    }
    return count > 0 ? count : null;
  } catch {
    return null; // Unsupported, missing, malformed or truncated: decode instead.
  } finally {
    await handle?.close();
  }
}

module.exports = fragmentSampleCount;
