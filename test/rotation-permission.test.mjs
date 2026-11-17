import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionChoice, selectPermission, applyRotationPermission, permissionMatches } from '../lib/rotation-permission.js';
const specs={auto:{sandbox:'danger-full-access',approval:'ask'},full:{sandbox:'danger-full-access',approval:'never'},read:{sandbox:'read-only',approval:'ask'},custom:{sandbox:'workspace-write',approval:'ask'}};
const source=p=>({current_preset:p,...specs[p],preset_specs:specs,revision:7});
test('follow preserves every native preset; explicit selects only a native preset',()=>{
 for(const p of Object.keys(specs)) {
  assert.deepEqual(selectPermission({permission_mode:'follow'},source(p)),{mode:'follow',preset:p,...specs[p]});
  assert.deepEqual(selectPermission({permission_mode:'explicit',permission_preset:p},source('auto')),{mode:'explicit',preset:p,...specs[p]});
 }
 assert.equal(permissionChoice({initialize_new_auto:true}).preset,'auto');
 for(const r of [{permission_mode:'other'},{permission_mode:'follow',permission_preset:'full'},{permission_mode:'explicit'},{initialize_new_auto:true,permission_mode:'follow'}]) assert.throws(()=>permissionChoice(r));
 assert.throws(()=>selectPermission({permission_mode:'explicit',permission_preset:'invented'},source('auto')));
 assert.throws(()=>selectPermission({permission_mode:'follow'}, {...source('auto'),approval:'never'}),{code:'SOURCE_PERMISSION_NOT_STABLE'});
});
test('native setter, revision and readback remain authoritative; no change for matched target',async()=>{
 for(const preset of Object.keys(specs)) {
  const wanted=selectPermission({permission_mode:'follow'},source(preset));let view=source('read'), calls=[];
  const settings={query:async()=>view,change:async r=>{calls.push(r);view=source(r.preset);}};
  const result=await applyRotationPermission(settings,'new','codex-test',wanted);
  assert.ok(permissionMatches(result,wanted));assert.equal(calls.length,preset==='read'?0:1);
  if(calls.length){assert.equal(calls[0].expected_revision,7);assert.equal(calls[0].preset,preset);}
 }
 const wanted=selectPermission({permission_mode:'follow'},source('full'));
 await assert.rejects(applyRotationPermission({query:async()=>source('auto'),change:async()=>{}},'new','codex-bad',wanted),{code:'NEW_PERMISSION_READBACK_FAILED'});
 await assert.rejects(applyRotationPermission({query:async()=>({...source('auto'),preset_specs:{}})},'new','codex-bad',wanted),{code:'NATIVE_PRESET_CHANGED'});
});import { createRotationControl } from '../lib/rotation-control-r4-model.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('full handoff: explicit overrides non-Auto source; follow and legacy preserve their contract', async()=>{
 for (const [from,requestOptions,to] of [['full',{},'read'],['full',{permission_mode:'explicit',permission_preset:'custom'},'custom'],['full',{permission_mode:'follow'},'full'],['auto',{initialize_new_auto:true},'auto']]) {
  const cwd=mkdtempSync(join(tmpdir(),'bridge-permission-'));const sourceId='session-source',newId='session-target';
  let bound=false,unbound=false,submitted=false,created=0;let targetPreset='read';let title='';
  const agents=new Map([[sourceId,{id:sourceId}]]);let selected={provider:'test',model:'test-model'};
  const w={id:'workspace-test',title:'fixture',path:cwd,sessionIds:[sourceId]};
  const ctx={workspaceRegistry:{list:()=>[w],get:()=>w},agents,
   sessionQuery:{listSessions:async()=>[{header:{id:sourceId}}],readTitle:async id=>id===sourceId?'调研层使用1':title,readSession:async id=>({events:id===sourceId?[]:[{type:'tool/result'}]})},
   sessionController:{create:async()=>{created++;w.sessionIds.push(newId);agents.set(newId,{id:newId});return {sessionId:newId};},rename:async o=>{title=o.title;},
    agents:{selectionFor:()=>({current:selected}),serializeImageAdmission:async(_,fn)=>fn(),selectForNextRequest:(_,s)=>{selected=s;}},
    ctx:{llm:{listProviders:()=>[{id:'test'}],listModels:async()=>[{id:'test-model'}],resolveCallConfig:async s=>s}}}};
  const settings={query:async id=>source(id===sourceId?from:targetPreset),change:async r=>{assert.equal(r.session_id,newId);targetPreset=r.preset;}};
  const api={rotationInternals:{inspectTarget:async id=>({header:{id,cwd},title:id===sourceId?'调研层使用1':title}),settingsPermissions:settings},
   connection:{prepare:async()=>({confirmation_required:false,plan_id:'p'}),confirm:async()=>{bound=true;return {permission_changed:false};},bindingDisabled:()=>unbound},
   submit:async r=>{assert.ok(bound);assert.equal(targetPreset,to);assert.equal(r.session_id,newId);submitted=true;return {accepted:true};},
   read:async()=>({state:'completed',shared_turn:false}),status:async()=>({agent_status:'idle'}),unbind:async id=>{assert.equal(id,sourceId);unbound=true;}};
  const control=createRotationControl(ctx,{workspace:cwd,rotationLayers:[{layer:'research',sourceSessionId:sourceId,prefix:'调研层使用',handoffFile:'handoff.md'}]},{closed:false,signal:new AbortController().signal},api);
  try {
   const request={source_session_id:sourceId,request_id:'codex-flow',expected_workspace_id:w.id,expected_title:'调研层使用2',handoff_text:'handoff '.repeat(20),...requestOptions};
   const row=await control.create(request);assert.ok(submitted);assert.equal(row.permission.preset,to);assert.equal(created,1);
   mkdirSync(join(cwd,'tools','dsh-session-rotation-20261102-r1'),{recursive:true});
   writeFileSync(row.ack_path,JSON.stringify({session_id:newId,workspace_id:w.id,title,read_agents_md:true,handoff_received:true}));
   targetPreset=to==='read'?'full':'read';await assert.rejects(control.commit({request_id:request.request_id}),{code:'NEW_PERMISSION_CHANGED_BEFORE_COMMIT'});assert.equal(unbound,false);
   targetPreset=to;const done=await control.commit({request_id:request.request_id});assert.equal(done.phase,'committed');assert.equal(unbound,true);
   assert.equal((await control.active('research')).source.session_id,newId);
   assert.equal((await control.create(request)).session_id,newId);
  } finally {rmSync(cwd,{recursive:true,force:true});}
 }
});