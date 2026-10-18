import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {assert, fail} from '../shared/project.ts';
import {SearchIndex} from './search-index.ts';

export const uid = (kind:string) => `${kind}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
export class Catalog {
  db:DatabaseSync; changes = new Map<string,any>(); recording = false;
  dir:string;
  search:SearchIndex;
  constructor(dir:string) {
    this.dir=dir;
    fs.mkdirSync(dir, {recursive:true});
    this.db = new DatabaseSync(path.join(dir, 'catalog.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, time TEXT, label TEXT, changes TEXT, undone INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, time TEXT, name TEXT, data TEXT);
      CREATE INDEX IF NOT EXISTS asset_folder ON records(kind,json_extract(data,'$.folder'));
      CREATE INDEX IF NOT EXISTS source_hash ON records(kind,json_extract(data,'$.hash'));
      CREATE INDEX IF NOT EXISTS range_parent ON records(kind,json_extract(data,'$.assetId'));
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(json_extract(data,'$.status'),json_extract(data,'$.createdAt'));
      CREATE INDEX IF NOT EXISTS jobs_source ON jobs(json_extract(data,'$.kind'),json_extract(data,'$.sourceId'),json_extract(data,'$.status'));
      CREATE INDEX IF NOT EXISTS jobs_artifact ON jobs(json_extract(data,'$.options.key'),json_extract(data,'$.status'));
      CREATE INDEX IF NOT EXISTS asset_source ON records(kind,json_extract(data,'$.sourceId'));
      CREATE TABLE IF NOT EXISTS source_locations(path TEXT,sourceId TEXT,size INTEGER,mtime REAL,PRIMARY KEY(path,sourceId));`);
    if(!this.meta('locationsIndexed')){for(const s of this.all('source'))this.indexLocations(s);this.meta('locationsIndexed',true);}
    this.search=new SearchIndex(this);
    if (!this.meta('id')) {
      this.meta('id', uid('library')); this.meta('revision', 0); this.meta('cacheBudget', 2 * 1024 ** 3);
      this.put('folder', {id:'root', name:'Library', parent:null});
      for (const name of ['high-energy','low-energy','impact','ambience','dialogue','music','gameplay','cinematic']) this.put('tag', {id:uid('tag'), name});
    }
  }
  meta(key:string, value?:any):any {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
    const row:any = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  get(id:string, kind?:string):any {
    const row:any = this.db.prepare('SELECT * FROM records WHERE id=?').get(id);
    if (!row || kind && row.kind !== kind) fail('NOT_FOUND', 'Catalog item not found', {id,kind});
    return {...JSON.parse(row.data), id:row.id, revision:row.revision, recordType:row.kind};
  }
  maybe(id:string):any { try {return this.get(id);} catch {return null;} }
  all(kind:string):any[] { return this.db.prepare('SELECT * FROM records WHERE kind=?').all(kind).map((r:any)=>({...JSON.parse(r.data),id:r.id,revision:r.revision,recordType:r.kind})); }
  related(kind:string,field:string,value:string,limit=-1):any[]{assert(['assetId','sourceId','folder','projectId','parent'].includes(field),'Invalid relationship');return this.db.prepare(`SELECT id FROM records WHERE kind=? AND json_extract(data,'$.${field}')=? LIMIT ?`).all(kind,value,limit).map((r:any)=>this.get(r.id));}
  indexLocations(s:any){this.db.prepare('DELETE FROM source_locations WHERE sourceId=?').run(s.id);const put=this.db.prepare('INSERT OR REPLACE INTO source_locations VALUES (?,?,?,?)');for(const file of s.locations)put.run(process.platform==='win32'?file.toLowerCase():file,s.id,s.size,s.locationTimes?.[file]??s.mtimeMs);}
  resolve(id:string):any { const o=this.get(id); return o.recordType==='alias' ? this.resolve(o.target) : o; }
  put(kind:string, value:any) {
    const old=this.maybe(value.id);
    if (this.recording && !this.changes.has(value.id)) this.changes.set(value.id, {before:old});
    const data={...value,updatedAt:now()}; delete data.revision; delete data.recordType;
    this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?)').run(value.id,kind,(old?.revision||0)+1,JSON.stringify(data));
    if(kind==='source')this.indexLocations(data);
    this.search.put(kind,data);
    this.relationshipsChanged(old,{...data,recordType:kind});
    return this.get(value.id);
  }
  remove(id:string) {
    const old=this.get(id);
    if(this.recording&&!this.changes.has(id))this.changes.set(id,{before:old});
    this.db.prepare('DELETE FROM records WHERE id=?').run(id);
    if(old.recordType==='source')this.db.prepare('DELETE FROM source_locations WHERE sourceId=?').run(id);
    this.search.remove(id);
    this.relationshipsChanged(old,null);
  }
  relationshipsChanged(before:any,after:any){
    // Tag revisions include their assignment set; asset revisions include their ranges.
    // Bulk operations can therefore reject stale relationships without a global lock.
    const affected=new Set<string>();
    for(const tag of new Set<string>([...(before?.tags||[]),...(after?.tags||[])]))if(!!before?.tags?.includes(tag)!==!!after?.tags?.includes(tag))affected.add(tag);
    if(before?.recordType==='range'||after?.recordType==='range')for(const id of [before?.assetId,after?.assetId])if(id)affected.add(id);
    for(const id of affected)this.db.prepare('UPDATE records SET revision=revision+1 WHERE id=?').run(id);
  }
  check(o:any, revision:any) { if(revision!==o.revision)fail('CONFLICT','Item changed. Inspect it and retry the complete batch.',{id:o.id,expected:revision??null,actual:o.revision}); }
  transaction(label:string,author:string,fn:()=>any,history=true):any {
    assert(['human','agent'].includes(author),'Author must be human or agent');
    this.db.exec('BEGIN IMMEDIATE'); this.changes.clear(); this.recording=history;
    try {
      const result=fn(); this.recording=false;
      const changes=[...this.changes].map(([id,c])=>({id,...c,after:this.maybe(id)}));
      if(changes.length){
        this.db.prepare('DELETE FROM history WHERE undone=1').run();
        this.db.prepare('INSERT INTO history(author,time,label,changes) VALUES (?,?,?,?)').run(author,now(),label,JSON.stringify(changes));
        this.db.exec('DELETE FROM history WHERE seq NOT IN (SELECT seq FROM history ORDER BY seq DESC LIMIT 100)');
      }
      this.meta('revision',this.meta('revision')+1); this.db.exec('COMMIT'); return result;
    } catch(e) {this.recording=false;this.db.exec('ROLLBACK');throw e;}
  }
  history() {return this.db.prepare('SELECT seq,author,time,label,undone FROM history ORDER BY seq DESC').all();}
  undo(direction:string,author:string) {
    const row:any=this.db.prepare(direction==='undo'?'SELECT * FROM history WHERE undone=0 ORDER BY seq DESC LIMIT 1':'SELECT * FROM history WHERE undone=1 ORDER BY seq ASC LIMIT 1').get();
    assert(row,`Nothing to ${direction}`);
    return this.transaction(direction,author,()=>{
      // Apply only fields this operation changed, preserving asynchronous probe/hash results.
      for(const c of JSON.parse(row.changes)) {
        const from=direction==='undo'?c.after:c.before,to=direction==='undo'?c.before:c.after,current=this.maybe(c.id);
        // Verification aliases and immutable source records outlive undo so pinned project versions stay resolvable.
        if(current?.recordType==='alias'||current?.recordType==='source')continue;
        if(!to){if(current?.recordType==='asset')this.put('asset',{...current,deleted:true});else if(current)this.remove(c.id);continue;}
        if(!from){this.put(to.recordType,{...to,...(current||{}),deleted:to.deleted});continue;}
        const next={...current};
        for(const key of new Set([...Object.keys(from),...Object.keys(to)])) if(!['revision','updatedAt','recordType'].includes(key)&&JSON.stringify(from[key])!==JSON.stringify(to[key])) {if(key in to)next[key]=to[key];else delete next[key];}
        this.put(to.recordType,next);
      }
      this.db.prepare('UPDATE history SET undone=? WHERE seq=?').run(direction==='undo'?1:0,row.seq);
      return {direction,entry:row.seq};
    },false);
  }
  job(j:any) {this.db.prepare('INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(j.id,JSON.stringify(j));return j;}
  getJob(id:string){const r:any=this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);assert(r,'Unknown job');return JSON.parse(r.data);}
  queuedJobs() {return this.db.prepare(`SELECT data FROM jobs WHERE json_extract(data,'$.status')='queued'
    ORDER BY CASE json_extract(data,'$.kind') WHEN 'verify' THEN 0 WHEN 'artifact' THEN 1
      WHEN 'prepare' THEN CASE json_extract(data,'$.level') WHEN 'index' THEN 2 ELSE 4 END ELSE 3 END, rowid`).all().map((r:any)=>JSON.parse(r.data));}
  nextJob(){return this.queuedJobs()[0]||null;}
  jobs() {return this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 200').all().map((r:any)=>JSON.parse(r.data));}
}
