import fs from 'node:fs';
import path from 'node:path';
import {Catalog,uid,now} from './store.ts';
import {assert,fail,parseTime,cmp,ZERO,seconds} from '../shared/project.ts';

export const supported = /\.(mp4|mov|mkv|webm|avi|m4v|wav|mp3|flac|ogg|m4a|aac|aiff|aif|opus)$/i;
export class Operations {
  db:Catalog;
  constructor(db:Catalog) {this.db=db;}
  asset(id:string) {const a=this.db.resolve(id);assert(a.recordType==='asset','Expected an asset');return a;}
  source(a:any) {return this.db.get(a.sourceId,'source');}
  sourceMatches(a:any,id:string) {
    if(a.sourceId===id)return true;
    try {const saved=this.db.get(id,'source'),current=this.source(a);return !!saved.hash&&saved.hash===current.hash;}
    catch {return false;}
  }
  location(s:any) {return s.locations.find((p:string)=>{try{const st=fs.statSync(p);return st.size===s.size&&st.mtimeMs===(s.locationTimes?.[p]??s.mtimeMs);}catch{return false;}});}
  inspect(id:string,options:any={}):any {
    const o=this.db.resolve(id);
    if(o.recordType==='range')return {...o,libraryId:this.db.meta('id'),parent:this.inspect(o.assetId,{relationships:false})};
    if(o.recordType!=='asset')return o;
    const source=this.source(o),file=this.location(source);
    return {...o,libraryId:this.db.meta('id'),source,...(options.sourceId?{sourceMatches:this.sourceMatches(o,options.sourceId)}:{}),availability:file?'available':'unavailable',path:file||source.locations[0],...(options.relationships===false?{}:this.relationships(o.id,options))};
  }
  summary(id:string) {
    const o=this.db.resolve(id),a=o.recordType==='range'?this.asset(o.assetId):o,s=this.source(a);
    const cache=path.join(this.db.dir,'cache');
    return {id:o.id,revision:o.revision,recordType:o.recordType,kind:a.kind,name:o.name,
      ...(o.recordType==='range'?{assetId:a.id,assetName:a.name,start:o.start,end:o.end,boundaries:o.boundaries}:{}),
      sourceId:a.sourceId,folder:a.folder,tags:o.tags,notes:o.notes,
      duration:o.recordType==='range'?seconds(o.end)-seconds(o.start):a.duration,
      availability:this.location(s)?'available':'unavailable',sourceStatus:s.status,
      preparation:{index:a.kind==='audio'?s.status==='verified':fs.existsSync(path.join(cache,`${s.id}.frames.json`)),
        preview:fs.existsSync(path.join(cache,`${s.id}.${a.kind==='audio'?'wav':'preview.json'}`))}};
  }
  browse(c:any) {
    const start=performance.now(),limit=Math.max(1,Math.min(200,Number(c.limit)||60)),offset=Math.max(0,Number(c.offset)||0);
    const clauses=['i.deleted=?'],params:any[]=[c.deleted?1:0];let textSearch=false;
    if(c.folder){clauses.push('i.folder=?');params.push(c.folder);}else if(!c.inbox)clauses.push("i.folder!='inbox'");
    if(c.kind){clauses.push('i.mediaKind=?');params.push(c.kind);}
    if(c.assetsOnly)clauses.push("i.type='asset'");
    if(c.q){const q=String(c.q).trim();if(q.length>=3){textSearch=true;clauses.push('search_text MATCH ?');params.push('"'+q.replaceAll('"','""')+'"');}else{clauses.push("(i.name LIKE ? ESCAPE '!' OR i.notes LIKE ? ESCAPE '!')");const escaped='%'+q.replace(/[!%_]/g,'!$&')+'%';params.push(escaped,escaped);}}
    if(c.tag){clauses.push('i.id IN (SELECT id FROM search_tags WHERE tag=?)');params.push(c.tag);}
    if(c.collection){this.db.get(c.collection,'collection');clauses.push('i.id IN (SELECT id FROM search_members WHERE collection=?)');params.push(c.collection);}
    if(c.minDuration!==undefined){clauses.push('i.duration>=?');params.push(Number(c.minDuration));}
    if(c.maxDuration!==undefined){clauses.push('i.duration<=?');params.push(Number(c.maxDuration));}
    const rows=this.db.db.prepare(`SELECT i.id FROM ${textSearch?'search_text JOIN search_items i ON i.rowid=search_text.rowid':'search_items i'} WHERE ${clauses.join(' AND ')} ORDER BY ${textSearch?'search_text.rowid':'i.name,i.id'} LIMIT ? OFFSET ?`).all(...params,limit+1,offset) as any[];
    const more=rows.length>limit;return {libraryId:this.db.meta('id'),revision:this.db.meta('revision'),items:rows.slice(0,limit).map(r=>c.compact?this.summary(r.id):this.inspect(r.id,{relationships:false})),offset,nextOffset:more?offset+limit:null,complete:!more,elapsedMs:performance.now()-start};
  }
  relationships(id:string,options:any={}) {
    const offset=Math.max(0,Number(options.rangeOffset)||0),rows=this.db.db.prepare("SELECT id FROM records WHERE kind='range' AND json_extract(data,'$.assetId')=? ORDER BY id LIMIT 201 OFFSET ?").all(id,offset) as any[];
    const count=(this.db.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='range' AND json_extract(data,'$.assetId')=?").get(id) as any).n;
    return {ranges:rows.slice(0,200).map(r=>this.db.get(r.id)),rangePage:{offset,total:count,nextOffset:rows.length>200?offset+200:null,complete:rows.length<=200},references:this.db.related('reference','assetId',id)};
  }
  overview(compact=false) {return {libraryId:this.db.meta('id'),revision:this.db.meta('revision'),folders:this.db.all('folder'),tags:this.db.all('tag'),collections:this.db.all('collection'),counts:this.db.db.prepare('SELECT folder,kind,count FROM asset_counts WHERE count>0').all(),...(compact?{jobCounts:this.db.db.prepare("SELECT json_extract(data,'$.status') status,COUNT(*) count FROM jobs GROUP BY status").all()}:{history:this.db.history(),jobs:this.db.jobs()}),cacheBudget:this.db.meta('cacheBudget')};}
  annotations(c:any,o:any) {
    const a=o.recordType==='range'?this.asset(o.assetId):o;
    assert(!a.deleted&&!a.purged&&a.folder!=='inbox','Promote Inbox items before annotating');
    const next={...o};
    if(c.name!==undefined){assert(typeof c.name==='string'&&c.name.trim().length>0,'Name is required');next.name=c.name.trim();}
    if(c.notes!==undefined){assert(typeof c.notes==='string'&&c.notes.length<=100000,'Notes must be text under 100 KB');next.notes=c.notes;}
    if(c.tags!==undefined){assert(Array.isArray(c.tags),'Tags must be an array of vocabulary IDs');next.tags=[...new Set(c.tags.map((id:string)=>this.db.get(id,'tag').id))];}
    if(c.takes!==undefined){
      assert(o.recordType==='asset'&&Array.isArray(c.takes),'Takes must be an array on an asset');
      const spans=new Set<string>();
      next.takes=c.takes.map((t:any)=>{
        assert(t&&Number.isFinite(t.start)&&Number.isFinite(t.end)&&t.start>=0&&t.end>t.start&&t.end<=a.duration,'Take timestamps must be seconds within the source');
        assert(t.text===undefined||typeof t.text==='string'&&t.text.length<=100000,'Take text must be under 100 KB');
        const key=t.start+':'+t.end;assert(!spans.has(key),'A take already exists at these timestamps');spans.add(key);
        return {start:t.start,end:t.end,...(t.text?{text:t.text}:{})};
      }).sort((x:any,y:any)=>x.start-y.start||x.end-y.end);
    }
    if(c.annotationTracks!==undefined){
      assert(o.recordType==='asset'&&Array.isArray(c.annotationTracks)&&c.annotationTracks.length>0&&c.annotationTracks.length<=64,'Provide 1-64 annotation tracks');
      const ids=new Set<string>();
      next.annotationTracks=c.annotationTracks.map((t:any)=>{
        assert(typeof t.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(t.id)&&!ids.has(t.id),'Track IDs must be unique');
        assert(typeof t.name==='string'&&t.name.trim().length>0&&t.name.length<=100,'Track name is required, up to 100 characters');
        ids.add(t.id);return {id:t.id,name:t.name.trim()};
      });
      for(const r of this.db.related('range','assetId',a.id))assert(ids.has(r.trackId||'annotations'),'Move annotations before deleting their track');
    }
    if(o.recordType==='range'||c.trackId!==undefined){
      const tracks=a.annotationTracks||[{id:'annotations'}],trackId=c.trackId??o.trackId??tracks[0].id;
      assert(o.recordType==='range'&&tracks.some((t:any)=>t.id===trackId),'Choose an annotation track belonging to this asset');
      next.trackId=trackId;
    }
    return next;
  }
  folder(id:string) {if(id==='inbox')fail('VALIDATION','Inbox is reserved for project registration');return this.db.get(id,'folder');}
  mutate(c:any):any {
    const db=this.db;
    switch(c.command) {
      case 'annotate': {const o=db.resolve(c.id);assert(['asset','range'].includes(o.recordType),'Select an asset or range');db.check(o,c.revision);return db.put(o.recordType,this.annotations(c,o));}
      case 'folder-create': {const parent=this.folder(c.parent||'root');assert(c.name?.trim(),'Folder name required');assert(!db.all('folder').some(f=>f.parent===parent.id&&f.name===c.name.trim()),'Folder already exists');return db.put('folder',{id:uid('folder'),name:c.name.trim(),parent:parent.id});}
      case 'folder-update': {const f=this.folder(c.id);db.check(f,c.revision);assert(f.id!=='root','Root folder cannot be changed');const parent=c.parent||f.parent;let p=this.folder(parent);while(p){assert(p.id!==f.id,'Folder cycle');p=p.parent?db.get(p.parent):null;}assert((c.name||f.name).trim(),'Name required');return db.put('folder',{...f,name:c.name||f.name,parent});}
      case 'folder-delete': {const f=this.folder(c.id);db.check(f,c.revision);assert(f.id!=='root'&&!db.all('folder').some(x=>x.parent===f.id)&&!db.all('asset').some(a=>a.folder===f.id),'Only empty non-root folders can be deleted');db.remove(f.id);return {removed:f.id};}
      case 'move':case 'promote': {const a=this.asset(c.id);db.check(a,c.revision);assert(!a.purged,'Purged items cannot be moved or promoted');this.folder(c.folder||'root');return db.put('asset',{...a,folder:c.folder||'root',deleted:false});}
      case 'remove':case 'restore': {const a=this.asset(c.id);db.check(a,c.revision);assert(!a.purged,'A purged catalog item cannot be restored');return db.put('asset',{...a,deleted:c.command==='remove'});}
      case 'tag-create': {assert(c.name?.trim(),'Tag name required');assert(!db.all('tag').some(t=>t.name===c.name.trim()),'Tag already exists');return db.put('tag',{id:uid('tag'),name:c.name.trim()});}
      case 'tag-rename': {const t=db.get(c.id,'tag');db.check(t,c.revision);assert(c.name?.trim()&&!db.all('tag').some(x=>x.id!==t.id&&x.name===c.name.trim()),'Tag name is empty or already exists');return db.put('tag',{...t,name:c.name.trim()});}
      case 'tag-delete':case 'tag-merge': {const t=db.get(c.id,'tag');db.check(t,c.revision);const target=c.command==='tag-merge'?db.get(c.target,'tag'):null;if(target){assert(target.id!==t.id,'Choose another tag');db.check(target,c.targetRevision);}const used=(db.db.prepare('SELECT id FROM search_tags WHERE tag=?').all(t.id) as any[]).map(r=>db.get(r.id));assert(!used.length||target||c.confirm==='clear-assignments','Tag is in use; confirm clear-assignments');for(const o of used)db.put(o.recordType,{...o,tags:[...new Set(o.tags.flatMap((id:string)=>id===t.id?(target?[target.id]:[]):[id]))]});db.remove(t.id);return {removed:t.id,assignments:used.length};}
      case 'collection-create':assert(c.name?.trim(),'Collection name required');return db.put('collection',{id:uid('collection'),name:c.name.trim(),members:[]});
      case 'collection-update': {const col=db.get(c.id,'collection');db.check(col,c.revision);const members=c.members||col.members;assert(Array.isArray(members),'Members must be IDs');for(const id of members)assert(['asset','range'].includes(db.resolve(id).recordType),'Invalid collection member');return db.put('collection',{...col,name:c.name||col.name,members:[...new Set(members)]});}
      case 'collection-delete': {const col=db.get(c.id,'collection');db.check(col,c.revision);db.remove(col.id);return {removed:col.id};}
      case 'range-save': {const a=this.asset(c.assetId),s=this.source(a);assert(!a.deleted&&a.folder!=='inbox','Promote before annotating');assert(s.status==='verified','Wait for source verification');const old=c.id?db.get(c.id,'range'):null;db.check(old||a,c.revision);if(old)assert(old.assetId===a.id,'Range parent cannot change');
        const {start,end,boundaries}=this.nativeBounds(a,c);return db.put('range',this.annotations(c,{...(old||{id:uid('range'),tags:[],notes:'',name:'Untitled range',recordType:'range'}),assetId:a.id,sourceId:s.id,start,end,boundaries}));}
      case 'range-delete': {const r=db.get(c.id,'range');db.check(r,c.revision);for(const col of db.all('collection').filter(x=>x.members.includes(r.id)))db.put('collection',{...col,members:col.members.filter((id:string)=>id!==r.id)});db.remove(r.id);return {removed:r.id};}
      case 'retain': {const a=this.asset(c.id);assert(typeof c.projectId==='string'&&c.projectId,'Stable project ID required');const id=`ref_${c.projectId}_${a.id}`;const existing=db.maybe(id);if(existing)return existing;return db.put('reference',{id,assetId:a.id,projectId:c.projectId,projectPath:c.projectPath||null});}
      case 'withdraw': {const a=this.asset(c.id);for(const r of db.related('reference','assetId',a.id).filter(r=>r.projectId===c.projectId))db.remove(r.id);if(a.folder==='inbox'&&!db.related('reference','assetId',a.id,1).length)db.put('asset',{...a,deleted:true});return {withdrawn:true};}
      case 'sync-project': {assert(c.projectId&&Array.isArray(c.assetIds),'Project ID and assetIds required');const ids=[...new Set(c.assetIds.map((id:string)=>this.asset(id).id))];for(const r of db.related('reference','projectId',c.projectId).filter(r=>!ids.includes(r.assetId)))this.mutate({command:'withdraw',id:r.assetId,projectId:c.projectId});for(const id of ids){const a=this.asset(String(id));if(a.folder==='inbox'&&a.deleted)db.put('asset',{...a,deleted:false});this.mutate({command:'retain',id,projectId:c.projectId,projectPath:c.projectPath});}return {projectId:c.projectId,retained:ids};}
      default:fail('UNKNOWN_COMMAND',`Unknown library operation: ${c.command}`);
    }
  }
  nativeBounds(a:any,c:any){const db=this.db,s=this.source(a);
        const rate=s.metadata?.streams?.find((x:any)=>x.codec_type==='audio')?.sample_rate;
        let start:any,end:any,boundaries:any;
        if(a.kind==='audio'){const first=Number(c.startSample),last=Number(c.endSample);assert(Number.isSafeInteger(first)&&Number.isSafeInteger(last)&&Number(rate)>0,'Audio ranges require integer startSample/endSample');start={num:first,den:Number(rate)};end={num:last,den:Number(rate)};boundaries={startSample:first,endSample:last,sampleRate:Number(rate)};}
        else {const indexFile=path.join(db.dir,'cache',`${s.id}.frames.json`);assert(fs.existsSync(indexFile),'Prepare this video for review before making frame ranges');const index=JSON.parse(fs.readFileSync(indexFile,'utf8'));const first=Number(c.startFrame),last=Number(c.endFrame);assert(Number.isInteger(first)&&Number.isInteger(last)&&first>=0&&last>first&&last<=index.ticks.length,'Frame range is outside source');start={num:index.ticks[first]*index.timeBase.num,den:index.timeBase.den};end=last===index.ticks.length?s.duration:{num:index.ticks[last]*index.timeBase.num,den:index.timeBase.den};boundaries={startFrame:first,endFrame:last,startPts:index.ticks[first],endPts:last===index.ticks.length?null:index.ticks[last],timeBase:index.timeBase};}
        assert(cmp(start,ZERO)>=0&&cmp(end,start)>0&&cmp(end,s.duration)<=0,'Range must lie inside source');return {start,end,boundaries};
  }
  register(file:string,folder:string='root',inbox=false) {
    file=fs.realpathSync(file);assert(supported.test(file),'Only video and audio are supported');const stat=fs.statSync(file);assert(stat.isFile(),'Import requires a file');if(!inbox)this.folder(folder);
    if(inbox){const match=this.db.all('source-folder').filter(s=>file.toLowerCase().startsWith(s.path.toLowerCase()+path.sep)).sort((a,b)=>b.path.length-a.path.length)[0];if(match){folder=match.folder;inbox=false;if(match.hierarchy)for(const part of path.relative(match.path,path.dirname(file)).split(path.sep).filter(Boolean)){const f=this.db.related('folder','parent',folder).find(f=>f.name===part);folder=f?.id||this.db.put('folder',{id:uid('folder'),parent:folder,name:part}).id;}}}
    const loc:any=this.db.db.prepare('SELECT sourceId FROM source_locations WHERE path=? AND size=? AND mtime=? LIMIT 1').get(process.platform==='win32'?file.toLowerCase():file,stat.size,stat.mtimeMs);
    const source=loc?this.db.get(loc.sourceId):null;
    const existing=source&&this.db.related('asset','sourceId',source.id).find(a=>!a.purged);
    if(existing){if(existing.deleted||!inbox&&existing.folder==='inbox')return this.db.put('asset',{...existing,deleted:false,folder:existing.folder==='inbox'&&!inbox?folder:existing.folder});return existing;}
    const kind=/\.(wav|mp3|flac|ogg|m4a|aac|aiff|aif|opus)$/i.test(file)?'audio':'video';
    const s=this.db.put('source',{id:uid('source'),locations:[file],size:stat.size,mtimeMs:stat.mtimeMs,status:'pending',duration:{num:0,den:1}});
    return this.db.put('asset',{id:uid('asset'),sourceId:s.id,kind,name:path.basename(file,path.extname(file)),notes:'',tags:[],folder:inbox?'inbox':folder,deleted:false,duration:0,createdAt:now()});
  }
}
