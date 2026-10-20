// Electron supplies the same OS-encrypted credential store as Settings, without a window.
// Requests contain no secrets. Only result metadata is written to stdout.
const {app} = require('electron');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
app.whenReady().then(async () => {
  const keys = require('../gui/api-keys.cjs');
  if (config.action === 'configured') return keys('get');
  const key = keys.savedKey();
  let route, body, headers = {'xi-api-key': key};
  if (config.action === 'voices') {
    route = '/v2/voices?page_size=100' + (config.nextPageToken ? '&next_page_token='+encodeURIComponent(config.nextPageToken) : '');
  } else {
    const s = config.settings;
    if (s.addVideo) {
      route = '/v1/music/video-to-music';
      body = new FormData();
      body.append('videos', new Blob([fs.readFileSync(config.video)], {type:'video/mp4'}), 'context.mp4');
      body.append('description', s.text);
      body.append('use_audio_as_reference', 'false');
      body.append('add_sfx', 'false');
      body.append('separate_tracks', 'false');
    } else {
      headers['Content-Type'] = 'application/json';
      route = s.type === 'music' ? '/v1/music' : s.type === 'sfx' ? '/v1/sound-generation' : '/v1/text-to-speech/'+encodeURIComponent(s.voiceId);
      body = JSON.stringify(s.type === 'music' ? {prompt:s.text,music_length_ms:Math.round(config.seconds*1000)} :
        s.type === 'sfx' ? {text:s.text,duration_seconds:config.seconds} : {text:s.text,model_id:'eleven_multilingual_v2'});
    }
    route += '?output_format=mp3_44100_128';
  }
  const response = await fetch('https://api.elevenlabs.io'+route, {method:body?'POST':'GET',headers,body,redirect:'error',signal:AbortSignal.timeout(15*60*1000)});
  if (!response.ok) {
    const error = await response.json().catch(()=>null), detail=error?.detail;
    throw Object.assign(new Error(typeof detail==='string'?detail:detail?.message||(detail?JSON.stringify(detail).slice(0,2000):`ElevenLabs returned HTTP ${response.status}`)),{code:detail?.status||'ELEVENLABS_HTTP',httpStatus:response.status});
  }
  if (config.action==='voices') {
    const data=await response.json();
    return {voices:data.voices.map(v=>({id:v.voice_id,name:v.name,...(v.preview_url?{previewUrl:v.preview_url}:{})})),...(data.has_more?{nextPageToken:data.next_page_token}:{})};
  }
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!bytes.length)throw new Error('ElevenLabs returned empty audio');
  fs.writeFileSync(config.output,bytes);
  return {output:config.output,requestId:response.headers.get('request-id')||undefined};
}).then(result=>{console.log(JSON.stringify({ok:true,result}));app.exit(0);}).catch(error=>{
  console.log(JSON.stringify({ok:false,error:{code:error.code||'GENERATION_FAILED',message:error.message,httpStatus:error.httpStatus}}));app.exit(1);
});
