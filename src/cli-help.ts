const REFERENCE=`AFClip first editing slice. Every command prints JSON except help.

  af-clip create <project-dir> [--name NAME] [--width 1920 --height 1080 --fps 30]
  af-clip collect <project-dir> <new-folder> [--revision N]
  af-clip inspect <project-dir> [--id ID | --collection NAME | --since REVISION]
  af-clip endpoint <project-dir>
  af-clip agent <project-dir> [list|context|providers|settings|create|send|read|respond|stop|settle] [ID] [--text TEXT | --file JSON] [--offset N --limit N]
  af-clip generation-start <project-dir> [clip-id] --type music|sfx|speech --text TEXT [--file TEXT_FILE] [--track ID --start SEC --duration SEC] [--voice ID] [--add-video --refresh-video] [--wait]
  af-clip generation-status <project-dir> [clip-id] [--offset N --limit N]
  af-clip generation-voices <project-dir> [--next-page-token TOKEN]
  af-clip generation-select <project-dir> <clip-id> <take-id>
  af-clip generation-accept <project-dir> <clip-id> [--extend]
  af-clip import <project-dir> <source-file> [--kind video|audio|image|graphic]
  af-clip relink <project-dir> <media-id> <replacement-file> [--revision N]
  af-clip library-import <project-dir> <asset-or-range-id>
  af-clip library-sync|library-status <project-dir>
  af-clip source-inspect <project-dir> <media-id> [--start-frame N --frame-count N]
  af-clip source-frames <project-dir> <media-id> [--start-frame N --frame-count N]
  af-clip source-prepare <project-dir> <media-id> [--wait]
  af-clip source-jobs <project-dir> <media-id>
  af-clip source-cancel <project-dir> <media-id> <job-id>
  af-clip source-waveform <project-dir> <media-id> [--start SEC --duration SEC --bins N]
  af-clip source-insert <project-dir> <media-id> --at SEC [--track ID --selection JSON --preconditions FILE]
  af-clip apply <project-dir> <batch.json>
  af-clip asset-builtin <project-dir> <dissolve|wipe|blur-transition|spin|blur>
  af-clip asset-duplicate <project-dir> <asset-id>
  af-clip params <project-dir> <clip-or-transition-id> [--effect ID] [--at SEC|N%,...]
  af-clip param-set <project-dir> <clip-or-transition-id> [--effect ID] [name=value ...] [--ops JSON | --file ops.json] [--revision N --media-revision N]
  af-clip text-fields <project-dir> <clip-id>
  af-clip text-set <project-dir> <clip-id> <field-id> --text VALUE [--revision N --media-revision N]
  af-clip text-set <project-dir> <clip-id> <field-id> --file text.txt
  af-clip text-reset <project-dir> <clip-id> <field-id>
  af-clip folders <project-dir>
  af-clip sequences <project-dir>
  af-clip sequence-copy <project-dir> [--name NAME] [--revision N]
  af-clip sequence-select <project-dir> <sequence-id> [--revision N]
  af-clip sequence-rename <project-dir> <sequence-id> --name NAME [--revision N]
  af-clip folder-create <project-dir> --name NAME --tracks ID,ID [--id ID]
  af-clip folder-set <project-dir> <folder-id> [--name NAME --disabled true|false --locked true|false --collapsed true|false]
  af-clip folder-members <project-dir> <folder-id> --tracks ID,ID
  af-clip folder-move <project-dir> <folder-id> [--before TRACK_ID]
  af-clip folder-remove <project-dir> <folder-id>
  af-clip markers <project-dir>
  af-clip marker-add <project-dir> --time SEC --name NAME [--id ID]
  af-clip marker-set <project-dir> <marker-id> [--time SEC] [--name NAME]
  af-clip marker-remove <project-dir> <marker-id>
  af-clip marker-next|marker-previous <project-dir> --time SEC
  af-clip ripple-delete <project-dir> --start SEC --end SEC [--revision N]
  af-clip fade <project-dir> <clip-id> [--in SEC] [--out SEC] [--remove]
  af-clip detach-audio|unlink <project-dir> <clip-id> [--revision N]
  af-clip undo|redo <project-dir>
  af-clip export <project-dir> <output.mp4> [--mode gpu|software] [--start SEC --end SEC] [--verify quick|full] [--wait]
  af-clip frame <project-dir> <output.png> --time SEC [--image-size low|review|high|full] [--mode gpu|software] [--wait]
  af-clip status <project-dir> [job-id]
  af-clip cancel <project-dir> [job-id]
  af-clip close <project-dir>
  af-clip checkpoint <project-dir> --task DESCRIPTION
  af-clip checkpoints <project-dir>
  af-clip restore <project-dir> [checkpoint-id|latest] --confirm discard-later-edits

Edits return changes, removed IDs, reordered collections and changed revisions. inspect returns full state.
--full includes complete edit snapshots and default-valued fields; --pretty indents JSON.
Times accept decimal seconds or exact fractions, e.g. 1001/30000.
Find reusable clips: af-lib search --q TEXT --kind video
Import a result with one command: af-clip library-import <project-dir> <result.items[].id>
Asset IDs import the whole source; range IDs import the saved source selection into the project bin.
The response includes result.media.id for subsequent timeline edits. Import preserves library provenance.
source-inspect returns source monitor data, annotations, frame count, timing, sample rate and selectionContext.
source-insert adds the saved selection on a new track, or --track ID without overwriting overlaps.
For temporary In/Out, pass --selection with selectionContext.revision/sourceId and integer
startSample/endSample for audio or startFrame/endFrame for prepared video. End is exclusive.
Exact boundaries remain in media provenance. Placement and cuts fit the project frame grid.
Agent passes can supply --preconditions FILE containing inspect.result.revisions and --fps from that inspection.
Without explicit preconditions, source-insert reads project revisions immediately before insertion.
Graphics import copies a folder containing index.html into project assets.
Batch: {preconditions:{"clip:ID":1,"track:ID":1,"occupancy:ID":1,"media:ID":1},
 operations:[{op:"put",collection:"clips",value:{id:"ID",volume:0.5}}]}.
Clip volumePoints accepts [{time:{num,den},value:0.25}] in absolute source seconds.
Points use Ease In/Out between gains and multiply clip volume and fades. One point gets implicit
gain-1 anchors at clip edges; two or more hold endpoint values outside their span.
Use [] to clear automation. Inspect returns revision keys. New IDs and missing relationship keys have revision 0.
Put updates supplied fields. Remove uses {op:"remove",collection:"clips",id:"ID"}.
Fade: visual clips fade to transparent, revealing lower tracks or black; audio fades from/to silence.
Combined video/audio clips fade both; detach-audio first for independent picture and sound fades.
fade snaps to the nearest frame and leaves an omitted side unchanged; 0 or --remove clears it.
Clip effects: put clips.effects [{id,assetId,params:{},seed}] in apply order, assetId from role "effect" media.
Ripple delete removes [start,end) across all tracks in one undoable edit.
Its apply equivalent is {op:"ripple-delete",start:{num,den},end:{num,den}}
as the only operation, with preconditions.project set to the inspected revision.
Parameters: HTML content clips, their effects (--effect ID) and transitions. data-text fields are text parameters.
params lists id, type and value. curve points are [at,v,ease?]; at is seconds from the visible clip or transition start.
default appears once overridden. inactiveCurve is a retained curve while the value is constant.
--at evaluates number/color parameters, e.g. --at 0,1.5,50%.
param-set name=value converts by type. --ops takes one operation or an array; all form one undoable edit:
 {param,value} constant, drops curve | {param,reset:true} default | {param,curve:[[at,v,ease?],...]} replace
 {param,add:[at,v,ease?] or a list} add/replace by time | {param,move:AT|{index},to:{at?,v?,ease?}} | {param,delete:AT|{index}|list}
 {param,animate:false,at?} constant from the curve at that time, curve kept inactive | {param,animate:true,at?} restore or start a curve.
at: seconds, a/b, or N% of visible duration. Clip/effect points follow source content: trims hide them, splits keep them,
stretching/speed scales them. Transition points scale with its duration. Values hold outside the first/last point.
ease: linear (default), hold, ease, ease-in, ease-out, ease-in-out, back-in, back-out, back-in-out, or [x1,y1,x2,y2].
Numbers clamp to min/max and round when integer. Colors are #rrggbb or #rrggbbaa and blend in OKLab with separate alpha.
param-set returns revisions and params for edited parameters; --full adds the changed object. Number and color animate.
Folders contain adjacent tracks. folder-members replaces membership; folder-remove ungroups without deleting tracks.
folder-move moves the whole block before a track, or to the end. Track order is bottom-to-top compositing order.
Folder Disable/Lock inherit without replacing individual track flags. Collapse is display-only.
Apply supports put/remove on folders, track.folderId, and {op:"reorder-tracks",trackIds:[all IDs]}.
Reorder requires project and order:tracks revisions; child edits also require their folder revision.
Project changes use {op:"project",value:{name?,fps?,resolution?}} and project revision.
Sequences share media and project settings. Edits and exports use activeSequenceId.
sequence-copy duplicates the active timeline with fresh IDs and selects the copy. Accept generated clips first.
sequence-select and sequence-rename require a sequence ID. Names are unique within a project.
Sequence operations are undoable. apply accepts {op:"sequence-copy",name?},
{op:"sequence-select",id} or {op:"sequence-rename",id,name}, alone with preconditions.project.
Default output omits inactive timeline bodies. inspect --id SEQUENCE_ID --full includes an inactive timeline;
the active timeline remains in the top-level project arrays. sequences lists IDs, names and revisions.
The engine keeps session undo for five idle minutes; close ends that session.
Frame PNGs default to a 768px longest edge; --image-size low caps at 512px, high caps at 1024px, full keeps project resolution. No upscaling.
Export verification defaults to quick container/timestamp checks. --verify full also decodes every output frame.
Render progress is available through status and /v1/events. --wait exits nonzero on failure.
`;

