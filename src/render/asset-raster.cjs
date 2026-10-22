// Slow fallback for arbitrary HTML used as an intermediate image. Ordinary
// video inputs and canvas-returning effects never cross this IPC boundary.
const { BrowserWindow } = require('electron');
module.exports = function assetRaster(graphics) {
  const windows = new Map();
  async function render(data) {
    const asset=graphics()[data.assetId];if(!asset)throw new Error('Unknown asset image');
    const width=Math.round(data.width),height=Math.round(data.height);
    if(!(width>0&&height>0&&width<=4096&&height<=4096))throw new Error('Invalid asset image size');
    let entry=windows.get(data.assetId);
    if(!entry){
      while(windows.size>=8){const [id,old]=windows.entries().next().value;old.win.destroy();windows.delete(id);}
      const win=new BrowserWindow({show:false,width,height,useContentSize:true,transparent:true,backgroundColor:'#00000000',webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,nodeIntegration:false,contextIsolation:true}});
      win.webContents.on('will-navigate',(event,url)=>{if(url!==asset.url)event.preventDefault();});
      win.webContents.setFrameRate(60);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      entry={win,ready:win.loadURL(asset.url)};windows.set(data.assetId,entry);
    }
    await entry.ready;
    entry.win.setContentSize(width,height);
    const schema=require('../shared/asset.cjs'),payload={...data};if(asset.asset){payload.params=schema.parameters(asset.asset,data.params,{x:data.x,span:data.span});payload.text=schema.textValues(asset.asset,data.params);}delete payload.assetId;delete payload.x;delete payload.span;
    await entry.win.webContents.executeJavaScript(`(async()=>{
      const d=${JSON.stringify(payload)};
      d.inputs=await Promise.all((d.inputs||[]).map(bytes=>createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}))));
      await document.fonts.ready;
      try { ${asset.asset ? 'await window.AFClipAssetRender(d);' : "await new Promise((resolve,reject)=>{const id=Date.now();const timer=setTimeout(()=>reject(new Error('Graphic capture timed out')),10000);function receive(e){if(e.data?.requestId!==id)return;if(e.data.type==='afclip-ready'||e.data.type==='afclip-error'){clearTimeout(timer);removeEventListener('message',receive);e.data.type==='afclip-error'?reject(new Error(e.data.error)):resolve();}}addEventListener('message',receive);postMessage({type:'afclip-render',requestId:id,time:d.time,text:d.text||{}},'*');});"}
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      }finally{d.inputs.forEach(i=>i.close());}
    })()`);
    return (await entry.win.webContents.capturePage()).toPNG();
  }
  let queue=Promise.resolve();
  return {render:data=>{const work=queue.then(()=>render(data));queue=work.catch(()=>{});return work;},close:()=>{for(const e of windows.values())e.win.destroy();windows.clear();}};
};
