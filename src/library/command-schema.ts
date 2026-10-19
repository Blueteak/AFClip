// CLI discovery and parsing share this catalog. Structured call remains the API escape hatch.
const specs:Record<string,string>={
  gui:'id dev:boolean',endpoint:'',
  search:'q folder kind:audio|video tag collection minDuration:number maxDuration:number limit:number offset:number assetsOnly:boolean deleted:boolean include-inbox:boolean full:boolean fields:list',
  overview:'full:boolean fields:list',inspect:'id rangeOffset:number sourceId',original:'id',preview:'id start-frame:number frame-count:number',frames:'id start-frame:number frame-count:number',selection:'id revision:number sourceId startFrame:number endFrame:number startSample:number endSample:number',
  waveform:'id start duration bins:number summary:boolean',
  import:'path paths:json folder limit:number hierarchy:boolean',register:'path paths:json projectId projectPath',
  annotate:'id revision:number name notes tags:list takes:json annotationTracks:json trackId',
  'range-save':'assetId revision:number id name notes tags:list trackId startFrame:number endFrame:number startSample:number endSample:number',
  'range-delete':'id revision:number',move:'id revision:number folder',promote:'id revision:number folder',
  'folder-create':'name parent','folder-update':'id revision:number name parent','folder-delete':'id revision:number',
  'tag-create':'name','tag-rename':'id revision:number name','tag-delete':'id revision:number confirm','tag-merge':'id revision:number target targetRevision:number',
  'collection-create':'name','collection-update':'id revision:number name members:list','collection-delete':'id revision:number',
  prepare:'ids:list folder level:index|preview',artifact:'id type:frame|contact-sheet|excerpt time start end width:number count:number columns:number frame:number image-size:low|review|full',
  jobs:'id ids:list',cancel:'id',history:'',undo:'',redo:'',references:'',
  'source-folder-save':'id revision:number path folder watched:boolean hierarchy:boolean','source-folder-remove':'id revision:number','source-folders':'',rescan:'id path paths:json folder limit:number hierarchy:boolean',
  replace:'id revision:number path confirm',remove:'id revision:number',restore:'id revision:number',purge:'id revision:number confirm',
  retain:'id projectId projectPath',withdraw:'id projectId','sync-project':'projectId projectPath assetIds:json',
  checkpoint:'name',checkpoints:'','checkpoint-restore':'id confirm',cache:'','cache-clear':'','cache-budget':'bytes:number',close:'',apply:'operations:json',call:''
};
const notes:Record<string,string>={
  frames:'Exact stored ticks and timeBase. --start-frame N --frame-count N pages the index (default 120, max 10000); nextFrame continues. --full returns the entire index.',
  preview:'Frame count and timing by default; --start-frame N --frame-count N returns stored timestamps. --full includes all timestamps and raw source metadata.',
  search:'Compact by default. --full includes source metadata. --folder inbox means Inbox only; --include-inbox includes it alongside the library. Follow nextOffset until complete.',
  overview:'Compact vocabulary, folders, counts and job totals by default; --full includes history and jobs.',
  prepare:'index prepares exact video frame boundaries only; audio index is already available after verification. preview also builds seek proxies and audio. Default: preview. Review artifacts and index jobs run before queued previews; running work is not preempted.',
  artifact:'Images default to review: 1024px longest edge; --image-size low caps at 512px; full keeps native pixels. Aspect ratio is preserved, with no upscaling. The limit covers the whole contact sheet. Use full on individual frames for small text or fine detail. --width explicitly overrides sizing (per tile for sheets); cannot combine with image-size. --full only expands JSON. Contact sheets return sourceName and frames [{tile,timeSeconds}] in row-major order after completion. Times identify the sampled source frames. Use --wait or jobs to retrieve the manifest.',
  waveform:'--summary omits sample arrays; defaults to 2048 bins. sourceSampleRate is for range boundaries; decodedSampleRate describes the waveform. Peak/activity times are approximate to timeResolutionSeconds, at an activity threshold of -40 dBFS.',
  annotate:'JSON takes: [{start,end,text?}] in seconds. annotationTracks: [{id,name}]. Tags use vocabulary IDs. Requires current item revision.',
  'range-save':'Ends are exclusive. Video requires prepare --level index and integer frame bounds; audio requires integer source sample bounds. Creation checks the parent asset revision; updates check the range revision. Range changes increment parent revision.',
  apply:'Atomic ordered operations, 1-1000. Result is an array in operation order, each with its ID and revision at that point. Later operations must use revisions resulting from earlier operations. Relationship changes also bump parent/tag revisions; inspect those objects again. Conflict rolls back the entire batch. Example: promote revision 2 then annotate revision 3 on the same asset.',
  call:'Read exact API request JSON from a file or stdin (-). Service payloads keep full search/overview responses unless compact:true is requested. CLI flags other than catalog/wait/timeout/author do not apply to the request.'
};
export const commandSchema=Object.fromEntries(Object.entries(specs).map(([command,spec])=>[command,{command,fields:Object.fromEntries(spec.split(' ').filter(Boolean).map(field=>{const [name,type='string']=field.split(':');return [name,type];})),...(notes[command]?{notes:notes[command]}:{})}]));
export const globals:Record<string,string>={catalog:'string',author:'human|agent',wait:'boolean',timeout:'number',full:'boolean',pretty:'boolean',progress:'boolean'};
export function schema(command?:string){
  if(command&&!commandSchema[command])throw new Error(`Unknown command: ${command}`);
  return {version:1,...(command?commandSchema[command]:{commands:commandSchema}),globalOptions:globals,
    wait:'--wait returns one final JSON response; --progress also emits changes to stderr. --timeout seconds defaults to 300; a timeout leaves jobs running and returns their IDs.'};
}
