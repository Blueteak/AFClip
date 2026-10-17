import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Catalog,uid,now} from './store.ts';
import {Operations,supported} from './operations.ts';
import {Jobs} from './jobs.ts';
import {Intake} from './intake.ts';
import {assert,fail} from '../shared/project.ts';
import {atomicJSON} from '../engine/state.ts';

const dir=path.resolve(process.argv[2]);fs.mkdirSync(dir,{recursive:true});
const lock=path.join(dir,'service.lock'),endpointFile=path.join(dir,'endpoint.json');
try{const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);}catch(e:any){if(e.code!=='EEXIST')throw e;let alive=false;try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);alive=true;}catch{}if(alive)process.exit(0);fs.unlinkSync(lock);const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);}
process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid)){fs.unlinkSync(lock);fs.rmSync(endpointFile,{force:true});}}catch{}});
const db=new Catalog(dir),ops=new Operations(db),token=randomBytes(32).toString('hex'),readerToken=randomBytes(32).toString('hex'),subscribers=new Set<http.ServerResponse>();
function changed(){for(const res of subscribers)res.write(`data: ${JSON.stringify({revision:db.meta('revision'),at:now()})}\n\n`);}
const jobs=new Jobs(db,ops,changed);
const intake=new Intake(db,ops,jobs);jobs.scan=j=>intake.scan(j);
setInterval(()=>intake.watch(),15000).unref();
const root=fileURLToPath(new URL('../../',import.meta.url));
function importFiles(c:any) {
  if(c.command==='import'&&(c.paths||[c.path]).some((p:string)=>fs.statSync(p).isDirectory()))return intake.queue(c);
  const paths:string[]=[];const walk=(file:string)=>{const st=fs.statSync(file);if(st.isDirectory()){for(const e of fs.readdirSync(file,{withFileTypes:true})){if(e.isSymbolicLink())continue;if(e.isDirectory()||supported.test(e.name))walk(path.join(file,e.name));if(c.limit&&paths.length>=c.limit)break;}}else if(supported.test(file))paths.push(file);};
  for(const p of c.paths||[c.path]){assert(typeof p==='string','Import requires path or paths');walk(path.resolve(p));}assert(paths.length,'No supported media found');
  const imported=db.transaction(c.command==='register'?'Register project media':'Import media',c.author||'agent',()=>paths.slice(0,c.limit||10000).map(file=>{
    const a=ops.register(file,c.folder||'root',c.command==='register');if(c.command==='register'&&c.projectId)ops.mutate({command:'retain',id:a.id,projectId:c.projectId,projectPath:c.projectPath});return a;
  }));
  const verification=imported.filter(a=>ops.source(a).status!=='verified').map(a=>jobs.enqueue('verify',a.id));
  return {items:imported.map(a=>ops.inspect(a.id)),jobs:verification,identityVerification:'background'};
}
async function command(c:any):Promise<any> {
  assert(c&&typeof c.command==='string','Command required');let result:any;
  switch(c.command) {
    case 'overview':return ops.overview();
    case 'search':return ops.browse(c);
    case 'inspect':return ops.inspect(c.id,c);
    case 'selection':{const a=ops.asset(c.id);db.check(a,c.revision);assert(a.sourceId===c.sourceId,'Source version changed; select it again');return {...ops.inspect(a.id),...ops.nativeBounds(a,c),temporary:true};}
    case 'original':{const item=ops.inspect(c.id),a=item.parent||item;return {path:a.path,availability:a.availability,libraryId:a.libraryId,assetId:a.id,sourceId:item.sourceId,rangeId:item.parent?item.id:undefined,start:item.start,end:item.end};}
    case 'references':return db.all('reference');
    case 'source-folders':return db.all('source-folder');
    case 'source-folder-save':result=db.transaction('Configure source folder',c.author||'agent',()=>intake.configure(c));break;
    case 'source-folder-remove':result=db.transaction('Remove source folder mapping',c.author||'agent',()=>{const s=db.get(c.id,'source-folder');db.check(s,c.revision);db.remove(s.id);return {removed:s.id,assetsPreserved:true};});break;
    case 'import':case 'register':result=importFiles(c);break;
    case 'rescan':return intake.queue(c);
    case 'replace': {const a=ops.asset(c.id);db.check(a,c.revision);assert(c.confirm==='reset-annotations','Confirm reset-annotations to accept replacement');const file=fs.realpathSync(c.path),stat=fs.statSync(file);assert(stat.isFile()&&supported.test(file),'Replacement must be audio/video');result=db.transaction('Accept replacement',c.author||'agent',()=>{const source=db.put('source',{id:uid('source'),locations:[file],size:stat.size,mtimeMs:stat.mtimeMs,status:'pending',duration:{num:0,den:1}});for(const r of db.related('range','assetId',a.id))ops.mutate({command:'range-delete',id:r.id,revision:r.revision});return db.put('asset',{...a,sourceId:source.id,tags:[],notes:'',takes:[],duration:0});});jobs.enqueue('verify',a.id);break;}
    case 'purge': {const a=ops.asset(c.id);db.check(a,c.revision);assert(a.deleted&&c.confirm==='purge-catalog-record','Trash the asset first, then confirm purge-catalog-record');result=db.transaction('Purge catalog annotations',c.author||'agent',()=>{
      const ids=new Set([a.id,...db.related('range','assetId',a.id).map(r=>r.id)]);
      const tombstone=db.put('asset',{...a,name:'Deleted library asset',notes:'',tags:[],takes:[],purged:true});
      for(const id of ids)if(id!==a.id)db.remove(id);
      const clean=(o:any)=>o?.recordType==='collection'?{...o,members:o.members.filter((id:string)=>!ids.has(id))}:o;
      for(const col of db.all('collection'))if(col.members.some((id:string)=>ids.has(id)))db.put('collection',clean(col));
      for(const h of db.db.prepare('SELECT seq,changes FROM history').all() as any[]){const changes=JSON.parse(h.changes).filter((x:any)=>!ids.has(x.id)&&x.before?.assetId!==a.id&&x.after?.assetId!==a.id).map((x:any)=>({...x,before:clean(x.before),after:clean(x.after)}));if(changes.length)db.db.prepare('UPDATE history SET changes=? WHERE seq=?').run(JSON.stringify(changes),h.seq);else db.db.prepare('DELETE FROM history WHERE seq=?').run(h.seq);}
      for(const p of db.db.prepare('SELECT id,data FROM checkpoints').all() as any[]){const records=JSON.parse(p.data).filter((r:any)=>!ids.has(r.id)||r.id===a.id).map((r:any)=>r.id===a.id?{...r,data:JSON.stringify(tombstone)}:r.kind==='collection'?{...r,data:JSON.stringify(clean({...JSON.parse(r.data),recordType:'collection'}))}:r);db.db.prepare('UPDATE checkpoints SET data=? WHERE id=?').run(JSON.stringify(records),p.id);}
      return {purged:a.id,originalsUntouched:true};
    },false);break;}
    case 'apply': {assert(Array.isArray(c.operations)&&c.operations.length>0&&c.operations.length<=1000,'Batch requires 1–1000 operations');result=db.transaction('Annotation batch',c.author||'agent',()=>c.operations.map((op:any)=>ops.mutate(op)));break;}
    case 'undo':case 'redo':result=db.undo(c.command,c.author||'agent');break;
    case 'history':return db.history();
    case 'checkpoint': {assert(c.name?.trim(),'Checkpoint name required');const id=uid('checkpoint');db.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?)').run(id,now(),c.name,JSON.stringify(db.db.prepare('SELECT * FROM records').all()));db.db.exec('DELETE FROM checkpoints WHERE id NOT IN (SELECT id FROM checkpoints ORDER BY time DESC LIMIT 10)');result={id,name:c.name};break;}
    case 'checkpoints':return db.db.prepare('SELECT id,time,name FROM checkpoints ORDER BY time DESC').all();
    case 'checkpoint-restore': {assert(c.confirm==='discard-later-edits','Confirm discard-later-edits');const p:any=db.db.prepare('SELECT * FROM checkpoints WHERE id=?').get(c.id);assert(p,'Unknown checkpoint');result=db.transaction('Restore checkpoint',c.author||'agent',()=>{const rows=JSON.parse(p.data),ids=new Set(rows.map((r:any)=>r.id));for(const row of db.db.prepare('SELECT id,kind FROM records').all() as any[])if(!ids.has(row.id)&&!['source','alias'].includes(row.kind)){const current=db.get(row.id);if(row.kind==='asset')db.put('asset',{...current,deleted:true});else db.remove(row.id);}for(const row of rows)if(!['source','alias'].includes(db.maybe(row.id)?.recordType))db.put(row.kind,JSON.parse(row.data));return {restored:p.id};});break;}
    case 'prepare': {const assets=c.ids?c.ids.map((id:string)=>ops.asset(id)):db.all('asset').filter(a=>!a.deleted&&(!c.folder||a.folder===c.folder));result={jobs:assets.map((a:any)=>{if(ops.source(a).status!=='verified')jobs.enqueue('verify',a.id);return jobs.enqueue('prepare',a.id);})};break;}
    case 'jobs':return c.id?db.getJob(c.id):c.ids?c.ids.map((id:string)=>db.getJob(id)):db.jobs();
    case 'cancel':return jobs.cancel(c.id);
    case 'preview':return jobs.preview(c.id);
    case 'artifact':return jobs.requestArtifact(c);
    case 'frames': {const a=ops.asset(c.id);return JSON.parse(fs.readFileSync(path.join(dir,'cache',`${a.sourceId}.frames.json`),'utf8'));}
    case 'cache':return jobs.evict();
    case 'cache-clear':return jobs.evict(true);
    case 'cache-budget':assert(Number.isSafeInteger(c.bytes)&&c.bytes>=0,'Budget must be nonnegative bytes');db.meta('cacheBudget',c.bytes);return jobs.evict();
    case 'close':assert(!jobs.active,'Cancel or finish active work before closing');setTimeout(()=>{for(const s of subscribers)s.end();server.close(()=>process.exit(0));},50);return {closed:true};
    default:result=db.transaction(c.command,c.author||'agent',()=>ops.mutate(c));
  }
  changed();return result;
}
function json(res:http.ServerResponse,value:any,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function media(req:http.IncomingMessage,res:http.ServerResponse,file:string) {
  const size=fs.statSync(file).size;let start=0,end=size-1;const range=req.headers.range;
  if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);assert(m&&(m[1]||m[2]),'Invalid byte range');if(!m[1])start=Math.max(0,size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}}
  const type:any={'.mp4':'video/mp4','.mkv':'video/x-matroska','.webm':'video/webm','.mov':'video/mp4','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.flac':'audio/flac','.mjpg':'image/jpeg','.png':'image/png'};
  res.writeHead(range?206:200,{'Content-Type':type[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});if(req.method==='HEAD')res.end();else{const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}
}
const staticFiles:Record<string,string>={'/':'src/library/gui/index.html','/app.js':'src/library/gui/app.js','/annotation-timeline.js':'src/library/gui/annotation-timeline.js','/review-tools.js':'src/library/gui/review-tools.js','/library.css':'src/library/gui/styles.css','/reelet.css':'src/gui/styles.css','/native-preview.js':'src/gui/native-preview.js','/timeline.js':'src/render/timeline.cjs'};
const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url||'/',`http://${req.headers.host}`);const host=`127.0.0.1:${(server.address() as any).port}`;
    assert(req.headers.host===host,'Invalid local service host');
    const suppliedToken=u.searchParams.get('token');
    if(u.pathname==='/'&&[token,readerToken].includes(suppliedToken||'')){u.searchParams.delete('token');res.writeHead(302,{'Set-Cookie':`library_token=${suppliedToken}; HttpOnly; SameSite=Strict; Path=/`,'Location':'/'+u.search});res.end();return;}
    const writer=req.headers.authorization===`Bearer ${token}`||req.headers.cookie?.split(';').some(x=>x.trim()===`library_token=${token}`);
    const authorized=writer||req.headers.authorization===`Bearer ${readerToken}`||req.headers.cookie?.split(';').some(x=>x.trim()===`library_token=${readerToken}`);
    if(!authorized){json(res,{ok:false,error:{code:'UNAUTHORIZED',message:'Open the GUI using the library CLI.'}},401);return;}
    if(req.headers.origin&&req.headers.origin!==`http://${host}`)fail('ORIGIN_DENIED','Origin is not this local library');
    if(req.method==='GET'&&staticFiles[u.pathname]){const file=path.join(root,staticFiles[u.pathname]);res.writeHead(200,{'Content-Type':u.pathname==='/'?'text/html':u.pathname.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});res.end(fs.readFileSync(file));return;}
    if(u.pathname==='/v1/health'){json(res,{ok:true,result:{version:1,libraryId:db.meta('id')}});return;}
    if(req.method==='GET'&&u.pathname==='/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});subscribers.add(res);res.write(`data: ${JSON.stringify({revision:db.meta('revision'),resync:true})}\n\n`);req.on('close',()=>subscribers.delete(res));return;}
    if(['GET','HEAD'].includes(req.method||'')&&u.pathname.startsWith('/v1/artifacts/')){const parts=u.pathname.split('/'),sourceId=parts[3],name=parts[4];db.get(sourceId,'source');assert(/^[a-f0-9]{64}\.(png|wav|mp4)$/.test(name),'Invalid artifact key');jobs.readers.set(sourceId,Date.now());res.once('close',jobs.hold(sourceId));media(req,res,path.join(dir,'cache','artifacts',`${sourceId}.${name}`));return;}
    if(['GET','HEAD'].includes(req.method||'')&&u.pathname.startsWith('/v1/media/')){const [, , ,id,type]=u.pathname.split('/'),s=db.get(id,'source');if(type!=='image')jobs.readers.set(s.id,Date.now());res.once('close',jobs.hold(s.id));const cache=path.join(dir,'cache');let file:string;
      if(type==='original'){file=ops.location(s);assert(file,'Original is unavailable or changed');}
      else if(type==='seek'){file=JSON.parse(fs.readFileSync(path.join(cache,`${id}.preview.json`),'utf8')).seekProxy.file;assert(path.resolve(file).startsWith(path.resolve(cache)+path.sep),'Invalid artifact path');}
      else {const suffix:Record<string,string>={image:'png',audio:'wav',container:'mp4'};assert(suffix[type],'Unknown artifact');file=path.join(cache,`${id}.${suffix[type]}`);}
      media(req,res,file!);return;
    }
    if(req.method!=='POST'||u.pathname!=='/v1/command')fail('NOT_FOUND','Unknown route');let body='';for await(const chunk of req){body+=chunk;assert(body.length<4*1024**2,'Request too large');}const payload=JSON.parse(body);if(!writer&&!['overview','search','inspect','preview','frames','jobs','prepare','artifact','original','selection'].includes(payload.command))fail('READ_ONLY','Open the standalone library to edit annotations or organization');json(res,{ok:true,result:await command(payload)});
  }catch(e:any){if(res.headersSent){res.destroy();return;}json(res,{ok:false,error:{code:e.code||'INTERNAL',message:e.message,details:e.details||{}}},e.code==='CONFLICT'?409:400);}
});
server.listen(0,'127.0.0.1',()=>{const url=`http://127.0.0.1:${(server.address() as any).port}`;atomicJSON(endpointFile,{url:url+'/v1',gui:url+'/?token='+token,readerGui:url+'/?token='+readerToken+'&mode=reelet',token,pid:process.pid,catalogDir:dir});});
setInterval(()=>{for(const s of subscribers)s.write(': heartbeat\n\n');if(!jobs.active)jobs.evict();},30000).unref();
