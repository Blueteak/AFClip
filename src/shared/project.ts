export type Time = { num: number; den: number };
export type Media = { id: string; revision: number; path: string; kind: 'video'|'audio'|'image'|'graphic'; duration: Time; metadata: Record<string, any> };
export type Track = { id: string; revision: number; name: string; disabled: boolean; locked: boolean; folderId?: string|null };
export type TrackFolder = { id:string; revision:number; name:string; disabled:boolean; locked:boolean; collapsed:boolean };
export type VolumePoint = { time: Time; value: number };
export type AssetInstance = { assetId:string; params?:Record<string,number|boolean|string>; seed:number };
export type Clip = { id: string; revision: number; trackId: string; mediaId: string; start: Time; duration: Time; sourceIn: Time; speed: Time; stream?: 'audio'|'video'; linkId?: string|null; volume: number; volumePoints?: VolumePoint[]; mute: boolean; fadeIn: Time; fadeOut: Time; text?: Record<string,string>; transform?: {x?:number;y?:number;scale?:number;rotation?:number;opacity?:number;fit?:'fit'|'fill'}; name?:string; params?:Record<string,number|boolean|string>; seed?:number; effects?: (AssetInstance & {id:string})[] };
export type Transition = AssetInstance & { audio:'crossfade'|'cut'; id: string; revision: number; trackId: string; fromClipId: string; toClipId: string; duration: Time; alignment:'center'|'start'|'end' };
export const MARKER_COLORS = ['green','cyan','blue','purple','pink','red','orange','yellow'] as const;
export type Marker = { id:string; revision:number; name:string; time:Time; color?:typeof MARKER_COLORS[number] };
export type Project = { version:1; id:string; name:string; revision:number; resolution:{width:number;height:number}; fps:Time; media:Media[]; tracks:Track[]; folders?:TrackFolder[]; clips:Clip[]; transitions:Transition[]; markers?:Marker[]; relationshipRevisions:Record<string,number>; [key:string]:any };
export const ZERO: Time = {num:0,den:1};
export const ONE: Time = {num:1,den:1};
export class EngineError extends Error { code:string; details:any; constructor(code:string,message:string,details:any={}) {super(message);this.code=code;this.details=details;} }
export function fail(code:string,message:string,details:any={}):never {throw new EngineError(code,message,details);}
export function assert(ok:any,message:string,details:any={}):asserts ok {if(!ok)fail('VALIDATION',message,details);}
export function rational(num:bigint|number,den:bigint|number=1):Time {let n=BigInt(num),d=BigInt(den);assert(d!==0n,'Time denominator must not be zero');if(d<0n){n=-n;d=-d;} let a=n<0n?-n:n,b=d;while(b){const t=b;b=a%b;a=t;} n/=a;d/=a;assert(n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=BigInt(Number.MIN_SAFE_INTEGER)&&d<=BigInt(Number.MAX_SAFE_INTEGER),'Time exceeds exact supported range');return {num:Number(n),den:Number(d)};}
export function time(v:any,label='time'):Time {assert(v&&Number.isSafeInteger(v.num)&&Number.isSafeInteger(v.den)&&v.den>0,`${label} must be an integer fraction {num,den} with positive denominator`);return rational(v.num,v.den);}
export const seconds=(v:Time)=>v.num/v.den;
export const add=(a:Time,b:Time)=>rational(BigInt(a.num)*BigInt(b.den)+BigInt(b.num)*BigInt(a.den),BigInt(a.den)*BigInt(b.den));
export const sub=(a:Time,b:Time)=>rational(BigInt(a.num)*BigInt(b.den)-BigInt(b.num)*BigInt(a.den),BigInt(a.den)*BigInt(b.den));
export const mul=(a:Time,b:Time)=>rational(BigInt(a.num)*BigInt(b.num),BigInt(a.den)*BigInt(b.den));
export const cmp=(a:Time,b:Time)=>{const d=BigInt(a.num)*BigInt(b.den)-BigInt(b.num)*BigInt(a.den);return d<0n?-1:d>0n?1:0;};
export function parseTime(v:string):Time {if(v.includes('/')){const [n,d]=v.split('/');return time({num:Number(n),den:Number(d)});} assert(/^-?\d+(\.\d+)?$/.test(v),'Expected seconds or fraction');const places=(v.split('.')[1]||'').length;return rational(BigInt(v.replace('.','')),10n**BigInt(places));}
export function revisions(p:Project):Record<string,number> {const r:Record<string,number>={project:p.revision,...p.relationshipRevisions};for(const [collection,singular]of [['media','media'],['tracks','track'],['clips','clip'],['transitions','transition'],['markers','marker'],['folders','folder']])for(const o of p[collection]||[])r[`${singular}:${o.id}`]=o.revision;for(const t of p.tracks)r[`occupancy:${t.id}`]??=0;return r;}
export function duration(p:Project):Time {return p.clips.reduce((end,c)=>{const e=add(c.start,c.duration);return cmp(e,end)>0?e:end;},ZERO);}
// Source timestamps deliberately survive trims, splits, and project FPS changes.
function validateVolumePoints(points:any, media:Media, clipId:string) {
 if(points===undefined)return;
 assert(Array.isArray(points)&&points.length<=1024,'Volume points must be an array of at most 1024 points',{clipId});
 let previous:Time|undefined;
 for(const point of points){
  assert(point&&typeof point==='object'&&Object.keys(point).every(k=>k==='time'||k==='value'),'Invalid volume point',{clipId});
  const at=time(point.time,'Volume point source time');
  assert(cmp(at,ZERO)>=0&&cmp(at,media.duration)<=0,'Volume point must lie within source media',{clipId});
  assert(!previous||cmp(at,previous)>0,'Volume points must have unique, increasing source times',{clipId});
  assert(typeof point.value==='number'&&Number.isFinite(point.value)&&point.value>=0&&point.value<=16,'Volume point value must be between 0 and 16',{clipId});
  previous=at;
 }
}
export function validateProject(p:any):asserts p is Project {
 assert(p&&p.version===1,'Unsupported project version'); assert(typeof p.id==='string'&&typeof p.name==='string','Project requires id and name');assert(Number.isSafeInteger(p.revision)&&p.revision>=0,'Invalid project revision');
 assert(p.resolution&&Number.isInteger(p.resolution.width)&&Number.isInteger(p.resolution.height)&&p.resolution.width>=2&&p.resolution.height>=2&&p.resolution.width%2===0&&p.resolution.height%2===0&&p.resolution.width<=7680&&p.resolution.height<=4320,'Resolution must have even dimensions up to 7680x4320');assert(seconds(time(p.fps,'fps'))>0&&seconds(p.fps)<=240,'Frame rate must be between 0 and 240');
 if(p.markers===undefined)p.markers=[];
 if(p.folders===undefined)p.folders=[];
 for(const name of ['media','tracks','clips','transitions','markers','folders']){assert(Array.isArray(p[name]),`Missing ${name} array`);const ids=new Set();for(const o of p[name]){assert(o&&typeof o.id==='string'&&/^[a-zA-Z0-9_-]+$/.test(o.id)&&!ids.has(o.id),`Invalid or duplicate ${name} ID`);ids.add(o.id);assert(Number.isSafeInteger(o.revision)&&o.revision>=0,'Invalid object revision');}}
 for(const marker of p.markers){assert(typeof marker.name==='string'&&marker.name.trim().length>0&&marker.name.length<=256,'Marker name must contain 1 to 256 characters');assert(cmp(time(marker.time,'Marker time'),ZERO)>=0,'Marker time must not be negative');assert(marker.color===undefined||(MARKER_COLORS as readonly string[]).includes(marker.color),`Marker color must be one of ${MARKER_COLORS.join(', ')}`);}
 const media=new Map<string,Media>(p.media.map((m:Media)=>[m.id,m]));const tracks=new Map<string,Track>(p.tracks.map((t:Track)=>[t.id,t]));const clips=new Map<string,Clip>(p.clips.map((c:Clip)=>[c.id,c]));
 for(const m of p.media){assert(['video','audio','image','graphic'].includes(m.kind)&&typeof m.path==='string'&&m.path.length>0,'Invalid media');assert(cmp(time(m.duration),ZERO)>=0,'Negative media duration');assert(m.metadata&&typeof m.metadata==='object','Media metadata required');}
 for(const t of p.tracks)assert(typeof t.name==='string'&&typeof t.locked==='boolean'&&typeof t.disabled==='boolean','Invalid track');
 for(const folder of p.folders){
  assert(typeof folder.name==='string'&&folder.name.trim().length>0&&folder.name.length<=256&&['disabled','locked','collapsed'].every(k=>typeof folder[k]==='boolean'),'Invalid track folder');
  const indices=p.tracks.flatMap((t:Track,i:number)=>t.folderId===folder.id?[i]:[]);
  assert(indices.length>0,'A folder must contain at least one track',{folderId:folder.id});
  assert(indices[indices.length-1]-indices[0]+1===indices.length,'Folder tracks must remain adjacent',{folderId:folder.id});
 }
 for(const t of p.tracks)assert(t.folderId==null||p.folders.some((f:TrackFolder)=>f.id===t.folderId),'Track references missing folder',{trackId:t.id});
 for(const c of p.clips){const m=media.get(c.mediaId);assert(m&&tracks.has(c.trackId),'Clip references missing media or track',{clipId:c.id});for(const k of ['start','duration','sourceIn','speed','fadeIn','fadeOut'])time(c[k],k);assert(cmp(c.start,ZERO)>=0&&cmp(c.sourceIn,ZERO)>=0&&cmp(c.duration,ZERO)>0&&cmp(c.speed,ZERO)>0,'Invalid clip timing',{clipId:c.id});assert(cmp(c.fadeIn,ZERO)>=0&&cmp(c.fadeOut,ZERO)>=0&&cmp(c.fadeIn,c.duration)<=0&&cmp(c.fadeOut,c.duration)<=0,'Fade exceeds clip duration',{clipId:c.id});assert(Number.isFinite(c.volume)&&c.volume>=0&&c.volume<=16&&typeof c.mute==='boolean','Invalid clip audio');validateVolumePoints(c.volumePoints,m,c.id);assert(c.stream===undefined||(['audio','video'].includes(c.stream)&&m.kind==='video'),'Invalid clip stream');assert(c.linkId==null||(typeof c.linkId==='string'&&/^[a-zA-Z0-9_-]+$/.test(c.linkId)),'Invalid clip link');if(m.kind==='video'||m.kind==='audio')assert(cmp(add(c.sourceIn,mul(c.duration,c.speed)),m.duration)<=0,'Clip exceeds source duration',{clipId:c.id});if(c.text!==undefined){assert(m.kind==='graphic'&&c.text!==null&&typeof c.text==='object'&&!Array.isArray(c.text),'Text overrides require a graphic clip');assert(Object.keys(c.text).length<=256,'Too many text fields');for(const [id,value]of Object.entries(c.text))assert(/^[a-zA-Z0-9_-]{1,128}$/.test(id)&&typeof value==='string'&&value.length<=16384,'Invalid text field',{field:id});}if(m.metadata.asset)assert(m.metadata.asset.role==='content','Only content assets can be placed as clips');if(c.effects!==undefined){assert(m.kind!=='audio'&&c.stream!=='audio','Visual effects require a visual clip');assert(Array.isArray(c.effects),'Effects must be an ordered array');const ids=new Set();for(const effect of c.effects){assert(effect&&typeof effect.id==='string'&&!ids.has(effect.id),'Effects require unique IDs');ids.add(effect.id);validateInstance(effect,media,'effect');}}if(c.transform){assert(typeof c.transform==='object','Invalid transform');for(const [k,v]of Object.entries(c.transform))assert(k==='fit'?v==='fit'||v==='fill':['x','y','scale','rotation','opacity'].includes(k)&&typeof v==='number'&&Number.isFinite(v),'Invalid transform property',{key:k});assert((c.transform.scale??1)>0&&(c.transform.opacity??1)>=0&&(c.transform.opacity??1)<=1,'Invalid scale or opacity');}}
 const links=new Map<string,Clip[]>();
 for(const c of p.clips)if(c.linkId)links.set(c.linkId,[...(links.get(c.linkId)||[]),c]);
 for(const [linkId,pair] of links){assert(pair.length===2&&pair[0].mediaId===pair[1].mediaId&&new Set(pair.map(c=>c.stream)).size===2&&pair.every(c=>c.stream==='audio'||c.stream==='video'),'A link requires one picture and one audio clip from the same source',{linkId});for(const key of ['start','duration','sourceIn','speed'])assert(cmp(pair[0][key],pair[1][key])===0,'Linked clips must have matching timing',{linkId,field:key});}
 for(const t of p.tracks){const cs=p.clips.filter((c:Clip)=>c.trackId===t.id).sort((a:Clip,b:Clip)=>cmp(a.start,b.start));for(let i=1;i<cs.length;i++)assert(cmp(add(cs[i-1].start,cs[i-1].duration),cs[i].start)<=0,'Clips on one track cannot overlap; transitions preserve the cut',{clipIds:[cs[i-1].id,cs[i].id]});}
 const used=new Set<string>();for(const tr of p.transitions){const a=clips.get(tr.fromClipId),b=clips.get(tr.toClipId);assert(a&&b&&a.trackId===tr.trackId&&b.trackId===tr.trackId&&a.id!==b.id,'Invalid transition clip references');assert(!used.has(`${a.id}:${b.id}`),'Duplicate transition at cut');used.add(`${a.id}:${b.id}`);assert(cmp(add(a.start,a.duration),b.start)===0,'Transition requires adjacent clips');assert(['center','start','end'].includes(tr.alignment)&&cmp(time(tr.duration),ZERO)>0,'Invalid transition');const before=tr.alignment==='start'?ZERO:tr.alignment==='end'?tr.duration:mul(tr.duration,{num:1,den:2});const after=sub(tr.duration,before);assert(cmp(before,a.duration)<=0&&cmp(after,b.duration)<=0,'Transition exceeds adjacent clip duration');assert((media.get(a.mediaId)!.kind==='audio'||a.stream==='audio')===(media.get(b.mediaId)!.kind==='audio'||b.stream==='audio'),'A transition needs two visual clips or two audio clips');validateInstance(tr,media,'transition');assert(['crossfade','cut'].includes(tr.audio),'Transition audio must be crossfade or cut');}
 for(const c of p.clips){const incoming=p.transitions.find((t:Transition)=>t.toClipId===c.id),outgoing=p.transitions.find((t:Transition)=>t.fromClipId===c.id);const occupied=(t:Transition|undefined,side:string)=>!t?ZERO:t.alignment==='center'?mul(t.duration,{num:1,den:2}):t.alignment===side?t.duration:ZERO;assert(cmp(add(occupied(incoming,'start'),occupied(outgoing,'end')),c.duration)<=0,'Transitions overlap within a clip',{clipId:c.id});}
}

function validateInstance(instance:any,media:Map<string,Media>,role:string){
 const asset=media.get(instance.assetId);
 assert(asset?.kind==='graphic'&&asset.metadata.asset?.role===role,`Instance requires an HTML ${role} asset`,{assetId:instance.assetId});
 assert(Number.isInteger(instance.seed)&&instance.seed>=0&&instance.seed<=0xffffffff,'Asset instance requires a uint32 seed');
 assert(instance.params===undefined||(instance.params&&typeof instance.params==='object'&&!Array.isArray(instance.params)&&Object.values(instance.params).every(v=>typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))),'Invalid asset parameters');
}

export function trackLocked(p:Project,id:string):boolean {const t=p.tracks.find(t=>t.id===id);return !!(t?.locked||(t?.folderId&&p.folders?.find(f=>f.id===t.folderId)?.locked));}
