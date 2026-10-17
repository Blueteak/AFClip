// Opt-in synthetic catalog benchmark. Never touches the active user catalog.
// node benchmarks/windows/library-search.ts .temp/library-scale
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Catalog} from '../../src/library/store.ts';
import {Operations} from '../../src/library/operations.ts';
const dir=path.resolve(process.argv[2]||'.temp/library-scale');
let catalog=new Catalog(dir);
const started=performance.now();
if(!catalog.meta('benchmarkDataset')){
  if(catalog.db.prepare("SELECT 1 FROM records WHERE kind='asset'").get())throw new Error('Use a new scratch catalog');
  const db=catalog.db;
  db.exec(`BEGIN;
    CREATE TEMP TABLE sequence(n INTEGER PRIMARY KEY);
    INSERT INTO sequence WITH RECURSIVE nums(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM nums WHERE n<999999) SELECT n FROM nums;
    INSERT INTO records SELECT 'source_'||n,'source',1,json_object('id','source_'||n,'status','verified','hash',printf('%064x',n),'locations',json('[]'),'duration',json('{"num":60,"den":1}'),'metadata',json('{}')) FROM sequence WHERE n<100000;
    INSERT INTO records SELECT 'asset_'||n,'asset',1,json_object('id','asset_'||n,'sourceId','source_'||n,'kind',CASE WHEN n%2=0 THEN 'video' ELSE 'audio' END,'folder','root','deleted',json('false'),'name',printf('Asset %06d',n),'notes',CASE WHEN n%997=0 THEN 'rare dragon impact' ELSE 'gameplay combat ambient sound effect' END,'tags',json('[]'),'duration',60) FROM sequence WHERE n<100000;
    INSERT INTO records SELECT 'range_'||n,'range',1,json_object('id','range_'||n,'assetId','asset_'||(n/10),'sourceId','source_'||(n/10),'name',printf('Range %07d',n),'notes',CASE WHEN n%997=0 THEN 'rare dragon impact' ELSE 'gameplay combat ambient sound effect' END,'tags',json('[]'),'start',json_object('num',n%10,'den',1),'end',json_object('num',n%10+1,'den',1)) FROM sequence;
    INSERT INTO search_items SELECT id,'asset',id,json_extract(data,'$.kind'),'root',0,60,json_extract(data,'$.name'),json_extract(data,'$.notes') FROM records WHERE kind='asset';
    INSERT INTO search_items SELECT id,'range',json_extract(data,'$.assetId'),CASE WHEN CAST(substr(json_extract(data,'$.assetId'),7) AS INTEGER)%2=0 THEN 'video' ELSE 'audio' END,'root',0,1,json_extract(data,'$.name'),json_extract(data,'$.notes') FROM records WHERE kind='range';
    DROP TABLE sequence; COMMIT; ANALYZE;`);
  catalog.meta('benchmarkDataset',{assets:100000,ranges:1000000});
}
const buildMs=performance.now()-started;
catalog.db.close();
const queries=[{}, {q:'dragon'}, {q:'combat'}, {q:'Asset 099999'}, {kind:'audio',maxDuration:2}, {q:'dragon',offset:60}];
const results=[];
for(const query of queries){
  // New SQLite connection: process/SQLite-cold, not a flushed Windows disk cache.
  catalog=new Catalog(dir);const ops=new Operations(catalog),cold=ops.browse({...query,limit:60});
  const warm=[];for(let i=0;i<10;i++)warm.push(ops.browse({...query,limit:60}).elapsedMs);
  warm.sort((a,b)=>a-b);results.push({query,coldMs:cold.elapsedMs,warmMedianMs:warm[5],warmP95Ms:warm[9],items:cold.items.length,complete:cold.complete,nextOffset:cold.nextOffset});catalog.db.close();
}
const report={catalog:{assets:100000,ranges:1000000,synthetic:true},hardware:{cpu:os.cpus()[0].model,ramGB:os.totalmem()/1024**3,node:process.version},backgroundWork:'No hashing or media preparation; synthetic catalog only',coldDefinition:'New SQLite connection; OS page cache not flushed',buildMs,results};
fs.writeFileSync(path.join(dir,'search-benchmark.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
