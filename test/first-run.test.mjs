import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {validateConfig, createHandler} from '../lib/index.js';
import {validateConfig as validateRotation} from '../lib/index-rotation-r4-model.js';
import {readSessionBindings} from '../lib/session-control.js';
const session='session-11111111-1111-4111-8111-111111111111';
function fixture(){
 const calls={prompts:0,loads:0,permissions:0};
 const services={sessions:new Map(),agents:new Map(),sessionProjections:{cachedSnapshot:()=>({values:{inbox:{}}})},sessionQuery:{listSessions:async()=>[],readTitle:async()=>''},sessionController:{prompt(){calls.prompts++},resolveAgent(){calls.loads++}},permissionPresets:{names:['auto'],catalog:()=>({options:[{value:'auto',name:'Auto'}]}),set(){calls.permissions++}},loader:{entries:()=>[]}};
 const ctx={get:name=>services[name]},config=validateConfig({port:32091}),life={closed:false,signal:new AbortController().signal,active:new Set()};
 const store={get:()=>null,entries:()=>[],set(){throw Error('Unexpected save')}};
 const handler=createHandler(ctx,config,life,{initialLedger:{version:1,requests:[]},connections:{store},permissions:{audit(){}}});
 async function request(method,url,body,extra={}){
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=method;req.url=url;req.headers={host:'127.0.0.1:32091',...(body?{'content-type':'application/json'}:{}),...extra};req.socket={remoteAddress:'127.0.0.1'};
  let status,value;const res={writeHead(code){status=code},end(text){value=JSON.parse(text)}};await handler(req,res);return{status,value};
 }
 return{request,calls};
}
test('fresh one-click config starts without a legacy session or project',()=>{const c=validateConfig();assert.equal(c.sessionId,'');assert.equal(c.workspace,undefined);assert.deepEqual(c.sessionBindings,[]);assert.deepEqual(readSessionBindings(),[])});
test('legacy ID and workspace must both be set',()=>{assert.throws(()=>validateConfig({sessionId:session}));assert.throws(()=>validateConfig({workspace:resolve('fixture-project')}));assert.equal(validateConfig({sessionId:session,workspace:resolve('fixture-project')}).sessionId,session)});
test('unscoped static bindings and member maintenance are not enabled on first run',()=>{assert.throws(()=>validateConfig({sessionBindings:[{session_id:session,expected_title:'Fixture'}]}));assert.throws(()=>validateConfig({enableMemberCompaction:true}));assert.throws(()=>validateRotation())});
test('fresh status is healthy and bound-session listing is empty without side effects',async()=>{const f=fixture();const status=await f.request('GET','/status');assert.equal(status.status,200);assert.equal(status.value.attached,false);assert.equal(status.value.version,'0.8.0');const listing=await f.request('GET','/sessions');assert.deepEqual(listing.value.sessions,[]);assert.deepEqual(f.calls,{prompts:0,loads:0,permissions:0})});
test('unbound prompt is refused before any native model call',async()=>{const f=fixture();const r=await f.request('POST','/v1/prompt',{session_id:session,request_id:'codex-fixture',text:'Fixture only',mode:'queue'});assert.equal(r.status,403);assert.equal(r.value.error,'SESSION_NOT_BOUND');assert.equal(f.calls.prompts,0)});
test('browser origin and wrong host cannot access local bridge',async()=>{const f=fixture();assert.equal((await f.request('GET','/status',null,{origin:'https://example.org'})).status,403);assert.equal((await f.request('GET','/status',null,{host:'example.org:32091'})).status,403)});
