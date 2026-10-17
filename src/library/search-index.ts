// A disposable SQL projection keeps browsing independent of annotation JSON size.
// The authoritative records and history still commit in the same transaction.
export class SearchIndex {
  catalog:any; db:any;
  constructor(catalog:any){
    this.catalog=catalog;this.db=catalog.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_items(id TEXT PRIMARY KEY,type TEXT,assetId TEXT,mediaKind TEXT,folder TEXT,deleted INTEGER,duration REAL,name TEXT COLLATE NOCASE,notes TEXT);
      CREATE INDEX IF NOT EXISTS search_order ON search_items(deleted,name,id);
      CREATE INDEX IF NOT EXISTS search_folder ON search_items(folder,deleted,name,id);
      CREATE INDEX IF NOT EXISTS search_kind ON search_items(mediaKind,deleted,name,id);
      CREATE INDEX IF NOT EXISTS search_type ON search_items(type,deleted,name,id);
      CREATE INDEX IF NOT EXISTS search_parent ON search_items(assetId,type);
      CREATE TABLE IF NOT EXISTS search_tags(tag TEXT,id TEXT,PRIMARY KEY(tag,id));
      CREATE INDEX IF NOT EXISTS tags_item ON search_tags(id);
      CREATE TABLE IF NOT EXISTS search_members(collection TEXT,id TEXT,PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS members_item ON search_members(id);
      CREATE TABLE IF NOT EXISTS asset_counts(folder TEXT,kind TEXT,count INTEGER,PRIMARY KEY(folder,kind));
      CREATE TRIGGER IF NOT EXISTS counts_insert AFTER INSERT ON search_items WHEN new.type='asset' AND new.deleted=0 BEGIN INSERT INTO asset_counts VALUES(new.folder,new.mediaKind,1) ON CONFLICT(folder,kind) DO UPDATE SET count=count+1; END;
      CREATE TRIGGER IF NOT EXISTS counts_delete AFTER DELETE ON search_items WHEN old.type='asset' AND old.deleted=0 BEGIN UPDATE asset_counts SET count=count-1 WHERE folder=old.folder AND kind=old.mediaKind; END;
      CREATE TRIGGER IF NOT EXISTS counts_update AFTER UPDATE ON search_items WHEN old.type='asset' AND (new.deleted!=old.deleted OR new.folder!=old.folder OR new.mediaKind!=old.mediaKind) BEGIN
        UPDATE asset_counts SET count=count-1 WHERE folder=old.folder AND kind=old.mediaKind AND old.deleted=0;
        INSERT INTO asset_counts SELECT new.folder,new.mediaKind,1 WHERE new.deleted=0 ON CONFLICT(folder,kind) DO UPDATE SET count=count+1; END;
      CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(name,notes,content='search_items',content_rowid='rowid',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON search_items BEGIN INSERT INTO search_text(rowid,name,notes) VALUES(new.rowid,new.name,new.notes); END;
      CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON search_items BEGIN INSERT INTO search_text(search_text,rowid,name,notes) VALUES('delete',old.rowid,old.name,old.notes); END;
      CREATE TRIGGER IF NOT EXISTS search_update AFTER UPDATE OF name,notes ON search_items WHEN new.name!=old.name OR new.notes!=old.notes BEGIN
        INSERT INTO search_text(search_text,rowid,name,notes) VALUES('delete',old.rowid,old.name,old.notes);
        INSERT INTO search_text(rowid,name,notes) VALUES(new.rowid,new.name,new.notes); END;
    `);
    if(catalog.meta('searchIndexVersion')!==1){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec('DELETE FROM search_items; DELETE FROM search_tags; DELETE FROM search_members; DELETE FROM asset_counts;');
        for(const row of this.db.prepare("SELECT kind,data FROM records WHERE kind IN ('asset','range','collection') ORDER BY CASE kind WHEN 'asset' THEN 0 ELSE 1 END").iterate() as any)this.put(row.kind,JSON.parse(row.data));
        catalog.meta('searchIndexVersion',1);this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
    }
  }
  put(kind:string,o:any){
    if(kind==='collection'){this.db.prepare('DELETE FROM search_members WHERE collection=?').run(o.id);const insert=this.db.prepare('INSERT OR IGNORE INTO search_members VALUES (?,?)');for(const id of o.members)insert.run(o.id,id);return;}
    if(!['asset','range'].includes(kind)){if(kind==='alias')this.remove(o.id);return;}
    const parent=kind==='range'?this.catalog.maybe(o.assetId):o;if(!parent)return;
    const duration=kind==='range'?o.end.num/o.end.den-o.start.num/o.start.den:o.duration||0;
    this.db.prepare(`INSERT INTO search_items(id,type,assetId,mediaKind,folder,deleted,duration,name,notes) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type,assetId=excluded.assetId,mediaKind=excluded.mediaKind,folder=excluded.folder,deleted=excluded.deleted,duration=excluded.duration,name=excluded.name,notes=excluded.notes`).run(o.id,kind,kind==='range'?o.assetId:o.id,parent.kind,parent.folder,parent.deleted?1:0,duration,o.name,o.notes||'');
    if(kind==='asset')this.db.prepare("UPDATE search_items SET folder=?,deleted=?,mediaKind=? WHERE assetId=? AND type='range' AND (folder!=? OR deleted!=? OR mediaKind!=?)").run(o.folder,o.deleted?1:0,o.kind,o.id,o.folder,o.deleted?1:0,o.kind);
    this.db.prepare('DELETE FROM search_tags WHERE id=?').run(o.id);const insert=this.db.prepare('INSERT OR IGNORE INTO search_tags VALUES (?,?)');for(const tag of o.tags||[])insert.run(tag,o.id);
  }
  remove(id:string){this.db.prepare('DELETE FROM search_items WHERE id=?').run(id);this.db.prepare('DELETE FROM search_tags WHERE id=?').run(id);this.db.prepare('DELETE FROM search_members WHERE collection=? OR id=?').run(id,id);}
}
