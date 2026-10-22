// Presentation only. Stored projects and HTTP responses keep their complete schema.
// Cull only known defaults, never arbitrary false/zero/empty user values.
export function projectChanges(before:any,after:any):any {
 if(!after?.project||!after.revisions)return after;
 const {project,revisions,...rest}=after;
 if(rest.generations){const old=new Map((before.generations||[]).map((j:any)=>[j.id,JSON.stringify(j)]));rest.generations=rest.generations.filter((j:any)=>old.get(j.id)!==JSON.stringify(j));if(!rest.generations.length)delete rest.generations;}
 const changes:any={},removed:any={},order:any={};
 const collections=new Set(['media','tracks','clips','transitions','markers','folders']);
 const same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
 for(const key of new Set([...Object.keys(before.project),...Object.keys(project)])){
  if(['revision','relationshipRevisions'].includes(key))continue;
  if(collections.has(key)){
   const old=before.project[key]||[],next=project[key]||[];
   const byId=new Map(old.map((o:any)=>[o.id,o])),ids=new Set(next.map((o:any)=>o.id));
   // Undo/redo bump every object's revision, even when its content is unchanged.
   // Those revisions already appear in the revision map below.
   const content=(o:any)=>{if(!o)return o;const {revision,...rest}=o;return rest;};
   const changed=next.filter((o:any)=>!same(content(byId.get(o.id)),content(o)));
   if(changed.length)changes[key]=changed;
   const deleted=old.filter((o:any)=>!ids.has(o.id)).map((o:any)=>o.id);
   if(deleted.length)removed[key]=deleted;
   // Collection order is information too, especially track compositing order.
   // Removals and appended additions are already implied by removed/changes.
   const kept=old.map((o:any)=>o.id).filter((id:string)=>ids.has(id)),nextIds=next.map((o:any)=>o.id);
   if(!same(kept,nextIds.slice(0,kept.length)))order[key]=nextIds;
  }else if(!same(before.project[key],project[key])){
   if(key in project)(changes.project??={})[key]=project[key];
   else (removed.project??=[]).push(key);
  }
 }
 const changedRevisions=Object.fromEntries(Object.entries(revisions).filter(([key,value])=>before.revisions[key]!==value));
 const removedRevisions=Object.keys(before.revisions).filter(key=>!(key in revisions));
 return {...rest,baseRevision:before.project.revision,revision:project.revision,
  ...(Object.keys(changes).length?{changes}:{}),...(Object.keys(removed).length?{removed}:{}),
  ...(Object.keys(order).length?{order}:{}),revisions:changedRevisions,
  ...(removedRevisions.length?{removedRevisions}:{})};
}

