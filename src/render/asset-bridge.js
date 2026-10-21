// Runs inside an opaque-origin HTML asset. Only time, parameters and images cross the boundary.
(() => {
  const random = seed => { let n = seed >>> 0; return () => { n += 0x6D2B79F5; let t = Math.imul(n ^ n >>> 15, n | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
  window.AFClipAssetRender = async data => {
    await document.fonts.ready;
    if (typeof window.render !== 'function') throw new Error('Asset must define window.render(context)');
    window.AFClipApplyText?.(data.text);
    return window.render({ apiVersion:1, time:data.time, progress:data.progress, duration:data.duration,
      width:data.width, height:data.height, params:data.params || {}, seed:data.seed, random:random(data.seed), inputs:data.inputs || [] });
  };
  window.addEventListener('message', async event => {
    const d = event.data;
    if (event.source !== parent || d?.type !== 'afclip-asset-render') return;
    const inputs = d.inputs || [];
    try {
      const result = await window.AFClipAssetRender(d);
      // A returned canvas is a fast, GPU-backed image for chaining effects.
      const bitmap = d.bitmap && result ? await createImageBitmap(result) : null;
      parent.postMessage({ type:'afclip-asset-ready', requestId:d.requestId, bitmap }, '*', bitmap ? [bitmap] : []);
    } catch (error) { parent.postMessage({ type:'afclip-asset-error', requestId:d.requestId, error:error.message }, '*'); }
    finally { for (const input of inputs) input.close?.(); }
  });
})();
