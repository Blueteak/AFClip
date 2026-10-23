import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJSON} from './state.ts';
import {graphicSignature} from './probe.ts';
import {assert,fail,validateProject,sequenceProjects} from '../shared/project.ts';
import type {ProjectState} from './state.ts';

const within=(child:string,parent:string)=>child===parent||child.startsWith(parent+path.sep);
const pathKey=(file:string)=>process.platform==='win32'?file.toLowerCase():file;

export async function collectProject(state:ProjectState, command:any) {
  state.requireUnlocked();
  if(command.revision!==state.p.revision)
    fail('CONFLICT','Project changed. Inspect again before collecting.',{actual:state.p.revision});
  const project=structuredClone(state.p),sourceRevision=project.revision,sourceProjectId=project.id;
  assert(typeof command.output==='string'&&path.isAbsolute(command.output),'Collect requires an absolute destination folder');
  const requested=path.resolve(command.output);
  const parent=await fs.realpath(path.dirname(requested));
  const destination=path.join(parent,path.basename(requested));
  const sourceRoot=await fs.realpath(state.dir);
  assert(!within(pathKey(destination),pathKey(sourceRoot))&&!within(pathKey(sourceRoot),pathKey(destination)),
    'Collect into a new folder outside the original project');
  // A separate project must not withdraw the original project's library references.
  project.id=randomUUID();
  const sources=await Promise.all(project.media.map(async media=>{
    const source=await fs.realpath(path.resolve(state.dir,media.path));
    const stat=await fs.stat(source);
    assert(media.kind==='graphic'?stat.isDirectory():stat.isFile(),'Invalid media source',{mediaId:media.id});
    if(media.kind==='graphic')assert(!within(pathKey(destination),pathKey(source)),'Destination is inside a graphic asset');
    return {media,source,stat};
  }));
  // Reserve exclusively. Publish project.json last, so an incomplete copy cannot open.
  // Never merge into an existing directory, even an empty one.
  try { await fs.mkdir(destination); }
  catch(error:any) {
    if(error.code==='EEXIST')fail('DESTINATION_EXISTS','Choose a new folder. Collection never overwrites an existing destination.',{path:destination});
    throw error;
  }
  let completed=false,mediaFiles=0;
  const copies=new Map<string,string>();
  try {
    for(const {media,source,stat} of sources) {
      if(media.kind==='graphic') {
        const signature=graphicSignature(source);
        const accepted=path.posix.join('.afclip','graphic-assets',media.id,'collected');
        const author=path.posix.join('graphics',media.id);
        await fs.cp(source,path.join(destination,accepted),{recursive:true,errorOnExist:true,force:false});
        assert(graphicSignature(source)===signature&&graphicSignature(path.join(destination,accepted))===signature,
          'Graphic changed while collecting. Save and retry.',{mediaId:media.id});
        await fs.cp(path.join(destination,accepted),path.join(destination,author),{recursive:true,errorOnExist:true,force:false});
        media.path=accepted;
        media.metadata={...media.metadata,authoringPath:author,assetSignature:signature};
      } else {
        const key=pathKey(source);
        let relative=copies.get(key);
        if(!relative) {
          relative=path.posix.join('media',media.id+path.extname(source));
          const output=path.join(destination,relative);
          await fs.mkdir(path.dirname(output),{recursive:true});
          await fs.copyFile(source,output,fs.constants.COPYFILE_EXCL);
          const after=await fs.stat(source),copied=await fs.stat(output);
          assert(after.size===stat.size&&after.mtimeMs===stat.mtimeMs&&after.ctimeMs===stat.ctimeMs&&copied.size===stat.size,
            'Source changed while collecting. Retry after it finishes saving.',{mediaId:media.id});
          copies.set(key,relative);mediaFiles++;
        }
        media.path=relative;
        if(media.metadata.format)media.metadata.format.filename=relative;
      }
    }
    for(const id of new Set(sequenceProjects(project).flatMap(view=>view.clips).map(c=>c.generationId).filter(Boolean))){
      const source=path.join(state.dir,'.afclip','generation',id),target=path.join(destination,'.afclip','generation',id);
      await fs.cp(source,target,{recursive:true,errorOnExist:true,force:false});
      const job=JSON.parse(await fs.readFile(path.join(target,'job.json'),'utf8'));
      for(const media of job.media){const copied=project.media.find(m=>m.id===media.id);if(copied)media.path=copied.path;}
      if(job.status==='generating'){job.status='failed';job.error={code:'GENERATION_INTERRUPTED',message:'Collection does not repeat in-flight API requests. Retry explicitly.'};}
      atomicJSON(path.join(target,'job.json'),job);
    }
    validateProject(project);
    atomicJSON(path.join(destination,'project.json'),project);
    completed=true;
    return {path:destination,projectId:project.id,sourceProjectId,sourceRevision,
      mediaFiles,graphics:project.media.filter(m=>m.kind==='graphic').length};
  } finally {
    // This exact directory was created exclusively above and is outside the source.
    if(!completed)await fs.rm(destination,{recursive:true,force:true});
  }
}