export function compactResult(value:any):any {
 if(Array.isArray(value))return value.map(compactResult);
 if(!value||typeof value!=='object')return value;
 const out={...value};
 const omit=(key:string,expected:any)=>{if(JSON.stringify(out[key])===JSON.stringify(expected))delete out[key];};
 const empty=(...keys:string[])=>{for(const key of keys){omit(key,[]);omit(key,{});}};
 if(value.metadata&&(value.kind||value.recordType==='source')){
  const {streams,format,...metadata}=value.metadata;
  // Stills have no frame timing; only set disposition flags carry information.
  const still=value.kind==='image';
  if(still&&metadata.fps==='0/0')delete metadata.fps;
  if(Array.isArray(streams))metadata.streams=streams.map((s:any)=>{
   const stream:any=Object.fromEntries(
    ['index','codec_type','codec_name','profile','field_order','width','height','pix_fmt','sample_fmt','sample_rate','channels','channel_layout',...(still?[]:['time_base','avg_frame_rate','r_frame_rate']),'duration','start_time','nb_frames','color_space','color_transfer','color_primaries','color_range','disposition','tags','side_data_list']
     .filter(key=>s[key]!==undefined).map(key=>[key,s[key]]));
   if(stream.disposition){const flags=Object.fromEntries(Object.entries(stream.disposition).filter(([,v])=>v));if(Object.keys(flags).length)stream.disposition=flags;else delete stream.disposition;}
   return stream;
  });
  if(format)metadata.format=Object.fromEntries(['format_name','duration','start_time','size','bit_rate','tags'].filter(key=>format[key]!==undefined).map(key=>[key,format[key]]));
  out.metadata=metadata;
 }
 if(value.id&&value.kind&&['queued','running','completed','failed','cancelled','cancelling'].includes(value.status)){
  omit('queuePosition',null);
  if(value.status==='completed'){omit('progress',1);if(['Ready','completed'].includes(value.phase))delete out.phase;}
 }
 if(value.artifact&&Array.isArray(value.jobs)){
  out.jobs=value.jobs.map((job:any)=>{
   if(job.kind!=='artifact'||!job.result)return job;
   const extra=Object.fromEntries(Object.entries(job.result).filter(([key,v])=>JSON.stringify(value.artifact[key])!==JSON.stringify(v)));
   const {result,...rest}=job;return Object.keys(extra).length?{...rest,result:extra}:rest;
  });
 }
 if(Array.isArray(value.pts)&&value.startFrame===undefined){
  delete out.pts;
  out.frameCount=value.pts.length;
  if(value.pts.length)out.timing={first:value.pts[0],last:value.pts.at(-1)};
 }
 if(value.revisions&&(value.project||value.baseRevision!==undefined)){omit('renderLock',null);}
 // Import results name the new media; don't repeat it under changes.
 if(value.media?.id&&Array.isArray(value.changes?.media)){
  const media=value.changes.media.filter((m:any)=>JSON.stringify(m)!==JSON.stringify(value.media)),{media:_,...changes}=value.changes;
  out.changes=media.length?{...changes,media}:changes;
  if(!Object.keys(out.changes).length)delete out.changes;
 }
 if(value.trackId&&value.mediaId){
  omit('volume',1);omit('mute',false);omit('speed',{num:1,den:1});
  for(const key of ['sourceIn','fadeIn','fadeOut'])omit(key,{num:0,den:1});
  omit('linkId',null);omit('generationId',null);empty('effects','volumePoints','text','params');
  if(value.transform){
   out.transform={...value.transform};
   for(const [key,defaultValue] of Object.entries({x:0,y:0,rotation:0,scale:1,opacity:1,fit:'fit'}))
    if(out.transform[key]===defaultValue)delete out.transform[key];
   empty('transform');
  }
 }
 if(value.id&&typeof value.disabled==='boolean'&&typeof value.locked==='boolean'){
  omit('disabled',false);omit('locked',false);omit('collapsed',false);omit('folderId',null);
 }
 if(['asset','range'].includes(value.recordType)){
  omit('deleted',false);omit('purged',false);omit('notes','');empty('tags','takes','blocks','annotationTracks','references','ranges');
  omit('availability','available');omit('sourceStatus','verified');
 }
 if(value.clipId&&Array.isArray(value.fields)&&value.mediaRevision!==undefined){
  out.fields=value.fields.map((field:any)=>{
   const f={...field};
   if(f.overridden===false)delete f.overridden;
   if(f.value===f.default)delete f.value;
   return f;
  });
  empty('missing');
 }
 // These objects can contain user-authored values or exact machine data.
 const opaque=new Set(['metadata','params','text','revisions','relationshipRevisions','error','details','operations']);
 for(const key of Object.keys(out))if(!opaque.has(key))out[key]=compactResult(out[key]);
 return out;
}

export function formatResponse(response:any,options:{full?:boolean;pretty?:boolean}={}) {
 const output=options.full?response:{...response,...('result' in response?{result:compactResult(response.result)}:{})};
 if(!options.full&&output.status==='complete')delete output.status;
 return JSON.stringify(output,null,options.pretty?2:undefined);
}
