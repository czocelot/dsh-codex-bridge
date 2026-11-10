import {createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {nativeServices,BridgeError} from './member-control.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function atomic(file,value){mkdirSync(dirname(file),{recursive:true});const temp=file+'.'+randomBytes(6).toString('hex')+'.pending';writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx',flush:true});for(let n=0;;n++){try{renameSync(temp,file);return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||n>=9)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);}}}

/** Last-resort bound on cumulative native model steps; only runs at the public
 * pre-step boundary, after the preceding tool batch and results have settled. */
export function createTurnBudgetGuard(options){
 const state=options.initial??{schema:'bridge-turn-budget/1',sessions:{}};
 const seen=new Map(),initialized=new Set(),loading=new Map(),jobs=new Map();
 const save=()=>options.persist(state);
 function source(id){return options.sources().find(x=>x.session_id===id)
   ??(state.sessions[id]?.frozen?state.sessions[id].source:null);}
 function observe(session,event){if(event.type!=='step/start'||!source(session.id))return;if(!Number.isSafeInteger(event.seq)){initialized.delete(session.id);return;}let ids=seen.get(session.id);if(!ids)seen.set(session.id,ids=new Set());ids.add(event.seq);}
 async function count(id){if(!initialized.has(id)){
  if(!loading.has(id))loading.set(id,(async()=>{const events=await options.events(id);let ids=seen.get(id);if(!ids)seen.set(id,ids=new Set());for(const e of events)if(e.type==='step/start')ids.add(e.seq);initialized.add(id);})().finally(()=>loading.delete(id)));
  await loading.get(id);
 }return seen.get(id)?.size??0;}
 function snapshot(id){const row=state.sessions[id];if(!row)return null;return {session_id:id,layer:row.source.layer,soft_threshold:650,hard_stop_before_model_step:691,native_steps:seen.get(id)?.size??row.native_steps,last_pre_step_count:row.native_steps,frozen:!!row.frozen,reason:row.reason??null,summary_ready:!!row.summary_ready,deferred_count:row.deferred?.length??0,source_handoff_journal:row.source_handoff_journal??null,wrapup_request_id:row.wrapup_request_id??null,error:row.error??null};}
 async function before(agent,messages,next){
  const selected=source(agent.id);if(!selected)return next();
  const n=await count(agent.id);let row=state.sessions[agent.id];
  if(!row){row={source:selected,native_steps:n,deferred:[]};state.sessions[agent.id]=row;}
  row.native_steps=n;
  const ready=options.summaryReady(selected,agent.id);
  if(row.frozen||n>=690||(n>=650&&ready)){
   // Preserve exact source/content/id before rejecting admission. Never clear the
   // native inbox, cancel tools, replay a peer as a user, or kill the Agent.
   for(const message of messages){if(!row.deferred.some(x=>x.id===message.id))row.deferred.push(structuredClone(message));}
   row.frozen=true;row.summary_ready=!!ready;row.reason=ready?'handoff_summary_saved':'native_step_budget_690';save();
   if(options.publishFrozenRecord){row.source_handoff_journal=options.publishFrozenRecord(selected,agent.id,n,row);save();}
   if(ready)options.publishSummaryMeta(selected,agent.id,n,ready,row);
   return {kind:'reject'};
  }
  if(n>=650&&!row.wrapup_request_id){
   row.wrapup_request_id='codex-budget-wrapup-'+selected.layer+'-'+hash(agent.id).slice(0,18);save();
   const work=options.enqueueWrapup(selected,agent.id,row.wrapup_request_id);
   jobs.set(agent.id,work);work.catch(e=>{row.error={code:e.code??e.name,message:String(e.message).slice(0,300)};save();}).finally(()=>jobs.delete(agent.id));
  }
  // Normal official review is always downstream; an allowed step never skips it.
  return next();
 }
 return {before,observe,count,snapshot,state};
}

