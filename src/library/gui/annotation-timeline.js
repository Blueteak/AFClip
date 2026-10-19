'use strict';
// Annotation tracks share the source clock. They never cut or move the original media.
const annotationTracks=a=>a?.annotationTracks||[{id:'annotations',name:'Annotations'}];
let timelineGesture=null,timelineGeneration=0;
window.activeAnnotationTrack='annotations';
const canAnnotate=()=>!!state.selected&&!readonly&&!state.selected.deleted&&state.selected.folder!=='inbox'&&state.selected.source.status==='verified';
const timelineError=e=>say(e.message,true);
function timelineElement(tag,className,text){const e=document.createElement(tag);e.className=className;if(text!==undefined)e.textContent=text;return e;}
// Serialize autosaves per item so typing during a request keeps the newest edit.
const annotationDrafts=new Map();
let activePopover=null;
const annotationPopover=timelineElement('div','annotation-popover');
annotationPopover.id='annotation-popover';annotationPopover.hidden=true;annotationPopover.setAttribute('role','dialog');annotationPopover.setAttribute('aria-label','Tags and notes');
document.body.append(annotationPopover);
window.hasAnnotationDrafts=()=>[...annotationDrafts.values()].some(d=>d.dirty);
function closeAnnotationPopover(){const entry=activePopover&&annotationDrafts.get(activePopover.id);if(entry)savePopoverDraft({id:activePopover.id},entry).catch(timelineError);annotationPopover.hidden=true;activePopover=null;}
function positionAnnotationPopover(){
  if(!activePopover)return;
  const anchor=activePopover.rangeId?[...document.querySelectorAll('.annotation-block')].find(e=>e.dataset.range===activePopover.rangeId):document.querySelector('.annotation-source-block');
  if(!anchor){closeAnnotationPopover();return;}
  if(['take:','block:'].some(prefix=>activePopover.id.startsWith(prefix))){const current=spanRecords().find(t=>t.id===activePopover.id);const heading=annotationPopover.querySelector('.popover-heading strong');if(current&&heading)heading.textContent=current.name;}
  const r=anchor.getBoundingClientRect(),viewport=$('annotation-timeline-scroll').getBoundingClientRect();
  if(r.bottom<viewport.top||r.top>viewport.bottom){annotationPopover.hidden=true;return;}
  annotationPopover.hidden=false;
  const x=Math.max(viewport.left+150,Math.min(viewport.right,activePopover.x??(r.left+r.right)/2)),width=annotationPopover.offsetWidth,height=annotationPopover.offsetHeight;
  const left=Math.max(10,Math.min(innerWidth-width-10,x-width/2));
  annotationPopover.style.left=left+'px';annotationPopover.style.top=Math.max(10,r.top-height-14)+'px';
  annotationPopover.style.setProperty('--popover-tip',Math.max(18,Math.min(width-18,x-left))+'px');
}
async function savePopoverDraft(record,draft){
  clearTimeout(draft.timer);
  if(draft.saving)return draft.saving;
  if(!draft.dirty)return;
  draft.saving=(async()=>{
    do {
    while(draft.dirty){
      const version=draft.version;
      if(!draft.name.trim())throw new Error('Annotation name cannot be empty');
      const updated=draft.spanRecord?await saveSpanText(draft.spanRecord,draft.notes):await api('annotate',{id:record.id,revision:draft.revision,name:draft.name,notes:draft.notes,tags:[...draft.tags]});
      draft.revision=updated.revision;draft.dirty=draft.version!==version;
    }
    await refresh();
    } while(draft.dirty);
    if(activePopover?.id===record.id)$('popover-error').textContent='';
  })().catch(e=>{if(activePopover?.id===record.id)$('popover-error').textContent=e.message;throw e;}).finally(()=>{draft.saving=null;});
  return draft.saving;
}
const TAKES_TRACK='__takes',BLOCKS_TRACK='__blocks';
const isSpan=r=>['take','block'].includes(r?.recordType);
const isSpanTrack=id=>[TAKES_TRACK,BLOCKS_TRACK].includes(id);
const spanField=r=>r.recordType==='block'?'blocks':'takes';
let selectedSpan=null,spanWrites=Promise.resolve();
window.clearTakeSelection=()=>{selectedSpan=null;};
function spanRecords(a=state.selected){return ['take','block'].flatMap(type=>(a?.[type==='take'?'takes':'blocks']||[]).map((t,index)=>({...t,id:type+':'+a.id+':'+t.start+':'+t.end,assetId:a.id,recordType:type,name:(type==='take'?'Take ':'Block ')+(index+1),notes:t.text||'',tags:[],trackId:type==='take'?TAKES_TRACK:BLOCKS_TRACK})));}
function changeSpans(assetId,change,field='takes'){
  const work=spanWrites.then(async()=>{
    const asset=await api('inspect',{id:assetId}),takes=(asset[field]||[]).map(t=>({...t}));
    change(takes);
    const updated=await api('annotate',{id:assetId,revision:asset.revision,[field]:takes});
    const saved=updated[field]||[],expected=[...takes].sort((a,b)=>a.start-b.start||a.end-b.end);
    if(saved.length!==expected.length||expected.some((t,i)=>t.start!==saved[i].start||t.end!==saved[i].end||(t.text||'')!==(saved[i].text||'')))throw new Error('The library service did not save these '+field+'. Restart the library service and reopen the library, then try again.');
    await refresh();return updated;
  });
  spanWrites=work.catch(()=>{});return work;
}
function spanIndex(takes,record){const i=takes.findIndex(t=>t.start===record.start&&t.end===record.end);if(i<0)throw new Error('This '+record.recordType+' changed. Select it again.');return i;}
async function saveSpanText(record,text){return changeSpans(record.assetId,takes=>{takes[spanIndex(takes,record)].text=text;},spanField(record));}
async function deleteSpan(record){
  if(!canAnnotate()||record.assetId!==state.selected.id||deletingAnnotations.has(record.id))return;
  deletingAnnotations.add(record.id);
  try{
    const draft=annotationDrafts.get(record.id);if(draft)await savePopoverDraft(record,draft);
    await changeSpans(record.assetId,takes=>takes.splice(spanIndex(takes,record),1),spanField(record));
    annotationDrafts.delete(record.id);if(activePopover?.id===record.id)closeAnnotationPopover();selectedSpan=null;updateAnnotationPlayhead();say(record.name+' deleted. Undo to restore it.');
  }catch(e){timelineError(e);}finally{deletingAnnotations.delete(record.id);}
}
async function openSpanPopup(record,x){
  stop();window.activeAnnotationTrack=record.trackId;state.insertRange=null;selectedSpan=record;state.temporarySelection=false;markIn=record.start;markOut=record.end;showMarks();await seek(selectionPreviewTime(record,x));openAnnotationPopover(record,x);
}
async function createSpan(start,end,x,trackId=TAKES_TRACK){
  const a=state.selected;if(!canAnnotate()||end<=start)return;
  closeAnnotationPopover();
  await changeSpans(a.id,takes=>takes.push({start,end}),trackId===BLOCKS_TRACK?'blocks':'takes');
  if(state.selected?.id!==a.id)return;
  const record=spanRecords().find(t=>t.trackId===trackId&&t.start===start&&t.end===end);selectedSpan=record;state.insertRange=null;state.temporarySelection=false;updateAnnotationPlayhead();say(record.name+' created');
}
const deletingAnnotations=new Set();
async function deleteAnnotation(record){
  if(readonly||!state.selected||state.selected.deleted||state.selected.folder==='inbox'||record?.recordType!=='range'||record.assetId!==state.selected.id||deletingAnnotations.has(record.id))return;
  deletingAnnotations.add(record.id);
  try{
    const draft=annotationDrafts.get(record.id);
    if(draft)await savePopoverDraft(record,draft);
    await api('range-delete',{id:record.id,revision:Math.max(draft?.revision||0,record.revision)});
    annotationDrafts.delete(record.id);
    if(activePopover?.id===record.id)closeAnnotationPopover();
    if(state.insertRange?.id===record.id){state.insertRange=null;state.temporarySelection=false;markIn=0;markOut=state.selected.duration;showMarks();}
    await refresh();say('Annotation deleted. Undo to restore it.');
  }catch(e){if(activePopover?.id===record.id)$('popover-error').textContent=e.message;timelineError(e);}
  finally{deletingAnnotations.delete(record.id);}
}
function openAnnotationPopover(record,x){
  if(record.recordType==='block'){closeAnnotationPopover();updateAnnotationPlayhead();return;}
  stop();if(!isSpan(record))selectedSpan=null;state.insertRange=record.recordType==='range'?record:null;updateAnnotationPlayhead();const cached=annotationDrafts.get(record.id);const draft=(cached&&(cached.dirty||cached.saving)?cached:null)||{revision:record.revision,name:record.name,notes:record.notes,tags:new Set(record.tags),dirty:false,version:0,spanRecord:isSpan(record)?record:null};
  annotationDrafts.set(record.id,draft);activePopover={id:record.id,rangeId:['range','take','block'].includes(record.recordType)?record.id:null,x};
  const disabled=readonly||state.selected.deleted||state.selected.folder==='inbox';
  annotationPopover.innerHTML=`<form id="popover-form"><div class="popover-heading">${isSpan(record)?`<strong>${esc(record.name)}</strong>`:`<input id="popover-name" aria-label="Annotation name" value="${esc(draft.name)}" required ${disabled?'disabled':''}>`}<button type="button" id="popover-close" aria-label="Close tags and notes">×</button></div><div class="popover-body">${isSpan(record)?'':'<div class="popover-label">Tags</div><div class="tag-picker" id="popover-tags"></div>'}<label>${isSpan(record)?'Text (optional)':'Notes'}<textarea id="popover-notes" rows="3" placeholder="Add notes…" ${disabled?'disabled':''}>${esc(draft.notes)}</textarea></label><div id="popover-error" role="status"></div></div><div class="popover-actions"><button type="button" id="popover-delete" title="Delete ${isSpan(record)?record.recordType:'annotation'} · Del (hovered or selected)" aria-keyshortcuts="Delete" ${disabled||!['range','take','block'].includes(record.recordType)?'hidden':''}>Delete <kbd>Del</kbd></button></div></form>`;
  const changed=()=>{draft.dirty=true;draft.version++;clearTimeout(draft.timer);draft.timer=setTimeout(()=>savePopoverDraft(record,draft).catch(timelineError),300);};
  for(const tag of isSpan(record)?[]:state.overview.tags){const b=timelineElement('button','tag-chip',tag.name);b.type='button';b.disabled=disabled;b.classList.toggle('active',draft.tags.has(tag.id));b.setAttribute('aria-pressed',draft.tags.has(tag.id));b.onclick=()=>{draft.tags.has(tag.id)?draft.tags.delete(tag.id):draft.tags.add(tag.id);b.classList.toggle('active',draft.tags.has(tag.id));b.setAttribute('aria-pressed',draft.tags.has(tag.id));changed();};$('popover-tags').append(b);}
  if($('popover-name'))$('popover-name').oninput=e=>{draft.name=e.target.value;changed();};$('popover-notes').oninput=e=>{draft.notes=e.target.value;changed();};
  $('popover-close').onclick=closeAnnotationPopover;
  $('popover-delete').onclick=()=>isSpan(record)?deleteSpan(record):deleteAnnotation(record);
  $('popover-form').onsubmit=e=>{e.preventDefault();savePopoverDraft(record,draft).catch(timelineError);};
  annotationPopover.hidden=false;positionAnnotationPopover();
}
document.addEventListener('pointerdown',e=>{if(activePopover&&!annotationPopover.contains(e.target))closeAnnotationPopover();},true);
document.addEventListener('keydown',e=>{
  if(e.key!=='Delete'||e.repeat||e.ctrlKey||e.metaKey||e.altKey||readonly||timelineGesture||$('dialog').open||e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
  const id=document.querySelector('.annotation-block:hover')?.dataset.range||selectedSpan?.id||state.insertRange?.id;
  const record=[...(state.selected?.ranges||[]),...spanRecords()].find(r=>r.id===id);
  if(!record)return;
  e.preventDefault();e.stopImmediatePropagation();isSpan(record)?deleteSpan(record):deleteAnnotation(record);
},true);
document.addEventListener('keydown',e=>{if(!activePopover)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeAnnotationPopover();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopImmediatePropagation();$('popover-form').requestSubmit();}},true);
window.addEventListener('resize',positionAnnotationPopover);
$('annotation-timeline-scroll').addEventListener('scroll',positionAnnotationPopover);
new ResizeObserver(positionAnnotationPopover).observe(annotationPopover);
async function saveAnnotationTracks(tracks){const a=state.selected;await api('annotate',{id:a.id,revision:a.revision,annotationTracks:tracks});await refresh();}
click('add-annotation-track',()=>{
  if(!canAnnotate())return;
  dialog('New annotation track','<label>Name<input id="track-name" value="Annotations '+(annotationTracks(state.selected).length+1)+'" maxlength="100" required></label>',async()=>{
    const id='track_'+crypto.randomUUID();await saveAnnotationTracks([...annotationTracks(state.selected),{id,name:$('track-name').value}]);window.activeAnnotationTrack=id;
  },'Create track');
});
function editAnnotationTrack(track){
  if(!canAnnotate())return;
  const tracks=annotationTracks(state.selected),occupied=state.selected.ranges.some(r=>(r.trackId||'annotations')===track.id);
  dialog('Annotation track',`<label>Name<input id="track-name" value="${esc(track.name)}" maxlength="100" required></label><button type="button" id="track-up" ${tracks[0].id===track.id?'disabled':''}>Move up</button> <button type="button" id="track-down" ${tracks.at(-1).id===track.id?'disabled':''}>Move down</button><p>Drag annotations between tracks. Double-click a track name to rename it.</p><button type="button" id="track-delete" ${occupied||tracks.length===1?'disabled':''}>Delete empty track</button>`,()=>saveAnnotationTracks(tracks.map(t=>t.id===track.id?{...t,name:$('track-name').value}:t)));
  for(const [id,delta]of [['track-up',-1],['track-down',1]])click(id,async()=>{const next=[...tracks],i=next.findIndex(t=>t.id===track.id);[next[i],next[i+delta]]=[next[i+delta],next[i]];await saveAnnotationTracks(next);closeDialog();});
  click('track-delete',async()=>{await saveAnnotationTracks(tracks.filter(t=>t.id!==track.id));closeDialog();});
}
async function newAnnotationPopover(trackId=window.activeAnnotationTrack,x){
  if(isSpanTrack(trackId))return createSpan(Math.min(markIn,markOut),Math.max(markIn,markOut),x,trackId);
  if(!canAnnotate())return;
  const a=state.selected;
  const start=Math.min(markIn,markOut),end=Math.max(markIn,markOut);
  if(end<=start)throw new Error('Drag a range or set different In and Out points first');
  const boundaries=await annotationBounds(a,start,end);if(!boundaries)return;
  const record=await api('range-save',{assetId:a.id,revision:a.revision,trackId,name:'Annotation',tags:[],notes:'',...boundaries});
  await refresh();
  if(state.selected?.id!==a.id)return;
  state.insertRange=record;state.temporarySelection=false;showMarks();
  openAnnotationPopover(record,x);say('Annotation created');
  $('popover-name').focus({preventScroll:true});$('popover-name').select();
}
click('timeline-create',()=>newAnnotationPopover());
click('new-range',()=>newAnnotationPopover());
$('timeline-zoom').oninput=()=>drawAnnotationTimeline();
function updateAnnotationPlayhead(){
  const a=state.selected;if(!a)return;
  document.querySelectorAll('.annotation-block').forEach(b=>{const selected=b.dataset.range===(selectedSpan?.assetId===a.id?selectedSpan.id:state.insertRange?.id);b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected);});
  const playhead=$('annotation-playhead');if(playhead)playhead.style.left=`calc(150px + (100% - 150px) * ${Math.min(1,time/(a.duration||1))})`;
  const selection=$('annotation-selection');if(selection){selection.style.left=(Math.min(markIn,markOut)/(a.duration||1)*100)+'%';selection.style.width=(Math.abs(markOut-markIn)/(a.duration||1)*100)+'%';selection.hidden=!state.temporarySelection;}
}
window.updateAnnotationPlayhead=updateAnnotationPlayhead;
async function renderAnnotationTimeline(){
  if(timelineGesture)return;
  const generation=++timelineGeneration,a=state.selected,host=$('annotation-timeline-content');
  $('add-annotation-track').hidden=$('timeline-create').hidden=readonly;
  $('add-annotation-track').disabled=$('timeline-create').disabled=!canAnnotate();
  if(!a){host.replaceChildren();$('timeline-source-name').textContent='';return;}
  // The timeline must include ranges beyond the inspector's first page.
  let offset=a.rangePage?.nextOffset;
  while(offset!==null&&offset!==undefined){
    const page=await api('inspect',{id:a.id,rangeOffset:offset});if(generation!==timelineGeneration||state.selected!==a)return;
    a.ranges.push(...page.ranges);offset=page.rangePage.nextOffset;
  }
  if(a.rangePage)a.rangePage.nextOffset=null;
  const tracks=annotationTracks(a);if(!isSpanTrack(window.activeAnnotationTrack)&&!tracks.some(t=>t.id===window.activeAnnotationTrack))window.activeAnnotationTrack=tracks[0].id;
  host.replaceChildren();host.style.width=(Number($('timeline-zoom').value)*100)+'%';
  $('timeline-source-name').textContent=a.name;
  $('timeline-hint').textContent=readonly?'Read-only library view. Use Edit in library to create or change annotations.':canAnnotate()?'Drag empty track space to create an annotation. Drag blocks to move; drag their edges to trim. Click a block for Tags + Notes.':'Click a clip or annotation to inspect it. Promote Inbox items and verify sources before annotating.';
  const ruler=timelineElement('div','annotation-row annotation-ruler'),label=timelineElement('div','annotation-track-head','Source time'),scale=timelineElement('div','annotation-lane annotation-scale');
  ruler.append(label,scale);host.append(ruler);
  const divisions=Math.max(4,Math.round(8*Number($('timeline-zoom').value)));
  for(let i=0;i<=divisions;i++){const t=timelineElement('span','annotation-tick',clock(a.duration*i/divisions));t.style.left=(i/divisions*100)+'%';scale.append(t);}
  scale.onpointerdown=e=>beginTimelineGesture(e,scale,'seek');
  const row=timelineElement('div','annotation-row'),head=timelineElement('div','annotation-track-head','Full clip'),lane=timelineElement('div','annotation-lane source-lane');
  const source=timelineElement('button','annotation-source-block '+a.kind);source.type='button';source.title='Open clip Tags + Notes';source.setAttribute('aria-label','Full clip: '+a.name);
  const thumb=timelineElement('img','');thumb.src='/v1/media/'+a.sourceId+'/image';thumb.alt='';thumb.onerror=()=>thumb.remove();source.append(thumb,timelineElement('span','',a.name),timelineElement('small','',duration(a.duration)));source.onclick=e=>openAnnotationPopover(a,e.detail?e.clientX:undefined);
  const selection=timelineElement('div','annotation-selection');selection.id='annotation-selection';lane.append(source,selection);row.append(head,lane);const sourceRow=row;
  for(const track of [{id:TAKES_TRACK,name:'Takes'},{id:BLOCKS_TRACK,name:'Blocks'},...tracks]){
    const row=timelineElement('div','annotation-row'),head=timelineElement('div','annotation-track-head'),name=timelineElement('button','annotation-track-name',track.name),options=timelineElement('button','annotation-track-options','⋯');
    const compact=isSpanTrack(track.id);row.classList.toggle('compact-span-row',compact);
    name.title=compact?'Drag here to create '+track.name.toLowerCase():'Double-click to rename track';name.onclick=()=>{window.activeAnnotationTrack=track.id;drawAnnotationTimeline().catch(timelineError);};name.ondblclick=()=>{if(!compact)editAnnotationTrack(track);};options.setAttribute('aria-label','Edit track '+track.name);options.onclick=()=>editAnnotationTrack(track);options.hidden=readonly||compact;
    head.classList.toggle('active',track.id===window.activeAnnotationTrack);head.append(name,options);
    const lane=timelineElement('div','annotation-lane');lane.dataset.track=track.id;
    // Overlapping annotations remain individually clickable within their track.
    const ends=[];
    for(const r of (compact?spanRecords(a):a.ranges).filter(r=>(r.trackId||'annotations')===track.id).sort((x,y)=>secs(x.start)-secs(y.start))){
      let stack=ends.findIndex(end=>end<=secs(r.start));if(stack<0)stack=ends.length;ends[stack]=secs(r.end);
      const block=timelineElement('button','annotation-block'+(isSpan(r)?' take-block'+(r.recordType==='block'?' blocked-span':''):''));block.type='button';block.dataset.range=r.id;block.setAttribute('aria-label','Annotation: '+r.name);block.title=`${r.name}\n${clock(secs(r.start))} → ${clock(secs(r.end))}\n${r.recordType==='block'?'Click to select · Del to delete':isSpan(r)?'Click for optional text':'Click for Tags + Notes'}`;
      block.style.left=(secs(r.start)/a.duration*100)+'%';block.style.width=((secs(r.end)-secs(r.start))/a.duration*100)+'%';block.style.top=(compact?3.75+stack*27:5+stack*36)+'px';
      block.append(timelineElement('span','annotation-block-name',r.name));
      if(r.recordType==='take'&&r.text?.trim())block.append(timelineElement('span','take-text-preview',r.text.trim().replace(/\s+/g,' ').slice(0,120)));
      for(const edge of ['start','end']){const handle=timelineElement('span','annotation-trim '+edge);handle.dataset.edge=edge;block.append(handle);}
      block.onpointerdown=e=>beginTimelineGesture(e,lane,e.target.dataset.edge||'move',r);
      block.onclick=e=>{if(e.detail===0)openRangePopup(r).catch(timelineError);};lane.append(block);
    }
    lane.style.height=(compact?Math.max(36,ends.length*27+7.5):Math.max(48,ends.length*36+10))+'px';lane.onpointerdown=e=>{if(e.target===lane)beginTimelineGesture(e,lane,'create');};row.append(head,lane);host.append(row);
    if(track.id===BLOCKS_TRACK)host.append(sourceRow);
  }
  const playhead=timelineElement('div','annotation-playhead');playhead.id='annotation-playhead';host.append(playhead);updateAnnotationPlayhead();positionAnnotationPopover();
}
window.drawAnnotationTimeline=()=>renderAnnotationTimeline().catch(timelineError);
async function openRangePopup(r,x){if(isSpan(r))return openSpanPopup(r,x);stop();window.activeAnnotationTrack=r.trackId||'annotations';state.insertRange=r;state.temporarySelection=false;markIn=secs(r.start);markOut=secs(r.end);showMarks();await seek(selectionPreviewTime(r,x));openAnnotationPopover(r,x);}
function selectionPreviewTime(record,x){
  const lane=[...document.querySelectorAll('.annotation-block')].find(b=>b.dataset.range===record.id)?.closest('.annotation-lane');
  return x===undefined||!lane?secs(record.start):timelineTimeAt(x,lane);
}
function timelineTimeAt(clientX,lane){
  const a=state.selected,r=lane.getBoundingClientRect();
  const value=Math.max(0,Math.min(a.duration,(clientX-r.left)/r.width*a.duration));
  if(value>=a.duration)return a.duration;
  if(a.kind==='video'&&preview?.pts.length){
    let low=0,high=preview.pts.length;
    while(low<high){const mid=(low+high)>>>1;if(preview.pts[mid]<=value+1e-7)low=mid+1;else high=mid;}
    return preview.pts[Math.max(0,low-1)];
  }
  if(a.kind==='audio'){const rate=Number(a.source.metadata?.streams?.find(s=>s.codec_type==='audio')?.sample_rate||48000);return Math.round(value*rate)/rate;}
  return value;
}
let hoverSeekFrame=0;
$('annotation-timeline-scroll').addEventListener('pointermove',e=>{
  if(timelineGesture||e.pointerType==='touch'||!state.selected)return;
  const lane=e.target.closest('.annotation-lane');if(!lane)return;
  cancelAnimationFrame(hoverSeekFrame);
  const assetId=state.selected.id,value=timelineTimeAt(e.clientX,lane);
  hoverSeekFrame=requestAnimationFrame(()=>{hoverSeekFrame=0;if(!timelineGesture&&state.selected?.id===assetId)seek(value).catch(timelineError);});
});
$('annotation-timeline-scroll').addEventListener('pointerleave',()=>cancelAnimationFrame(hoverSeekFrame));
function beginTimelineGesture(e,lane,mode,range){
  if(e.button!==0||!state.selected)return;e.preventDefault();e.stopPropagation();
  if(mode==='create'&&!canAnnotate())return;
  cancelAnimationFrame(hoverSeekFrame);stop();const a=state.selected,at=x=>timelineTimeAt(x,lane);
  const first=at(e.clientX),start=range?secs(range.start):first,end=range?secs(range.end):first;
  timelineGesture={assetId:a.id,mode,range,start,end,trackId:lane.dataset.track,clientX:e.clientX,clientY:e.clientY,moved:false};
  const ghost=timelineElement('div','annotation-drag-preview'+(lane.dataset.track===BLOCKS_TRACK?' blocked-span':''));if(mode!=='seek')lane.append(ghost);
  const fps=String(a.source.metadata?.fps||30).split('/').map(Number);
  const step=a.kind==='audio'?1/Number(a.source.metadata?.streams?.find(s=>s.codec_type==='audio')?.sample_rate||48000):(fps[1]||1)/(fps[0]||30);
  lane.setPointerCapture(e.pointerId);
  const move=event=>{
    const g=timelineGesture;if(!g)return;g.moved ||= Math.abs(event.clientX-g.clientX)>3||Math.abs(event.clientY-g.clientY)>3;
    const current=at(event.clientX),delta=current-first;
    seek(current).catch(timelineError);
    if(mode==='seek')return;
    if(mode==='create'){g.start=Math.min(first,current);g.end=Math.max(first,current);markIn=g.start;markOut=g.end;state.temporarySelection=true;showMarks();}
    else if(mode==='move'){g.start=Math.max(0,Math.min(a.duration-(end-start),start+delta));g.end=g.start+(end-start);const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.annotation-lane[data-track]');if(target&&(isSpan(range)?target.dataset.track===range.trackId:!isSpanTrack(target.dataset.track))){g.trackId=target.dataset.track;target.append(ghost);}}
    else if(mode==='start')g.start=Math.max(0,Math.min(end-step,start+delta));
    else if(mode==='end')g.end=Math.min(a.duration,Math.max(start+step,end+delta));
    ghost.style.left=(g.start/a.duration*100)+'%';ghost.style.width=((g.end-g.start)/a.duration*100)+'%';ghost.textContent=clock(g.start)+' – '+clock(g.end);
  };
  const finish=async(event,cancelled=false)=>{
    if(!cancelled)move(event);
    const g=timelineGesture;timelineGesture=null;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);ghost.remove();if(lane.hasPointerCapture(e.pointerId))lane.releasePointerCapture(e.pointerId);
    if(!g||cancelled)return;
    try{
      if(mode==='seek'){await seek(at(event.clientX));return;}
      if(range&&!g.moved){await openRangePopup(range,g.clientX);return;}
      if(!g.moved){await seek(first);return;}
      if(!canAnnotate())return;
      window.activeAnnotationTrack=g.trackId;markIn=g.start;markOut=g.end;state.temporarySelection=true;showMarks();
      if(mode==='create'){if(isSpanTrack(g.trackId))await createSpan(g.start,g.end,event.clientX,g.trackId);else await newAnnotationPopover(g.trackId,event.clientX);return;}
      if(isSpan(range)){const draft=annotationDrafts.get(range.id);if(draft)await savePopoverDraft(range,draft);await changeSpans(a.id,takes=>{Object.assign(takes[spanIndex(takes,range)],{start:g.start,end:g.end});},spanField(range));annotationDrafts.delete(range.id);selectedSpan=spanRecords().find(t=>t.trackId===range.trackId&&t.start===g.start&&t.end===g.end);state.temporarySelection=false;return;}
      const boundaries=await annotationBounds(a,g.start,g.end);if(!boundaries)return;
      await api('range-save',{id:range.id,assetId:a.id,revision:range.revision,trackId:g.trackId,...boundaries});state.temporarySelection=false;await refresh();
    }catch(error){timelineError(error);}finally{window.drawAnnotationTimeline();}
  };
  const up=e=>finish(e),cancel=e=>finish(e,true);
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);
  move(e);
}
async function annotationBounds(a,start,end){
  if(a.kind==='audio'){const rate=Number(a.source.metadata.streams.find(s=>s.codec_type==='audio').sample_rate);const first=Math.round(start*rate),last=Math.min(Math.floor(a.duration*rate),Math.round(end*rate));return {startSample:first,endSample:Math.max(first+1,last)};}
  const generation=state.previewGeneration,current=()=>state.selected?.id===a.id&&state.selected.sourceId===a.sourceId&&state.previewGeneration===generation;
  let data=preview;
  requestsInFlight++;
  try{
    if(!data?.pts.length)data=await api('preview',{id:a.id});
    if(!current())return null;
    if(!data.pts.length){
      say('Indexing video for annotation…');
      const {jobs}=await api('prepare',{ids:[a.id],level:'index'}),deadline=Date.now()+300000;
      for(;;){
        if(!current())return null;
        const job=await api('jobs',{id:jobs[0].id});
        if(['failed','cancelled'].includes(job.status))throw new Error(job.error||'Video indexing cancelled');
        if(job.status==='completed')break;
        if(Date.now()>deadline)throw new Error('Video indexing is still running. Try the annotation again when it finishes.');
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      data=await api('preview',{id:a.id});
    }
    if(!current())return null;
    if(data.source.id!==a.sourceId)throw new Error('Source changed. Select the video again.');
    if(!data.pts.length)throw new Error('No video frames available for annotation');
    preview=data;
    const frame=t=>{const i=data.pts.findIndex(p=>p>=t-1e-7);return i<0?data.pts.length:i;};const first=Math.min(data.pts.length-1,frame(start));return {startFrame:first,endFrame:Math.max(first+1,frame(end))};
  }finally{requestsInFlight--;}
}
window.drawAnnotationTimeline();
