'use strict';
// These controls use the same versioned operations as the CLI.
if(!readonly){
  const sourceButton=document.createElement('button');sourceButton.id='source-folders';sourceButton.className='nav-item';sourceButton.textContent='▱  Source folders';
  $('tags-manager').before(sourceButton);sourceButton.onclick=()=>sourceFolders().catch(e=>say(e.message,true));
}
async function sourceFolders(){
  const roots=await api('source-folders');
  dialog('Source folders',`<p>Discover files without moving them. A mapping gives new Reelet imports a permanent home. Watching runs while the library service is open.</p><label>Mapping<select id="source-choice"><option value="">New source folder</option>${roots.map(r=>`<option value="${r.id}">${esc(r.path)}</option>`).join('')}</select></label><label>Folder on disk<input id="source-path" placeholder="D:\\Audio Effects"></label><label>Library folder<select id="source-home">${folderOptions()}</select></label><label class="checkbox-label"><input type="checkbox" id="source-hierarchy">Match subfolders in the library</label><label class="checkbox-label"><input type="checkbox" id="source-watch">Discover new files automatically</label><p>Unavailable drives leave existing annotations intact.</p><button type="button" id="source-scan">Rescan selected source</button><button type="button" id="source-remove">Remove mapping</button>`,async()=>{
    const old=roots.find(r=>r.id===$('source-choice').value);
    await api('source-folder-save',{id:old?.id,revision:old?.revision,path:$('source-path').value,folder:$('source-home').value,hierarchy:$('source-hierarchy').checked,watched:$('source-watch').checked});say('Source-folder mapping saved');
  });
  $('source-choice').onchange=()=>{const r=roots.find(r=>r.id===$('source-choice').value);$('source-path').value=r?.path||'';$('source-home').value=r?.folder||'root';$('source-hierarchy').checked=!!r?.hierarchy;$('source-watch').checked=!!r?.watched;};
  click('source-scan',async()=>{const id=$('source-choice').value;if(!id)throw new Error('Save a mapping before rescanning it');await api('rescan',{id});say('Source scan queued. Progress is available in Jobs.');closeDialog();});
  click('source-remove',async()=>{const old=roots.find(r=>r.id===$('source-choice').value);if(!old)throw new Error('Choose an existing mapping');await api('source-folder-remove',{id:old.id,revision:old.revision});say('Mapping removed; existing assets preserved');closeDialog();});
}
const reviewButton=document.createElement('button');reviewButton.id='review-artifacts';reviewButton.textContent='Review artifacts';reviewButton.type='button';$('reveal').before(reviewButton);
reviewButton.onclick=()=>reviewArtifacts().catch(e=>say(e.message,true));
async function reviewArtifacts(){
  const a=state.selected;if(!a)return;
  dialog('Review artifacts',`<p>Reusable source evidence. These files are disposable cache entries, not catalog assets or exports.</p><label>Artifact<select id="artifact-type">${a.kind==='video'?'<option value="frame">Inspection frame</option><option value="contact-sheet">Contact sheet</option>':''}<option value="excerpt">Bounded excerpt</option></select></label><div class="filters"><label>Start / frame time, seconds<input id="artifact-start" type="number" min="0" step="0.001" value="${time.toFixed(3)}"></label><label>End, seconds<input id="artifact-end" type="number" min="0" step="0.001" value="${Math.min(a.duration,time+10).toFixed(3)}"></label></div><label>Width<input id="artifact-width" type="number" min="64" max="1920" step="2" value="640"></label><div id="artifact-result"></div>`,async()=>{
    const button=$('dialog-submit');button.disabled=true;
    const r=await api('artifact',{id:a.id,type:$('artifact-type').value,time:Number($('artifact-start').value),start:Number($('artifact-start').value),end:Number($('artifact-end').value),width:Number($('artifact-width').value)});
    // The dialog remains open while its job runs; cancellation uses the normal job API.
    const show=()=>{$('artifact-result').innerHTML=r.artifact.type==='excerpt'?`<video controls src="${r.artifact.url}" style="max-width:100%"></video>`:`<img src="${r.artifact.url}" alt="Generated review artifact" style="max-width:100%">`;const p=document.createElement('p');p.textContent=r.artifact.path;$('artifact-result').append(p);};
    if(r.cacheHit)show();else{
      $('artifact-result').innerHTML='<p>Generating artifact…</p><button type="button" id="artifact-cancel">Cancel generation</button>';
      $('artifact-cancel').onclick=()=>api('cancel',{id:r.jobs[0].id});
      while($('dialog').open){const j=await api('jobs',{id:r.jobs[0].id});if(j.status==='completed'){show();break;}if(['failed','cancelled'].includes(j.status))throw new Error(j.error||'Generation cancelled');await new Promise(r=>setTimeout(r,250));}
    }
    button.disabled=false;
  },'Generate');
  // Override the generic close-on-save handler for this inspection dialog.
  const generation=submitDialog;submitDialog=null;$('dialog-submit').onclick=async e=>{e.preventDefault();try{await generation();}catch(error){$('dialog-submit').disabled=false;say(error.message,true);}};
  $('dialog').addEventListener('close',()=>{$('dialog-submit').onclick=null;},{once:true});
}
