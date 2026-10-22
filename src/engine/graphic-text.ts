import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'parse5';
import {assert,fail,trackLocked} from '../shared/project.ts';

// Only explicit, static, plain-text fields are editable. Never rewrite source code.
function graphicEntry(dir:string, media:any) {
 assert(media?.kind==='graphic','Select a graphic clip');
 const root=fs.realpathSync(path.resolve(dir,media.path));
 const file=fs.realpathSync(path.resolve(root,media.metadata.entry||'index.html'));
 assert(file.startsWith(root+path.sep),'Graphic entry escaped its asset folder');
 return file;
}
// Read-only entry HTML of the accepted snapshot, as rendered.
export function graphicSource(state:any, mediaId:string) {
 const media=state.p.media.find((m:any)=>m.id===mediaId);assert(media,'Media not found',{mediaId});
 const file=graphicEntry(state.dir,media),limit=2*1024*1024,size=fs.statSync(file).size;
 const fd=fs.openSync(file,'r');try{const bytes=Buffer.alloc(Math.min(size,limit));fs.readSync(fd,bytes,0,bytes.length,0);
  return {mediaId,mediaRevision:media.revision,entry:media.metadata.entry||'index.html',size,truncated:size>limit,html:bytes.toString('utf8')};}finally{fs.closeSync(fd);}
}
export function graphicFields(dir:string, media:any) {return htmlTextFields(graphicEntry(dir,media));}
export function htmlTextFields(file:string) {
 const fields:{id:string;default:string}[]=[], ids=new Set<string>();
 function visit(node:any) {
  const attr=node.attrs?.find((a:any)=>a.name==='data-text')??node.attrs?.find((a:any)=>a.name==='data-afclip-text');
  if(attr){
   const id=attr.value;
   assert(/^[a-zA-Z0-9_-]{1,128}$/.test(id)&&!ids.has(id),'Text fields need unique stable IDs',{field:id});
   assert(node.namespaceURI==='http://www.w3.org/1999/xhtml'&&!['script','style','textarea','input','canvas','svg','template'].includes(node.tagName),'Unsupported editable text element',{field:id});
   assert((node.childNodes||[]).every((n:any)=>n.nodeName==='#text'||n.tagName==='br'),'Editable text fields must contain plain text or line breaks',{field:id});
   ids.add(id);fields.push({id,default:(node.childNodes||[]).map((n:any)=>n.tagName==='br'?'\n':n.value).join('')});
  }
  for(const child of node.childNodes||[])visit(child);
 }
 visit(parse(fs.readFileSync(file,'utf8')));
 assert(fields.length<=256,'Graphic has too many editable text fields');
 return fields;
}
// Text fields are text parameters; overrides live in clip.params with other parameters.
export function inspectGraphicText(state:any,clipId:string){
 const clip=state.p.clips.find((c:any)=>c.id===clipId);assert(clip,'Clip not found',{clipId});
 const media=state.p.media.find((m:any)=>m.id===clip.mediaId),fields=graphicFields(state.dir,media),params=clip.params||{},declared=media.metadata.asset?.parameters||{};
 return {clipId,revision:clip.revision,mediaRevision:media.revision,fields:fields.map(f=>({...f,value:typeof params[f.id]==='string'?params[f.id]:f.default,overridden:typeof params[f.id]==='string'})),missing:Object.keys(params).filter(id=>typeof params[id]==='string'&&!Object.hasOwn(declared,id)&&!fields.some(f=>f.id===id))};
}
export function setGraphicText(state:any,c:any){
 const info=inspectGraphicText(state,c.clipId),clip=state.p.clips.find((v:any)=>v.id===c.clipId);
 if(c.revision!==info.revision||c.mediaRevision!==info.mediaRevision)fail('CONFLICT','Text changed. Reread the clip before editing.',{clipId:c.clipId,revision:info.revision,mediaRevision:info.mediaRevision});
 assert(typeof c.field==='string'&&(info.fields.some(f=>f.id===c.field)||(c.reset===true&&info.missing.includes(c.field))),'Unknown text field',{field:c.field});
 assert(c.reset===true||typeof c.value==='string','Text value must be a string');
 state.requireUnlocked();if(trackLocked(state.p,clip.trackId))fail('TRACK_LOCKED','Cannot modify a locked track',{trackId:clip.trackId});
 const field=info.fields.find(f=>f.id===c.field);
 if(c.reset===true?!Object.hasOwn(clip.params||{},c.field):field?.value===c.value)return state.inspect();
 const params={...clip.params,...(c.reset===true?{}:{[c.field]:c.value})};if(c.reset===true)delete params[c.field];
 return state.batch({preconditions:state.inspect().revisions,operations:[{op:'put',collection:'clips',value:{id:c.clipId,params}}]});
}
