// Timing is approximate to one waveform bin, in absolute source seconds.
export function waveformSummary(w:any,sourceSampleRate:number|null) {
  const peaks=Array.from({length:w.bins},(_,i)=>Math.max(...w.lanes.flatMap((l:any)=>[Math.abs(l.min[i]),Math.abs(l.max[i])])));
  const peak=Math.max(...peaks),peakBin=peaks.indexOf(peak),step=w.duration/w.bins,threshold=0.01;
  const first=peaks.findIndex(p=>p>=threshold),last=peaks.findLastIndex(p=>p>=threshold);
  return {start:w.start,duration:w.duration,bins:w.bins,channels:w.channels,
    sourceSampleRate,decodedSampleRate:w.sampleRate,
    summary:{peak,peakTimeSeconds:peak>0?w.start+(peakBin+0.5)*step:null,timeResolutionSeconds:step,
      activityThresholdDbFS:-40,activity:first<0?null:{startSeconds:w.start+first*step,endSeconds:w.start+(last+1)*step}}};
}