export function installTurnBudgetGuard(ctx,config,life,rotation,api,{file}={}){
 if(!file)throw new BridgeError('BUDGET_JOURNAL_PATH_REQUIRED',503);
 const native=()=>nativeServices(ctx,['agents','sessionQuery']);
 const initial=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;
 if(initial&&initial.schema!=='bridge-turn-budget/1')throw new BridgeError('BUDGET_JOURNAL_INVALID',503);
 const marker=selected=>resolve(config.workspace,'tools/dsh-layer-handoffs','BUDGET-ACK-'+selected.layer+'-'+hash(selected.session_id).slice(0,18)+'.json');
 const summary=selected=>{if(!/^tools[\\/]dsh-layer-handoffs[\\/][\w-]+\.zh\.md$/.test(selected.handoffFile??''))throw new BridgeError('CURRENT_LAYER_HANDOFF_FILE_REQUIRED',409);return resolve(config.workspace,selected.handoffFile);};
 const guard=createTurnBudgetGuard({initial,sources:()=>rotation.managedSources(),
  persist:row=>atomic(file,row),events:async id=>(await native().sessionQuery.readSession(id)).events,
  summaryReady:(selected,id)=>{try{const ack=JSON.parse(readFileSync(marker(selected),'utf8').replace(/^\uFEFF/,''));const bytes=readFileSync(summary(selected));const text=bytes.toString('utf8');return ack.source_session_id===id&&ack.work_stopped===true&&ack.pending_tasks_saved===true&&ack.summary_sha256===hash(bytes)&&text.length>=100&&text.length<=4800?{sha256:ack.summary_sha256}:null;}catch{return null;}},
  publishFrozenRecord:(selected,id,n,row)=>{
   const target=file.replace(/\.json$/,'-source-'+hash(id).slice(0,18)+'.json');
   atomic(target,{schema:'bridge-source-budget-handoff/1',source_session_id:id,layer:selected.layer,native_steps:n,reason:row.reason,deferred_inputs:row.deferred,history_retained:true,automatic_replay:false,saved_utc:new Date().toISOString()});return target;
  },
  publishSummaryMeta:(selected,id,n,ready,row)=>{
   atomic(summary(selected)+'.meta.json',{layer:selected.layer,source_session_id:id,source_execution_steps:n,sha256:ready.sha256,author:'authorized native budget handoff guard',budget_journal:row.source_handoff_journal,unexecuted_inputs_saved:row.deferred.map(x=>({id:x.id,source:x.source})),updated_utc:new Date().toISOString()});
  },
  enqueueWrapup:(selected,id,requestId)=>api.submit({session_id:id,request_id:requestId,mode:'steer',text:
   '这是用户已批准的会话预算收口，累计模型步骤已到650。现在只完成必要保存与精简交接，不开展新工程/训练/GPU，不创建新成员。请将当前目标、授权限制、事实证据、已完成/未完成任务及当前工作点写入本层唯一交接文件 '+summary(selected)+'，100至4500字符；保留原授权、审批问题和旧历史，不复制全历史。随后计算文件原始字节SHA256并写入 '+marker(selected)+'，JSON字段source_session_id='+id+'、summary_sha256、work_stopped=true、pending_tasks_saved=true。写完即结束，不做其他工作。下一模型步骤前由原生边界确认；690步安全上限不取消在途工具，也不会自动重试被拒动作。'}).then(receipt=>{if(receipt?.receipt?.accepted!==true)throw new BridgeError('BUDGET_WRAPUP_NOT_ADMITTED',409);return receipt;})});
 const attached=new WeakSet();const disposers=[];
 function attach(agent){if(attached.has(agent))return;if(!rotation.managedSources().some(x=>x.session_id===agent.id)&&!guard.state.sessions[agent.id]?.frozen)return;attached.add(agent);disposers.push(agent.ctx.on('agent/pre-step',async({agent:current,messages},next)=>{
   if(life.closed)return next();return guard.before(current??agent,messages,next);
  },{prepend:true}));}
 for(const agent of native().agents.list())attach(agent);
 const offCreate=ctx.on('agent/created',({agent})=>attach(agent));
 const offStatus=ctx.on('agent/status',({agent})=>attach(agent));
 const offEvents=ctx.on('session/event',(session,event)=>guard.observe(session,event));
 ctx.effect(()=>()=>{offCreate();offStatus();offEvents();for(const off of disposers)off();});
 life.turnBudgetGuard=guard;
 return guard;
}
