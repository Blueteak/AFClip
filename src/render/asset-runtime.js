// Shared composition path for native playback and exact export. Images stay in
// browser/GPU memory; only arbitrary DOM intermediates need a raster fallback.
window.AssetRuntime = class AssetRuntime {
  constructor(stage, setup, raster) {
    this.stage=stage; this.setup=setup; this.raster=raster; this.entries=new Map(); this.pending=new Map(); this.serial=0; this.closed=false;this.epoch=0;
    this.width=setup.compositionWidth||setup.width; this.height=setup.compositionHeight||setup.height;
    // Keep native preview clips on the same pixel grid across transition edges.
    // Direct video/CSS and iframe surfaces can snap differently at monitor scale.
    this.compositedClips=new Set();
    this.stats={frames:0,totalMs:0,maxMs:0,skipped:0,samples:[]};
    this.receive=e=>{
      const d=e.data,p=this.pending.get(d?.requestId);
      if(!p||p.source!==e.source)return;
      if(d.type==='afclip-asset-ready'||d.type==='afclip-asset-error'){
        this.pending.delete(d.requestId);clearTimeout(p.timer);
        d.type==='afclip-asset-error'?p.reject(new Error(`${p.name}: ${d.error}`)):p.resolve(d.bitmap);
      }
    };
    window.addEventListener('message',this.receive);
    // Load code ahead of the first visible frame; no source images are allocated yet.
    for(const clip of setup.plan?.clips||[]){for(const tr of clip.transitions||[])this.entry('transition:'+tr.id,tr.assetId);for(const effect of clip.effects||[])this.entry('effect:'+clip.id+':'+effect.id,effect.assetId);}
  }
  entry(id, assetId) {
    if(this.entries.has(id))return this.entries.get(id);
    const asset=this.setup.graphics[assetId];if(!asset?.asset)throw new Error(`Missing HTML asset ${assetId}`);
    const iframe=document.createElement('iframe');iframe.sandbox='allow-scripts';iframe.title=asset.asset.name;
    Object.assign(iframe.style,{position:'absolute',left:'0',top:'0',width:this.width+'px',height:this.height+'px',border:'0',transform:'none',pointerEvents:'none'});
    const entry={iframe,asset,loaded:new Promise((resolve,reject)=>{iframe.onload=resolve;iframe.onerror=()=>reject(new Error(`Cannot load ${asset.asset.name}`));})};
    iframe.src=asset.url;this.stage.append(iframe);iframe.style.visibility='hidden';this.entries.set(id,entry);return entry;
  }
  content(id,mediaId,iframe,loaded,item){
    const key='content:'+id;
    if(!this.entries.has(key))this.entries.set(key,{iframe,loaded,asset:this.setup.graphics[mediaId]});
    return this.render(key,{assetId:mediaId,params:item.params,seed:item.seed},[],{time:item.sourceTime,progress:item.progress||0,duration:item.duration||0},false,{x:item.paramTime??item.sourceTime,span:item.paramSpan});
  }
  // `curve` gives the curve coordinate and percentage-default span for this instance.
  async render(id, instance, inputs, context, bitmap=false, curve={}) {
    const began=performance.now();const entry=this.entry(id,instance.assetId);await entry.loaded;
    if(this.closed){inputs.forEach(i=>i.close());return null;}
    const schema=window.AFClipAssetSchema,params=schema.parameters(entry.asset.asset,instance.params,curve);
    const data={...context,width:this.width,height:this.height,params,text:schema.textValues(entry.asset.asset,instance.params),seed:instance.seed||0};
    // Preserve fallback copies only for intermediates that render arbitrary DOM.
    const backup=bitmap?await Promise.all(inputs.map(i=>createImageBitmap(i))):[];
    let result;
    try {
      result=await new Promise((resolve,reject)=>{
        const requestId=++this.serial,timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error(`${entry.asset.asset.name}: render timed out`));},10000);
        this.pending.set(requestId,{source:entry.iframe.contentWindow,resolve,reject,timer,name:entry.asset.asset.name});
        entry.iframe.contentWindow.postMessage({type:'afclip-asset-render',requestId,...data,inputs,bitmap},'*',inputs);
      });
      if(bitmap&&!result){
        const encoded=await Promise.all(backup.map(async image=>{
          const canvas=new OffscreenCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);
          return Array.from(new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer()));
        }));
        result=await this.rasterImage(instance.assetId,{...data,params:instance.params,x:curve.x,span:curve.span,inputs:encoded});
      }
      this.stats.samples.push({id,time:context.time,wall:performance.now(),ms:performance.now()-began});if(this.stats.samples.length>10000)this.stats.samples.shift();
      return result;
    } finally {backup.forEach(i=>i.close());}
  }
  async rasterImage(assetId,data){
    if(!this.raster)throw new Error('HTML image capture is unavailable');
    const png=await this.raster({assetId,...data});return createImageBitmap(new Blob([new Uint8Array(png)],{type:'image/png'}));
  }
  async input(item,entry){
    const w=this.width,h=this.height,tr=item.transform;
    let source=entry.still&&!entry.still.hidden?entry.still:entry.content,owned;
    if(item.kind==='graphic'){
      source=owned=await this.rasterImage(item.mediaId,{time:item.sourceTime,text:item.text,width:this.setup.graphics[item.mediaId].width,height:this.setup.graphics[item.mediaId].height,params:item.params,seed:item.seed,x:item.paramTime,span:item.paramSpan});
    }
    if(!source)throw new Error(`Input ${item.clipId} is not ready`);
    const canvas=entry.assetInput||(entry.assetInput=new OffscreenCanvas(w,h)),ctx=canvas.getContext('2d');
    if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
    ctx.clearRect(0,0,w,h);ctx.save();ctx.globalAlpha=item.opacity;
    ctx.translate(w/2+(tr.x||0),h/2+(tr.y||0));ctx.rotate((tr.rotation||0)*Math.PI/180);ctx.scale(tr.scale||1,tr.scale||1);
    const sw=source.videoWidth||source.naturalWidth||source.width,sh=source.videoHeight||source.naturalHeight||source.height;
    const fit=tr.fit==='fill'?Math.max(w/sw,h/sh):Math.min(w/sw,h/sh);
    // object-fit crops within the clip box before its outer transform.
    // Cropping afterwards would rotate discarded source pixels back into view.
    if(tr.fit==='fill')ctx.drawImage(source,(sw-w/fit)/2,(sh-h/fit)/2,w/fit,h/fit,-w/2,-h/2,w,h);
    else ctx.drawImage(source,-sw*fit/2,-sh*fit/2,sw*fit,sh*fit);
    ctx.restore();owned?.close();
    let image=canvas.transferToImageBitmap();
    for(const effect of item.effects||[])image=await this.render('effect:'+item.clipId+':'+effect.id,effect,[image],{time:item.sourceTime,progress:item.progress,duration:item.duration},true,{x:item.paramTime,span:window.AFClipAssetSchema.span(effect,item.visibleSpan)});
    return image;
  }
  needsComposition(item){return !!item&&(!!item.effects?.length||this.compositedClips.has(item.clipId));}
  async compose(items,entries,epoch=this.epoch){
    const started=performance.now();
    const transitions=new Map(),effectItems=[];
    for(const item of items){if(item.kind==='audio')continue;if(item.transition){const tr=item.transition;if(!transitions.has(tr.id))transitions.set(tr.id,{tr,items:[]});transitions.get(tr.id).items.push(item);}else if(this.needsComposition(item))effectItems.push(item);}
    for(const item of effectItems){
      const entry=entries.get(item.clipId);
      if(this.compositedClips.has(item.clipId)&&!entry.still?.width&&(!entry.content||(item.kind==='video'&&entry.content.readyState<2)))continue;
      const image=await this.input(item,entry);
      if(this.closed||epoch!==this.epoch){image?.close();return;}
      if(!entry.effectOutput){entry.effectOutput=document.createElement('canvas');this.stage.append(entry.effectOutput);Object.assign(entry.effectOutput.style,{position:'absolute',inset:'0',width:'100%',height:'100%'});}
      const out=entry.effectOutput;if(out.width!==this.width)out.width=this.width;if(out.height!==this.height)out.height=this.height;const ctx=out.getContext('2d');ctx.clearRect(0,0,this.width,this.height);ctx.drawImage(image,0,0);image.close();out.hidden=false;out.style.zIndex=entry.layer.style.zIndex;entry.layer.style.visibility='hidden';
    }
    for(const {tr,items:pair} of transitions.values()){
      const a=pair.find(i=>i.clipId===tr.fromClipId),b=pair.find(i=>i.clipId===tr.toClipId);
      if(!a||!b)throw new Error(`Transition ${tr.id} needs two visual inputs`);
      const images=await Promise.all([a,b].map(i=>this.input(i,entries.get(i.clipId))));
      const bitmapOutput=!!(this.setup.exactFrames||this.compositedClips.has(a.clipId)||this.compositedClips.has(b.clipId));
      const image=await this.render('transition:'+tr.id,tr,images,{time:tr.time,progress:tr.progress,duration:tr.duration},bitmapOutput,{x:tr.progress,span:[0,1]});
      if(this.closed||epoch!==this.epoch){image?.close();return;}
      const entry=this.entries.get('transition:'+tr.id);
      let output=entry.iframe;
      if(bitmapOutput){
        // An iframe acknowledgement does not fence its compositor paint. Exact
        // export uses the acknowledged bitmap in the same document as its token.
        if(!entry.output){entry.output=document.createElement('canvas');this.stage.append(entry.output);Object.assign(entry.output.style,{position:'absolute',inset:'0',width:'100%',height:'100%'});}
        output=entry.output;
        if(output.width!==this.width)output.width=this.width;if(output.height!==this.height)output.height=this.height;
        const ctx=output.getContext('2d');ctx.clearRect(0,0,this.width,this.height);
        try{ctx.drawImage(image,0,0);}finally{image?.close();}
        output.hidden=false;entry.iframe.style.visibility='hidden';
      }
      output.style.zIndex=entries.get(b.clipId).layer.style.zIndex;output.style.visibility='visible';
      entries.get(a.clipId).layer.style.visibility=entries.get(b.clipId).layer.style.visibility='hidden';
      for(const item of pair){const entry=entries.get(item.clipId);if(entry.effectOutput)entry.effectOutput.hidden=true;}
    }
    const ms=performance.now()-started;this.stats.frames++;this.stats.totalMs+=ms;this.stats.maxMs=Math.max(ms,this.stats.maxMs);
  }
  reset(entries,items,seeking=false){
    if(this.setup.compositeTransitions&&this.compositionPlan!==this.setup.plan){
      this.compositionPlan=this.setup.plan;
      this.compositedClips=new Set((this.compositionPlan?.clips||[]).filter(c=>c.transitions?.length&&['video','image'].includes(c.media.kind)).map(c=>c.id));
    }
    const signature=items.filter(i=>i.kind!=='audio').map(i=>i.clipId+':'+(i.transition?.id||'')).join('|');if(seeking||signature!==this.signature){this.epoch++;this.signature=signature;}
    const active=new Map(items.map(i=>[i.clipId,i])),transitions=new Set(items.filter(i=>i.transition).map(i=>'transition:'+i.transition.id));
    this.transitionFallbacks??=new Map();
    for(const id of this.transitionFallbacks.keys())if(!transitions.has(id))this.transitionFallbacks.delete(id);
    for(const item of items)if(item.transition){
      const tr=item.transition,key='transition:'+tr.id;
      if(!this.transitionFallbacks.has(key)){
        // Entering backwards should retain the incoming clip we were viewing.
        const fromIncoming=this.previousItems?.has(tr.toClipId)&&!this.previousItems.has(tr.fromClipId);
        this.transitionFallbacks.set(key,fromIncoming?tr.toClipId:tr.fromClipId);
      }
    }
    for(const [id,e] of this.entries)if(!transitions.has(id)&&!id.startsWith('content:')){e.iframe.style.visibility='hidden';if(e.output)e.output.hidden=true;}
    for(const [id,entry] of entries){
      const item=active.get(id);
      if(item?.transition){
        // Layout runs before asynchronous input preparation/rendering. Never
        // expose the other source while waiting for the first asset frame.
        const key='transition:'+item.transition.id,transitionEntry=this.entries.get(key),ready=transitionEntry?.output?!transitionEntry.output.hidden:transitionEntry?.iframe.style.visibility==='visible';
        const fallback=id===this.transitionFallbacks.get(key)&&!ready;
        const keepEffect=fallback&&this.needsComposition(item)&&entry.effectOutput&&!entry.effectOutput.hidden;
        entry.layer.style.visibility=fallback&&!keepEffect&&!this.needsComposition(item)?'':'hidden';
        if(entry.effectOutput)entry.effectOutput.hidden=!keepEffect;
      }else{
        // An effect can make an opaque source fully transparent. Never expose
        // that source while its first processed frame is still in flight.
        entry.layer.style.visibility=this.needsComposition(item)?'hidden':'';
        // Retain a completed frame during scrubbing, but never resurrect it on
        // re-entry or at the start of a reveal that should begin transparent.
        // The unprocessed source stays hidden until compose produces output.
        if(entry.effectOutput&&(!this.needsComposition(item)||!this.previousItems?.has(id)||(seeking&&item.progress<=0)))entry.effectOutput.hidden=true;
      }
    }
    this.previousItems=active;
  }
  async frame(items,entries){const epoch=++this.epoch;await this.work?.catch(()=>{});if(this.closed||epoch!==this.epoch)return;const work=this.compose(items,entries,epoch);this.work=work;try{await work;}finally{if(this.work===work)this.work=null;}}
  update(items,entries,onError){if(this.work){this.stats.skipped++;return;}this.work=this.compose(items,entries).catch(onError).finally(()=>{this.work=null;});}
  close(){this.closed=true;this.epoch++;window.removeEventListener('message',this.receive);for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve(null);}this.pending.clear();for(const e of this.entries.values()){e.iframe.remove();e.output?.remove();}this.entries.clear();}
};
