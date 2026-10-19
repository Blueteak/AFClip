// Guard the local HTTP transport's byte handling, typed errors and no-retry rule.
import http from 'node:http';
import assert from 'node:assert/strict';
import {request} from '../../src/engine/client.ts';
let calls=0;
const server=http.createServer(async(req,res)=>{
 calls++;assert.equal(req.headers.authorization,'Bearer test-token');
 if(req.url==='/broken'){req.socket.destroy();return;}
 if(req.url==='/invalid'){res.end('invalid JSON');return;}
 if(req.url==='/conflict'){res.writeHead(409);res.end(JSON.stringify({ok:false,error:{code:'CONFLICT',message:'stale',details:{revision:4}}}));return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const data=Buffer.concat(chunks);assert.equal(Number(req.headers['content-length']),data.length);
 const body=Buffer.from(JSON.stringify({ok:true,result:JSON.parse(data)}));
 // Split a multibyte character across chunks.
 const at=body.indexOf(Buffer.from('🎬'))+1;res.write(body.subarray(0,at));setImmediate(()=>res.end(body.subarray(at)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const ep={url:`http://127.0.0.1:${server.address().port}`,token:'test-token'};
try{
 const payload={text:'🎬 café 日本語',command:'apply'};
 assert.deepEqual(await request(ep,'/echo',payload),payload);
 await assert.rejects(request(ep,'/conflict',payload),e=>e.code==='CONFLICT'&&e.details.revision===4);
 await assert.rejects(request(ep,'/invalid',payload),SyntaxError);
 const before=calls;await assert.rejects(request(ep,'/broken',payload));assert.equal(calls,before+1);
 console.log('UTF-8, Content-Length, conflict details, invalid JSON and no retry passed');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
