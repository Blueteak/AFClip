'use strict';
const $=id=>document.getElementById(id), params=new URLSearchParams(location.search),readonly=params.get('mode')==='afclip';
const state={overview:null,items:[],selected:null,selectedIds:new Set(),selectionAnchor:null,selectionGeneration:0,folder:params.get('folder')||'',collection:'',deleted:false,kind:'',offset:0,nextOffset:null,dirty:false,tags:new Set(),generation:0,previewGeneration:0};
let requestsInFlight=0,reloadReady=false;
function setBrowserView(mode){
  $('assets').classList.toggle('asset-list',mode==='list');
  for(const view of ['grid','list'])$('view-'+view).setAttribute('aria-pressed',view===mode);
  try{localStorage.setItem('afclip-library-view',mode);}catch{}
}
for(const mode of ['grid','list'])click('view-'+mode,()=>setBrowserView(mode));
try{setBrowserView(localStorage.getItem('afclip-library-view')==='list'?'list':'grid');}catch{}

let native=null,audio=null,wave=null,playing=false,time=0,markIn=0,markOut=0,preview=null,tick=0,baseTime=0,baseClock=0,eventTimer;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const secs=t=>typeof t==='number'?t:t?t.num/t.den:0;
const clock=t=>`${String(Math.floor(Math.max(0,t)/60)).padStart(2,'0')}:${(Math.max(0,t)%60).toFixed(3).padStart(6,'0')}`;
const duration=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
function say(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
async function api(command,fields={}){requestsInFlight++;try{const response=await fetch('/v1/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,author:$('author').value,...fields})});const r=await response.json();if(!r.ok){const e=new Error(r.error.message);e.details=r.error.details;throw e;}return r.result;}finally{requestsInFlight--;}}
async function act(work,message){try{const result=await work();if(message)say(message);await refresh();return result;}catch(e){say(e.message,true);throw e;}}
function click(id,fn){$(id).onclick=()=>Promise.resolve().then(fn).catch(e=>say(e.message,true));}
function nav(label,icon,selected,fn,count){const b=document.createElement('button');b.className='nav-item'+(selected?' active':'');b.innerHTML=`<span>${icon}</span><span>${esc(label)}</span>${count!==undefined?`<span class="count">${count}</span>`:''}`;b.onclick=()=>Promise.resolve(fn()).catch(e=>say(e.message,true));return b;}
function count(filter){return state.overview.counts.filter(filter).reduce((n,c)=>n+Number(c.count),0);}
async function view(folder='',kind='',collection='',deleted=false){if(!await abandon())return;Object.assign(state,{folder,kind,collection,deleted,offset:0});$('kind').value=kind;await refresh();}
function drawNavigation(){const o=state.overview;$('navigation').replaceChildren(
  nav('All assets','▦',!state.folder&&!state.kind&&!state.collection&&!state.deleted,()=>view(),count(c=>c.folder!=='inbox')),
  nav('Video','▻',state.kind==='video'&&!state.folder,()=>view('','video'),count(c=>c.kind==='video'&&c.folder!=='inbox')),
  nav('Audio & SFX','♫',state.kind==='audio'&&!state.folder,()=>view('','audio'),count(c=>c.kind==='audio'&&c.folder!=='inbox')),
  nav('Inbox','⇣',state.folder==='inbox',()=>view('inbox'),count(c=>c.folder==='inbox')),
  nav('Trash','⌫',state.deleted,()=>view('','','',true)));
  $('folders').replaceChildren();const tree=(parent,depth)=>{for(const f of o.folders.filter(f=>f.parent===parent)){const b=nav(f.name,'▱',state.folder===f.id,()=>view(f.id),count(c=>c.folder===f.id));b.style.paddingLeft=(10+depth*12)+'px';b.oncontextmenu=e=>{e.preventDefault();folderManager(f);};b.ondragover=e=>{e.preventDefault();b.classList.add('drop-target');};b.ondragleave=()=>b.classList.remove('drop-target');b.ondrop=e=>{e.preventDefault();b.classList.remove('drop-target');dropFiles(e,f.id);};$('folders').append(b);tree(f.id,depth+1);}};tree(null,0);
  $('collections').replaceChildren(...o.collections.map(c=>{const b=nav(c.name,'◇',state.collection===c.id,()=>view('','',c.id),c.members.length);b.oncontextmenu=e=>{e.preventDefault();collectionManager(c);};return b;}));
  const selected=$('tag-filter').value;$('tag-filter').innerHTML='<option value="">Any tag</option>'+o.tags.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');$('tag-filter').value=selected;
  $('undo').disabled=!o.history.some(h=>!h.undone);$('redo').disabled=!o.history.some(h=>h.undone);
  $('job-count').textContent=o.jobs.filter(j=>['queued','running'].includes(j.status)).length||'';
}
async function refresh(){state.overview=await api('overview');drawNavigation();await search();if(state.selected&&!state.dirty){try{const previous=state.selected,a=await api('inspect',{id:previous.id});state.selected=a;if(a.sourceId!==previous.sourceId){try{await openPreview(a);}catch(error){say(error.message,true);}}window.drawAnnotationTimeline?.();}catch{state.selected=null;}}selectedActions();}
function selectedActions(){
  const a=state.selected,available=a?.availability==='available'&&!a.deleted;
  $('organize').hidden=readonly;$('organize').disabled=!a||!!a.purged;
  $('organize').textContent=a?.deleted?'Restore…':a?.folder==='inbox'?'Keep in library…':'Organize';
  for(const id of ['reveal-original','drag-original']){$(id).hidden=!window.libraryNative;$(id).disabled=!available;}
  $('insert').disabled=!available;$('edit-library').disabled=!a;
  $('new-range').disabled=readonly||!a||a.deleted||a.folder==='inbox'||a.source.status!=='verified';
}
function clipIcon(kind,label,count){
  const shapes={video:'<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',audio:'<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',range:'<path d="M8 4H4v16h4M16 4h4v16h-4M8 12h8"/>',notes:'<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',unavailable:'<path d="m12 3 10 18H2zM12 9v5M12 17v1"/>',pending:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'};
  return `<span class="clip-icon ${kind}${count?' counted':''}" title="${esc(label)}" role="img" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[kind==='annotations'?'notes':kind]}</svg>${count?`<b aria-hidden="true">${count}</b>`:''}</span>`;
}
const clipInfo=document.createElement('div');
clipInfo.id='clip-info';clipInfo.className='clip-info';clipInfo.hidden=true;clipInfo.setAttribute('role','tooltip');document.body.append(clipInfo);
let clipInfoTimer,clipInfoAnchor;
function hideClipInfo(){clearTimeout(clipInfoTimer);clipInfoAnchor?.removeAttribute('aria-describedby');clipInfoAnchor=null;clipInfo.hidden=true;}
function deferHideClipInfo(){clearTimeout(clipInfoTimer);clipInfoTimer=setTimeout(hideClipInfo,140);}
function showClipInfo(card,item){
  hideClipInfo();clipInfoAnchor=card;
  clipInfoTimer=setTimeout(()=>{
    if(!card.isConnected)return hideClipInfo();
    const tags=(item.tags||[]).map(id=>state.overview.tags.find(t=>t.id===id)?.name).filter(Boolean);
    clipInfo.innerHTML=`<strong class="clip-info-name">${esc(item.name)}</strong><div class="clip-info-body"><div class="clip-info-label">Tags</div><div class="tag-picker">${tags.length?tags.map(name=>`<span class="tag-chip active">${esc(name)}</span>`).join(''):'<span class="clip-info-empty">No tags</span>'}</div><div class="clip-info-label">Notes</div><div class="clip-info-notes${item.notes?'':' clip-info-empty'}">${esc(item.notes||'No notes')}</div></div>`;
    clipInfo.hidden=false;card.setAttribute('aria-describedby',clipInfo.id);
    const rect=card.getBoundingClientRect(),width=clipInfo.offsetWidth,height=clipInfo.offsetHeight;
    let left=rect.right+8;if(left+width>innerWidth-8)left=rect.left-width-8;
    clipInfo.style.left=Math.max(8,Math.min(left,innerWidth-width-8))+'px';
    clipInfo.style.top=Math.max(8,Math.min(rect.top,innerHeight-height-8))+'px';
  },300);
}
clipInfo.onpointerenter=()=>clearTimeout(clipInfoTimer);clipInfo.onpointerleave=deferHideClipInfo;
$('assets').addEventListener('scroll',hideClipInfo);
window.addEventListener('resize',hideClipInfo);
document.addEventListener('pointerdown',e=>{if(!clipInfo.contains(e.target))hideClipInfo();},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideClipInfo();},true);
async function search(){const generation=++state.generation;const query={groupByAsset:true,q:$('search').value,folder:state.folder,kind:$('kind').value,collection:state.collection,deleted:state.deleted,offset:state.offset,limit:60};for(const [id,key]of [['min-duration','minDuration'],['max-duration','maxDuration']])if($(id).value!=='')query[key]=Number($(id).value);if($('tag-filter').value)query.tag=$('tag-filter').value;
  const r=await api('search',query);if(generation!==state.generation)return;state.items=r.items;state.nextOffset=r.nextOffset;const visible=new Set(r.items.map(item=>item.id));state.selectedIds=new Set([...state.selectedIds].filter(id=>visible.has(id)));if(!visible.has(state.selectionAnchor))state.selectionAnchor=null;
  $('view-title').textContent=state.deleted?'Trash':state.folder==='inbox'?'Inbox':state.overview.folders.find(f=>f.id===state.folder)?.name||state.overview.collections.find(c=>c.id===state.collection)?.name||($('kind').value==='audio'?'Audio & SFX':$('kind').value==='video'?'Video':'All assets');
  $('result-count').textContent=`${r.items.length} results${r.complete?'':' · more available'}${state.offset?' · page '+(state.offset/60+1):''}`;$('query-time').textContent=`${r.elapsedMs.toFixed(1)} ms`;$('previous').disabled=!state.offset;$('next').disabled=r.complete;
  hideClipInfo();
  $('assets').replaceChildren(...r.items.map(item=>{const a=item.parent||item,b=document.createElement('button');b.className=`asset-card ${a.kind}${state.selectedIds.has(item.id)?' selected':''}`;b.dataset.id=item.id;b.setAttribute('role','listitem');b.setAttribute('aria-label',item.name);b.draggable=true;b.onpointerenter=e=>{if(e.pointerType!=='touch')showClipInfo(b,item);};b.onpointerleave=deferHideClipInfo;b.onfocus=()=>showClipInfo(b,item);b.onblur=hideClipInfo;
    const kind=item.recordType==='range'?'range':a.kind;
    const annotations=a.annotationCount??item.annotationCount??0;
    const flags=(annotations>0?clipIcon('annotations',`${annotations} annotation${annotations===1?'':'s'}`,annotations):'')+(item.tags.length||item.notes?clipIcon('notes','Has tags or notes'):'')+(a.availability==='unavailable'?clipIcon('unavailable','Original unavailable'):a.source.status==='pending'?clipIcon('pending','Verifying source'):'');
    b.innerHTML=`<div class="asset-image"><img src="/v1/media/${a.sourceId}/image" alt="" loading="lazy"><span class="clip-kind">${clipIcon(kind,kind==='range'?'Annotation':kind==='audio'?'Audio':'Video')}</span><span class="clip-flags">${flags}</span><span class="duration">${duration(item.end?secs(item.end)-secs(item.start):a.duration)}</span></div><div class="asset-name">${esc(item.name)}</div>`;
    b.querySelector('img').onerror=e=>{e.target.style.visibility='hidden';};b.onclick=e=>select(a.id,item.recordType==='range'?item:null,e.shiftKey).catch(e=>say(e.message,true));b.ondragstart=e=>{hideClipInfo();drag(e,a,item.recordType==='range'?item:null);};return b;}));
  if(!r.items.length)$('assets').innerHTML='<div class="empty-note">No matches in this view.<br>Import media or adjust the filters.</div>';
}
async function abandon(){if(!state.dirty)return true;return confirm('Discard unsaved annotation changes?');}
function drawClipSelection(){document.querySelectorAll('.asset-card').forEach(e=>e.classList.toggle('selected',state.selectedIds.has(e.dataset.id)));}
async function select(id,range=null,extend=false){
  const generation=++state.selectionGeneration;
  if(!await abandon()||generation!==state.selectionGeneration)return;
  const ids=state.items.map(item=>item.id),target=range?.id||id,anchor=ids.indexOf(state.selectionAnchor),last=ids.indexOf(target);
  const selectedIds=extend&&anchor>=0&&last>=0?new Set(ids.slice(Math.min(anchor,last),Math.max(anchor,last)+1)):new Set([target]);
  const item=await api('inspect',{id});
  const selected=item.recordType==='range'?await api('inspect',{id:item.assetId}):item;
  if(generation!==state.selectionGeneration)return;
  state.dirty=false;state.selected=selected;state.selectedIds=selectedIds;
  if(!extend||anchor<0)state.selectionAnchor=target;
  drawClipSelection();
  if(item.recordType==='range')range=item;
  await openPreview(selected);
  if(generation!==state.selectionGeneration)return;
  if(range){state.insertRange=range;markIn=secs(range.start);markOut=secs(range.end);await seek(markIn);showMarks();}
  window.drawAnnotationTimeline?.();drawClipSelection();
}
function folderOptions(selected='root'){return state.overview.folders.map(f=>`<option value="${f.id}" ${selected===f.id?'selected':''}>${esc(folderPath(f))}</option>`).join('');}
function folderPath(f){const parent=state.overview.folders.find(p=>p.id===f.parent);return parent?folderPath(parent)+' / '+f.name:f.name;}
function stop(){playing=false;cancelAnimationFrame(tick);native?.pause();audio?.pause();wave?.setPlaying(false);$('play').textContent='▶';}
async function openPreview(a){selectedActions();window.clearTakeSelection?.();stop();native?.close();native=null;wave?.destroy();wave=null;if(audio){audio.removeAttribute('src');audio.load();}audio=null;const generation=++state.previewGeneration;time=markIn=0;markOut=a.duration;state.insertRange=null;preview=await api('preview',{id:a.id});if(generation!==state.previewGeneration)return;
  $('clock').textContent=clock(0);$('length').textContent=clock(a.duration);$('seek').max=a.duration;$('seek').value=0;$('preview-empty').hidden=true;$('audio-wave').hidden=a.kind!=='audio';if(a.kind==='audio')openWave(a);$('preview-label').textContent=a.kind==='video'?`${a.source.metadata?.width||'…'} × ${a.source.metadata?.height||'…'}`:'SOURCE AUDIO';
  $('new-range').hidden=readonly;$('mark-in').hidden=$('mark-out').hidden=false;state.temporarySelection=false;$('new-range').disabled=a.folder==='inbox'||a.source.status!=='verified';
  $('preview-status').textContent=a.availability==='unavailable'?'Original unavailable':a.kind==='video'?(preview.seekProxy?'Fast seek ready · native source playback':'Native source playback · prepare for fast seeking'):'Source audio · sample-accurate ranges';
  if(a.kind==='video'){
    const project={cacheLimitBytes:128*1024**2,media:[{id:a.id,kind:'video',name:a.name,duration:a.duration}],tracks:[{id:'source'}],clips:[{id:'preview',mediaId:a.id,trackId:'source',start:0,duration:a.duration,sourceIn:0,speed:1}],transitions:[]};
    native=new window.NativePreview({project,width:a.source.metadata?.width||1920,height:a.source.metadata?.height||1080,plan:window.AFClipTimeline.compile(project),media:{[a.id]:{kind:'video',url:preview.url,pts:preview.pts,seekProxy:preview.seekProxy}},graphics:{}},$('native-host'),e=>say(e.message,true));
    await native.seek(0);
  }
  if(a.kind==='audio'||a.source.metadata?.hasAudio){audio=new Audio(preview.audioUrl);audio.preload='auto';audio.onerror=()=>say('Audio preview unavailable. Prepare this asset for review.',true);}
  showMarks();
}
// Shared waveform view; it decodes alongside playback and only reports seeks.
function openWave(a){let resume=false;const view=wave=new window.AFClipAudioWaveform({container:$('audio-wave'),duration:a.duration,format:clock,tips:'title',load:o=>api('waveform',{id:a.id,...o}),onSeek:(t,phase)=>{if(view!==wave)return;if(phase==='start'){resume=playing;stop();}const done=seek(t).catch(e=>say(e.message,true));if(phase==='end'&&resume){resume=false;done.then(()=>{if(view===wave&&!playing)return play();}).catch(e=>say(e.message,true));}}});view.setTime(time);}
async function seek(value){stop();time=Math.min(Math.max(0,value),Math.max(0,state.selected.duration-.001));$('seek').value=time;$('clock').textContent=clock(time);wave?.setTime(time);window.updateAnnotationPlayhead?.();if(audio)audio.currentTime=time;if(native)await native.seek(time);}
async function play(){if(!state.selected)return;if(playing){stop();return;}if(time>=state.selected.duration-.02)await seek(0);if(native)await native.seek(time,true);if(audio){audio.currentTime=time;await audio.play();}baseTime=time;baseClock=performance.now();playing=true;wave?.setPlaying(true);$('play').textContent='Ⅱ';const loop=()=>{if(!playing)return;time=audio&&!audio.paused?audio.currentTime:baseTime+(performance.now()-baseClock)/1000;if(time>=state.selected.duration){stop();return;}native?.update(time);wave?.setTime(time);$('seek').value=time;$('clock').textContent=clock(time);window.updateAnnotationPlayhead?.();tick=requestAnimationFrame(loop);};loop();}
$('seek').oninput=()=>seek(Number($('seek').value)).catch(e=>say(e.message,true));click('play',play);
function showMarks(){window.updateAnnotationPlayhead?.();wave?.setRegions(state.temporarySelection||state.insertRange?[{start:markIn,end:markOut,kind:'selection'}]:[]);$('range-selection').textContent=`In ${clock(markIn)} · Out ${clock(markOut)}`;}
click('mark-in',()=>{markIn=time;state.insertRange=null;state.temporarySelection=true;showMarks();});click('mark-out',()=>{markOut=time;state.insertRange=null;state.temporarySelection=true;showMarks();});

let submitDialog=null;
function dialog(title,html,onSubmit,button='Save'){$('dialog-title').textContent=title;$('dialog-content').innerHTML=html;$('dialog-submit').textContent=button;$('dialog-submit').hidden=!onSubmit;submitDialog=onSubmit;$('dialog').showModal();}
function closeDialog(){$('dialog').close();submitDialog=null;}
click('dialog-close',closeDialog);click('dialog-cancel',closeDialog);
$('dialog-form').onsubmit=async e=>{e.preventDefault();if(!submitDialog)return;const fn=submitDialog;$('dialog-submit').disabled=true;try{await fn();closeDialog();await refresh();}catch(e){say(e.message,true);}finally{$('dialog-submit').disabled=false;}};
click('import',()=>dialog('Import media',`<p>Reference video and audio where they are. Paste a file or folder path, one per line.</p><label>Source paths<textarea id="import-paths" placeholder="D:\\Recordings"></textarea></label>${window.libraryNative?'<button type="button" id="pick-files">Choose files…</button>':''}<label>Home folder<select id="import-folder">${folderOptions(state.folder&&state.folder!=='inbox'?state.folder:'root')}</select></label><label class="checkbox-label"><input id="import-hierarchy" type="checkbox">Match directory hierarchy</label><label>Limit files, optional<input id="import-limit" type="number" min="1" placeholder="All supported files"></label>`,async()=>{const paths=$('import-paths').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);const r=await api('import',{paths,folder:$('import-folder').value,hierarchy:$('import-hierarchy').checked,limit:Number($('import-limit').value)||undefined});say(r.items?`Imported ${r.items.length} assets. Content verification is running in the background.`:'Directory scan queued. Follow progress in Jobs.');},'Import'));
$('dialog-content').addEventListener('click',async e=>{if(e.target.id==='pick-files'){const files=await window.libraryNative.pick();if(files.length)$('import-paths').value=files.join('\n');}});
async function dropFiles(e,folder){if(readonly)return;const paths=[...e.dataTransfer.files].map(f=>window.libraryNative?.filePath(f)).filter(Boolean);if(!paths.length){say('Use Import media to reference local file paths in the browser. Desktop supports native file drops.');return;}await act(()=>api('import',{paths,folder}),'Imported dropped files');}
$('assets').ondragover=e=>e.preventDefault();$('assets').ondrop=e=>{e.preventDefault();dropFiles(e,state.folder&&state.folder!=='inbox'?state.folder:'root').catch(e=>say(e.message,true));};
function drag(e,a,range){const data={libraryId:a.libraryId,assetId:a.id,sourceId:a.sourceId,rangeId:range?.id,start:range?.start,end:range?.end,path:a.path};e.dataTransfer.setData('application/x-afclip-library',JSON.stringify(data));e.dataTransfer.setData('text/plain',a.path);e.dataTransfer.effectAllowed='copy';}
click('reveal-original',()=>window.libraryNative?.reveal(state.selected.id));
$('drag-original').ondragstart=e=>{
  e.preventDefault();if(!state.selected||$('drag-original').disabled)return;
  window.libraryNative?.drag(state.insertRange?.id||state.selected.id);
};
click('drag-original',()=>say('Drag this button onto another application to hand over the whole original file.'));
click('organize',()=>{
  const a=state.selected;if(!a||readonly)return;
  if(a.deleted){dialog('Restore catalog item',`<p>Restore ${esc(a.name)} to the library. Original media is unchanged.</p>`,()=>api('restore',{id:a.id,revision:a.revision}),'Restore');return;}
  const item=state.insertRange||a,collections=state.overview.collections;
  dialog(a.folder==='inbox'?'Keep in library':'Organize asset',
    `<p>${esc(a.name)}${a.folder==='inbox'?': keep this item permanently before adding annotations.':''}</p><label>Home folder<select id="asset-folder">${folderOptions(a.folder==='inbox'?'root':a.folder)}</select></label><p>Collection membership for ${esc(item.name)}</p>${collections.length?collections.map(c=>`<label class="checkbox-label"><input type="checkbox" data-membership="${c.id}" ${c.members.includes(item.id)?'checked':''}>${esc(c.name)}</label>`).join(''):'<p>Create a collection in the Content Browser to group assets or ranges across folders.</p>'}<button type="button" id="remove-catalog-item">Remove asset from library</button>`,async()=>{
      const operations=[],folder=$('asset-folder').value;
      if(a.folder==='inbox'||folder!==a.folder)operations.push({command:a.folder==='inbox'?'promote':'move',id:a.id,revision:a.revision,folder});
      for(const c of collections){const checked=$('dialog-content').querySelector(`[data-membership="${c.id}"]`).checked;if(checked!==c.members.includes(item.id))operations.push({command:'collection-update',id:c.id,revision:c.revision,members:checked?[...c.members,item.id]:c.members.filter(id=>id!==item.id)});}
      if(operations.length)await api('apply',{operations});
    },a.folder==='inbox'?'Keep in library':'Save');
  click('remove-catalog-item',async()=>{await api('remove',{id:a.id,revision:a.revision});closeDialog();await refresh();say('Removed from catalog. Restore from Trash or Undo. Original file is unchanged.');});
});
click('new-folder',()=>dialog('New folder',`<label>Name<input id="folder-name" required></label><label>Parent<select id="folder-parent">${folderOptions(state.folder||'root')}</select></label>`,()=>api('folder-create',{name:$('folder-name').value,parent:$('folder-parent').value})));
function folderManager(f){if(readonly||f.id==='root')return;dialog('Edit folder',`<label>Name<input id="folder-name" value="${esc(f.name)}" required></label><label>Parent<select id="folder-parent">${folderOptions(f.parent)}</select></label><button type="button" id="folder-delete">Delete empty folder</button>`,()=>api('folder-update',{id:f.id,revision:f.revision,name:$('folder-name').value,parent:$('folder-parent').value}));click('folder-delete',async()=>{await api('folder-delete',{id:f.id,revision:f.revision});closeDialog();await view();});}
click('new-collection',()=>dialog('New collection','<label>Name<input id="collection-name" required></label>',()=>api('collection-create',{name:$('collection-name').value})));
function collectionManager(c){if(readonly)return;dialog('Edit collection',`<label>Name<input id="collection-name" value="${esc(c.name)}"></label><p>${c.members.length} members. Deleting a collection keeps its assets.</p><button type="button" id="collection-delete">Delete collection</button>`,()=>api('collection-update',{id:c.id,revision:c.revision,name:$('collection-name').value}));click('collection-delete',async()=>{await api('collection-delete',{id:c.id,revision:c.revision});closeDialog();await view();});}
click('tags-manager',tagManager);
function tagManager(){dialog('Tag Manager',`<p>One shared vocabulary for assets and named ranges.</p><label>New tag<input id="tag-name" placeholder="e.g. whoosh"></label><button type="button" id="tag-add">Create tag</button><div>${state.overview.tags.map(t=>`<div class="manager-row"><span class="flex">${esc(t.name)}</span><button type="button" data-rename="${t.id}">Rename</button><button type="button" data-merge="${t.id}">Merge</button><button type="button" data-delete="${t.id}">Delete</button></div>`).join('')}</div>`,null);click('tag-add',async()=>{await api('tag-create',{name:$('tag-name').value});await refresh();tagManager();});$('dialog-content').querySelectorAll('[data-rename],[data-merge],[data-delete]').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.rename||b.dataset.merge||b.dataset.delete,t=state.overview.tags.find(t=>t.id===id);if(b.dataset.rename){const name=prompt('Tag name',t.name);if(name)await api('tag-rename',{id,revision:t.revision,name});}else if(b.dataset.delete){if(confirm(`Delete ${t.name} and clear its assignments everywhere? This can be undone.`))await api('tag-delete',{id,revision:t.revision,confirm:'clear-assignments'});}else{const name=prompt('Merge into which existing tag? Enter its name.');if(name){const target=state.overview.tags.find(x=>x.name===name);if(!target)throw new Error('Unknown target tag');await api('tag-merge',{id,revision:t.revision,target:target.id,targetRevision:target.revision});}}await refresh();tagManager();}catch(e){say(e.message,true);}});}
click('prepare',async()=>{const ids=state.items.filter(x=>x.recordType==='asset').map(x=>x.id);if(!ids.length)throw new Error('No assets in this view');await act(()=>api('prepare',{ids}),'Preparing this page for review');});
click('jobs',jobsDialog);
async function jobsDialog(){const list=await api('jobs');dialog('Background jobs',list.length?list.map(j=>`<div class="manager-row"><div class="flex">${esc(j.kind)} · ${esc(j.phase||j.status)}<small>${esc(j.assetId)}<br>${esc(j.error||j.status)}</small><progress max="1" value="${j.progress}"></progress></div>${['queued','running'].includes(j.status)?`<button type="button" data-cancel="${j.id}">Cancel</button>`:''}</div>`).join(''):'<p>No jobs yet.</p>',null);$('dialog-content').querySelectorAll('[data-cancel]').forEach(b=>b.onclick=async()=>{await api('cancel',{id:b.dataset.cancel});jobsDialog();});}
click('history',historyDialog);
async function historyDialog(){const history=await api('history'),points=await api('checkpoints');dialog('Library history',`<p>Shared by the GUI and CLI. Original media is outside undo.</p><label>Checkpoint name<input id="checkpoint-name"></label><button type="button" id="checkpoint-save">Create checkpoint</button>${points.map(p=>`<div class="manager-row"><span class="flex">${esc(p.name)}<small>${esc(p.time)}</small></span><button type="button" data-restore="${p.id}">Restore</button></div>`).join('')}<div class="section-label">RECENT OPERATIONS</div>${history.map(h=>`<div class="manager-row"><span class="flex">${esc(h.label)}${h.undone?' · undone':''}<small>${h.author} · ${new Date(h.time).toLocaleString()} · #${h.seq}</small></span></div>`).join('')}`,null);click('checkpoint-save',async()=>{await api('checkpoint',{name:$('checkpoint-name').value});historyDialog();});$('dialog-content').querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{if(confirm('Restore checkpoint and discard later library changes?')){await api('checkpoint-restore',{id:b.dataset.restore,confirm:'discard-later-edits'});closeDialog();state.dirty=false;await refresh();}});}
click('cache-manager',async()=>{const c=await api('cache');dialog('Cache & preparation',`<p>${(c.bytes/1024**2).toFixed(1)} MB of disposable artifacts. Active preview readers are protected. Annotations and identities are stored separately.</p><label>Disk budget, MB<input id="cache-budget" type="number" min="0" value="${Math.round(c.budget/1024**2)}"></label><button type="button" id="cache-clear">Clear eligible artifacts</button><button type="button" id="rescan">Rescan source availability</button>`,()=>api('cache-budget',{bytes:Math.round(Number($('cache-budget').value)*1024**2)}));click('cache-clear',async()=>{const r=await api('cache-clear');say(`Cleared ${(r.removedBytes/1024**2).toFixed(1)} MB${r.protected?' · active readers protected':''}`);});click('rescan',()=>act(()=>api('rescan'),'Source availability rescanned'));});
for(const direction of ['undo','redo'])click(direction,async()=>{if(!await abandon())return;state.dirty=false;await act(()=>api(direction),direction==='undo'?'Undid library operation':'Redid library operation');});
for(const id of ['search','kind','tag-filter','min-duration','max-duration'])$(id).addEventListener(id==='search'?'input':'change',()=>{state.offset=0;clearTimeout(eventTimer);eventTimer=setTimeout(()=>search().catch(e=>say(e.message,true)),0);});
click('previous',async()=>{state.offset=Math.max(0,state.offset-60);await search();});click('next',async()=>{state.offset=state.nextOffset||0;await search();});
click('insert',async()=>{if(!window.libraryNative)throw new Error('Open the library browser from AFClip');const a=state.selected;let selection;if(state.temporarySelection){selection={revision:a.revision,sourceId:a.sourceId};if(a.kind==='audio'){const rate=Number(a.source.metadata.streams.find(s=>s.codec_type==='audio').sample_rate);Object.assign(selection,{startSample:Math.round(markIn*rate),endSample:Math.round(markOut*rate)});}else{const frames=await api('frames',{id:a.id}),pts=frames.ticks.map(t=>t*frames.timeBase.num/frames.timeBase.den),nearest=t=>{const i=pts.findIndex(p=>p>=t-0.000001);return i<0?pts.length:i;};Object.assign(selection,{startFrame:nearest(markIn),endFrame:nearest(markOut)});}}await window.libraryNative.insert({id:state.insertRange?.id||a.id,selection});say('Added to AFClip project bin');});
click('edit-library',()=>window.libraryNative?.edit(state.selected.id));
document.addEventListener('keydown',e=>{const typing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if($('dialog').open){if(submitDialog&&!readonly)$('dialog-form').requestSubmit();return;}return;}if(typing||$('dialog').open)return;if(e.code==='Space'){e.preventDefault();play().catch(e=>say(e.message,true));}if(e.key.toLowerCase()==='i'){markIn=time;state.insertRange=null;state.temporarySelection=true;showMarks();}if(e.key.toLowerCase()==='o'){markOut=time;state.insertRange=null;state.temporarySelection=true;showMarks();}if(wave&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const zoom={'=':1.6,'+':1.6,'-':1/1.6,'\\':0}[e.key];if(zoom!=null){e.preventDefault();zoom?wave.zoomBy(zoom):wave.fit();}}if(!readonly&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'redo':'undo').click();}});
window.addEventListener('beforeunload',e=>{if(state.dirty||window.hasAnnotationDrafts?.()){e.preventDefault();e.returnValue='';}});
const events=new EventSource('/v1/events');let refreshTimer;events.onmessage=()=>{if(!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;refresh().catch(e=>say(e.message,true));},150);};events.onerror=()=>{$('connection').textContent='Reconnecting…';};events.onopen=()=>{$('connection').textContent='Local catalog · connected';};
$('insert').hidden=!readonly&&params.get('mode')!=='project';$('edit-library').hidden=!readonly;
if(readonly)for(const id of ['import','new-folder','new-collection','tags-manager','undo','redo','author','history','cache-manager','jobs'])$(id).hidden=true;
window.libraryPreviewMetrics=()=>({time,playing,native:native?{...native.stats}:null,video:[...(native?.entries.values()||[])].map(e=>{const q=e.content?.getVideoPlaybackQuality?.();return {time:e.content?.currentTime,quality:q?{total:q.totalVideoFrames,dropped:q.droppedVideoFrames}:null,presentedTime:e.presentedTime};}),prepared:!!preview?.seekProxy});
const reloadKey='afclip-library-dev-view';
window.afclipPrepareReload=()=>{
  if(!reloadReady||state.dirty||window.hasAnnotationDrafts?.()||requestsInFlight||playing||$('dialog').open||
    document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')||document.querySelector(':active'))return false;
  sessionStorage.setItem(reloadKey,JSON.stringify({folder:state.folder,kind:state.kind,collection:state.collection,deleted:state.deleted,offset:state.offset,
    selected:state.insertRange?.id||state.selected?.id,selectedIds:[...state.selectedIds],selectionAnchor:state.selectionAnchor,time,markIn,markOut,temporarySelection:state.temporarySelection,
    fields:Object.fromEntries(['search','kind','tag-filter','min-duration','max-duration','author'].map(id=>[id,$(id).value])),scroll:$('assets').scrollTop}));
  return true;
};
(async()=>{
  let saved=null;if(params.get('dev')){try{saved=JSON.parse(sessionStorage.getItem(reloadKey));}catch{}sessionStorage.removeItem(reloadKey);document.title='AFClip Content Library · Dev';}
  if(saved){for(const key of ['folder','kind','collection','deleted','offset'])state[key]=saved[key];for(const [id,value]of Object.entries(saved.fields))if(id!=='tag-filter')$(id).value=value;}
  await refresh();
  if(saved){$('tag-filter').value=saved.fields['tag-filter'];await search();}
  const id=saved?.selected||params.get('asset');if(id){await select(id);if(saved){await seek(saved.time);markIn=Math.min(saved.markIn,state.selected.duration);markOut=Math.min(saved.markOut,state.selected.duration);state.temporarySelection=saved.temporarySelection;showMarks();}}
  if(saved){const visible=new Set(state.items.map(item=>item.id));state.selectedIds=new Set((saved.selectedIds||[saved.selected]).filter(id=>visible.has(id)));state.selectionAnchor=visible.has(saved.selectionAnchor)?saved.selectionAnchor:null;drawClipSelection();$('assets').scrollTop=saved.scroll;}
  reloadReady=true;say(params.get('dev')?'Library ready · live GUI reload enabled':'Library ready');
})().catch(e=>{reloadReady=true;say(e.message,true);});

// Renew the selected preview's lease while the window is open, including paused review.
setInterval(()=>{if(state.selected)api('preview',{id:state.selected.id}).catch(()=>{});},20000);
