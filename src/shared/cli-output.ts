// Presentation only. Stored projects and HTTP responses keep their complete schema.
// Cull only known defaults, never arbitrary false/zero/empty user values.
export function compactResult(value:any):any {
 if(Array.isArray(value))return value.map(compactResult);
 if(!value||typeof value!=='object')return value;
 const out={...value};
 const omit=(key:string,expected:any)=>{if(JSON.stringify(out[key])===JSON.stringify(expected))delete out[key];};
 const empty=(...keys:string[])=>{for(const key of keys){omit(key,[]);omit(key,{});}};
 if(value.project&&value.revisions){omit('renderLock',null);}
 if(value.trackId&&value.mediaId){
  omit('volume',1);omit('mute',false);omit('speed',{num:1,den:1});
  for(const key of ['sourceIn','fadeIn','fadeOut'])omit(key,{num:0,den:1});
  omit('linkId',null);empty('effects','volumePoints','text');
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
  omit('deleted',false);omit('purged',false);omit('notes','');empty('tags','takes','annotationTracks','references','ranges');
  omit('availability','available');omit('sourceStatus','verified');
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
