// Inspect the finished MP4 without decoding pixels. The encoders deliberately
// produce one H.264 packet per frame with no B-frame reordering.
const { performance } = require('node:perf_hooks');
const packetEntries = 'packet=stream_index,pts,dts,duration,flags:stream=index,codec_type,codec_name,width,height,avg_frame_rate,time_base,start_pts,duration_ts,nb_frames,has_b_frames,sample_rate,channels';
function requireValid(condition, message) {
  if (!condition) throw new Error(`Export verification failed: ${message}`);
}
function fraction(value) {
  const [n, d] = String(value || '').split('/').map(Number);
  return Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d : NaN;
}
function checkContainer(info, expected) {
  const video = info.streams?.find(s => s.codec_type === 'video');
  const audio = info.streams?.find(s => s.codec_type === 'audio');
  requireValid(video?.codec_name === 'h264' && audio?.codec_name === 'aac', 'H.264 video and AAC audio are required');
  requireValid(video.width === expected.width && video.height === expected.height, 'incorrect video dimensions');
  requireValid(video.has_b_frames === 0, 'unexpected video frame reordering');
  requireValid(Math.abs(fraction(video.avg_frame_rate) - expected.fps) < expected.fps * 1e-5, 'incorrect frame rate');
  const videoTick = fraction(video.time_base), audioTick = fraction(audio.time_base);
  requireValid(videoTick > 0 && audioTick > 0, 'missing stream time bases');
  requireValid(video.start_pts === 0 && audio.start_pts === 0, 'streams must start at zero');
  // MP4's default 1 kHz movie timescale can round the edit duration and
  // final packet by up to 1 ms, even when sample PTS are exact.
  const endTolerance = 0.001 + 2 * videoTick;
  requireValid(Math.abs(video.duration_ts * videoTick - expected.frames / expected.fps) <= endTolerance, 'incorrect video duration');
  requireValid(Number(audio.sample_rate) === 48000 && audio.channels === 2, 'incorrect audio format');
  const audioTolerance = 1024 / 48000 + 2 * audioTick;
  requireValid(Math.abs(audio.duration_ts * audioTick - expected.duration) <= audioTolerance, 'incorrect audio duration');
  const vp = (info.packets || []).filter(p => p.stream_index === video.index);
  const ap = (info.packets || []).filter(p => p.stream_index === audio.index);
  requireValid(Number(video.nb_frames) === expected.frames && vp.length === expected.frames, `expected ${expected.frames} video packets, found ${vp.length}`);
  requireValid(vp[0]?.flags?.includes('K'), 'video does not begin with a keyframe');
  for (const [i, p] of vp.entries()) {
    requireValid(Number.isSafeInteger(p.pts) && p.dts === p.pts && Number.isSafeInteger(p.duration) && p.duration > 0 && /^[_K]+$/.test(p.flags || ''), `invalid video packet ${i}`);
    requireValid(Math.abs(p.pts * videoTick - i / expected.fps) <= 2 * videoTick &&
      Math.abs(p.duration * videoTick - 1 / expected.fps) <= (i === vp.length - 1 ? endTolerance : 2 * videoTick), `incorrect video timing at frame ${i}`);
  }
  requireValid(ap.length > 0, 'audio packets are missing');
  for (const [i, p] of ap.entries()) {
    requireValid(Number.isSafeInteger(p.pts) && p.dts === p.pts && Number.isSafeInteger(p.duration) && p.duration > 0 && /^[_KD]+$/.test(p.flags || ''), `invalid audio packet ${i}`);
    // AAC encoder priming may appear as a negative-time discard packet.
    requireValid(!p.flags.includes('D') || p.pts < 0, `unexpected discarded audio packet ${i}`);
    if (i) requireValid(Math.abs(p.pts - ap[i - 1].pts - ap[i - 1].duration) <= 2, `audio timestamp gap at packet ${i}`);
  }
  requireValid(Math.abs(ap[0].pts * audioTick) <= audioTolerance &&
    Math.abs((ap.at(-1).pts + ap.at(-1).duration) * audioTick - expected.duration) <= audioTolerance, 'audio packets do not cover the requested range');
  return { videoPackets: vp.length, audioPackets: ap.length };
}
async function verifyOutput({ file, ffprobe, run, mode = 'quick', expected }) {
  requireValid(['quick', 'full'].includes(mode), 'unsupported verification mode');
  const started = performance.now();
  const info = JSON.parse((await run('verify-container', ffprobe, ['-v', 'error', '-show_packets', '-show_streams', '-show_entries', packetEntries, '-of', 'json', file], true)).toString());
  const result = { mode, ...checkContainer(info, expected), decodedFrames: null };
  if (mode === 'full') {
    const decoded = JSON.parse((await run('verify-decode', ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], true)).toString());
    const video = decoded.streams?.find(s => s.codec_type === 'video');
    const audio = decoded.streams?.find(s => s.codec_type === 'audio');
    requireValid(Number(video?.nb_read_frames) === expected.frames && Number(audio?.nb_read_frames) > 0, 'decoded video frame count or audio is incomplete');
    result.decodedFrames = Number(video.nb_read_frames);
  }
  return { ...result, ms: performance.now() - started };
}
module.exports = { verifyOutput, checkContainer };
