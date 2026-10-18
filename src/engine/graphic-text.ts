import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'parse5';
import {assert,fail} from '../shared/project.ts';

// Only explicit, static, plain-text fields are editable. Never rewrite source code.
export function graphicFields(dir:string, media:any) {
 assert(media?.kind==='graphic','Select a graphic clip');
 const root=fs.realpathSync(path.resolve(dir,media.path));
 const file=fs.realpathSync(path.resolve(root,media.metadata.entry||'index.html'));
 assert(file.startsWith(root+path.sep),'Graphic entry escaped its asset folder');
 const fields:{id:string;default:string}[]=[], ids=new Set<string>();
 function visit(node:any) {
  const attr=node.attrs?.find((a:any)=>a.name==='data-afclip-text');
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
export function inspectGraphicText(state:any,clipId:string){
 const clip=state.p.clips.find((c:any)=>c.id===clipId);assert(clip,'Clip not found',{clipId});
 const media=state.p.media.find((m:any)=>m.id===clip.mediaId),fields=graphicFields(state.dir,media);
 return {clipId,revision:clip.revision,mediaRevision:media.revision,fields:fields.map(f=>({...f,value:Object.hasOwn(clip.text||{},f.id)?clip.text[f.id]:f.default,overridden:Object.hasOwn(clip.text||{},f.id)})),missing:Object.keys(clip.text||{}).filter(id=>!fields.some(f=>f.id===id))};
}
export function setGraphicText(state:any,c:any){
 const info=inspectGraphicText(state,c.clipId),clip=state.p.clips.find((v:any)=>v.id===c.clipId);
 if(c.revision!==info.revision||c.mediaRevision!==info.mediaRevision)fail('CONFLICT','Text changed. Reread the clip before editing.',{clipId:c.clipId,revision:info.revision,mediaRevision:info.mediaRevision});
 assert(typeof c.field==='string'&&(info.fields.some(f=>f.id===c.field)||(c.reset===true&&info.missing.includes(c.field))),'Unknown text field',{field:c.field});
 assert(c.reset===true||typeof c.value==='string','Text value must be a string');
 state.requireUnlocked();if(state.p.tracks.find((t:any)=>t.id===clip.trackId)?.locked)fail('TRACK_LOCKED','Cannot modify a locked track',{trackId:clip.trackId});
 const field=info.fields.find(f=>f.id===c.field);
 if(c.reset===true?!Object.hasOwn(clip.text||{},c.field):field?.value===c.value)return state.inspect();
 const text={...clip.text,...(c.reset===true?{}:{[c.field]:c.value})};if(c.reset===true)delete text[c.field];
 return state.batch({preconditions:state.inspect().revisions,operations:[{op:'put',collection:'clips',value:{id:c.clipId,text}}]});
}