const usage=REFERENCE.split('\n').filter(line=>line.startsWith('  af-clip '));
const section=(from:string,to:string)=>REFERENCE.slice(REFERENCE.indexOf(from),REFERENCE.indexOf(to));
export function clipHelp(topic?:string){
 if(!topic)return `af-clip <command> <project-dir> [options]

${usage.map(line=>line.trim().split(' ')[1]).filter((v,i,a)=>a.indexOf(v)===i).join(' | ')}

help COMMAND: usage and editing contract. help all: full reference.
JSON output; --full includes raw data, --pretty indents. Edits return changes.
`;
 if(topic==='all')return REFERENCE;
 const lines=usage.filter(line=>line.trim().split(' ')[1].split('|').includes(topic));
 if(!lines.length)throw new Error(`Unknown command: ${topic}`);
 let notes='';
 if(topic.startsWith('generation-'))notes='Generation uses the ElevenLabs key saved in API settings, including headless CLI calls. New slots require --track, --start and --duration. Existing clip-id generates another take; unspecified settings are reused. One paid request per submission; no automatic retries. Music: 3-600 seconds, SFX: 0.5-30 seconds. Speech requires --voice and literal dialogue. --add-video is Music only; --add-video false clears it. First completed take enters the mix automatically; select switches the mix. Accept creates normal audio and removes alternatives, with session Undo. --extend permits overlong Speech only into empty space. --wait returns final status and exits nonzero on failure. Status defaults to 30 slots, max 100; voices returns up to 100 with nextPageToken.\n';
 if(topic==='agent')notes='Local agent conversations use installed Codex/Claude logins. context returns the last GUI snapshot (receivedAt) and active discussions, not a guaranteed live selection. list returns up to 50 discussion summaries (max 100); nextOffset continues. --full includes transcripts/settings. read ID returns 20 messages (max 100); nextOffset continues. Tool output is summarized to its command; --full retains complete diagnostics. create/send/settings/respond accept --file JSON. create: {provider:codex|claude,anchor:{kind,items:[{kind,id}],trackId?,time?:{num,den}},context:{}}. send: {id,text,context?,images?:[{dataUrl,name}]}. respond: {id,requestId,answer}. settings: {providers:{codex|claude:{executable?,model?,effort?,access?,delivery:steer|queue}}}. Model/thinking/access are copied into new chats; delivery is read for each message. stop interrupts; settle requires idle/stopped and deletes AFClip image copies. All editing still uses the ordinary CLI.\n';
 if(topic==='apply')notes=section('Batch:', 'Folders contain')+section('Apply supports','The engine keeps');
 if(topic.startsWith('source-'))notes=section('source-inspect returns','Graphics import');
 if(topic.startsWith('folder'))notes=section('Folders contain','Project changes');
 if(topic.startsWith('sequence'))notes=section('Sequences share','The engine keeps');
 if(topic.startsWith('library-'))notes=section('Find reusable clips','source-inspect returns');
 if(['export','frame','status'].includes(topic))notes=section('Export verification','Render progress')+'--wait exits nonzero on failure.\n';
 if(topic==='frame')notes+='Images default to review: 768px longest edge. --image-size low caps at 512px; high caps at 1024px; full keeps project resolution for small text and fine detail. Aspect ratio is preserved, with no upscaling. --full only expands JSON.\n';
 if(topic==='fade')notes=section('Fade:','Clip effects:');
 if(['params','param-set'].includes(topic))notes=section('Parameters:','Folders contain');
 if(topic==='inspect')notes='--id ID or --collection media|tracks|clips|transitions|markers|folders|sequences selects objects. --since REVISION returns changes from retained session history; unavailable history returns HISTORY_UNAVAILABLE. Use --since separately from filters. Inactive sequence timelines require --full; active timeline arrays remain at project level.\n';
 if(['source-inspect','source-frames'].includes(topic))notes+='Frame windows use --start-frame N --frame-count N (default 120, max 10000). nextFrame continues the exact stored index. --full includes all timestamps.\n';
 return lines.join('\n')+'\n'+notes+'Times accept decimal seconds or fractions. --full includes raw data; --pretty indents.\n';
}
