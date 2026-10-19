// Slice the stored index, never synthesize timestamps from nominal frame rate.
export function frameWindow(result:any,startValue:any,countValue:any){
 const key=Array.isArray(result.ticks)?'ticks':'pts',values=result[key];
 if(!Array.isArray(values)||!values.length)throw new Error('No frame index available. Prepare the source first.');
 const start=Number(startValue??0),count=Number(countValue??120);
 if(!Number.isSafeInteger(start)||start<0||start>=values.length)throw new Error('--start-frame is outside the frame index');
 if(!Number.isSafeInteger(count)||count<1||count>10000)throw new Error('--frame-count must be 1–10000');
 const end=Math.min(values.length,start+count);
 return {...result,[key]:values.slice(start,end),frameCount:values.length,startFrame:start,nextFrame:end<values.length?end:null};
}
