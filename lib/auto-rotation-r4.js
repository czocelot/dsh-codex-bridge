import {createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,realpathSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {BridgeError} from './member-control.js';

const fail=(code,status=409,details)=>{const e=new BridgeError(code,status);e.details=details;throw e;};
const digest=value=>createHash('sha256').update(JSON.stringify(Object.fromEntries(
  Object.keys(value).sort().map(k=>[k,value[k]])))).digest('hex');

// An official permission-change notification is preserved, not an executable task.
export function isPassiveApprovalNotice(item) {
  return item?.source?.kind === 'user-approval' && item.role === 'user'
    && Array.isArray(item.content) && item.content.length === 1
    && item.content[0]?.type === 'text'
    && item.content[0].text === 'The approval policy changed from "never" to "ask" (changed by the user).';
}

/** Runs on ordinary prompt submission, not a background AI polling task.
 * The existing native rotation transaction owns create/Auto/ACK/group/commit.
 * Current handoff content is layer-authored; missing/failed handoffs retain the
 * old binding and never release the original work into an over-budget session.
 */
export function createAutoRotation(rotation,config,life,options={}) {
  const file=options.file;
  let store=file&&existsSync(file)?JSON.parse(readFileSync(file,'utf8')):
    {schema:'bridge-auto-rotation/1',requests:{}};
  if(store.schema!=='bridge-auto-rotation/1'||!store.requests)fail('AUTO_ROTATION_STORE_INVALID',503);
  const flights=new Map();
  const now=options.now??Date.now;
  const delay=options.delay??(ms=>new Promise(r=>setTimeout(r,ms)));
  const maxWait=options.maxWaitMs??240000;
  function save(){
    if(!file)return;
    mkdirSync(dirname(file),{recursive:true});const temporary=file+'.'+randomBytes(6).toString('hex')+'.pending';
    writeFileSync(temporary,JSON.stringify(store,null,2),{flush:true,flag:'wx'});
    for(let attempt=0;;attempt++){
      try{renameSync(temporary,file);break;}
      catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=9)throw error;
        // Windows readers/scanners can briefly deny replacement. Keep the old
        // durable state intact; bounded same-path retry never deletes it.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);
      }
    }
  }
  function handoff(layer){
    if(options.readHandoff)return options.readHandoff(layer);
    const item=(config.rotationLayers??[]).find(x=>x.layer===layer);
    if(!item?.handoffFile)fail('CURRENT_LAYER_HANDOFF_FILE_REQUIRED',409,{layer});
    const root=realpathSync(config.workspace),path=realpathSync(resolve(config.workspace,item.handoffFile));
    const within=relative(root,path);
    if(within.startsWith('..')||isAbsolute(within))fail('HANDOFF_OUTSIDE_PROJECT',403);
    return readFileSync(path,'utf8').replace(/^\uFEFF/,'');
  }
  function receipt(row){return {from_session_id:row.source_session_id,
    to_session_id:row.target_session_id,rotation_request_id:row.rotation_request_id,
    trigger_steps:650,source_execution_steps:row.execution_steps,
    phase:'committed',old_history_retained:true};}
  async function perform(row){
    let value;
    try {value=await rotation.status(row.rotation_request_id);}
    catch(e){if(e.code!=='ROTATION_NOT_FOUND')throw e;}
    const retryable=value?.last_error?.code==='NATIVE_SESSION_LOCAL_MODEL_SELECTION_UNAVAILABLE'
      && value.session_id && !value.creation_uncertain && ['created','grouped_and_reviewed'].includes(value.phase);
    if(!value||retryable){
      if(!value&&options.prepareHandoff)await options.prepareHandoff(row);
      if(!row.creation_request){
        const text=handoff(row.layer);
        if(typeof text!=='string'||text.length<100||text.length>4800)fail('CURRENT_LAYER_HANDOFF_INVALID',409);
        const proposed={source_session_id:row.source_session_id,
          request_id:row.rotation_request_id,expected_workspace_id:row.workspace_id,
          expected_title:row.next_title,handoff_text:text,initialize_new_auto:true};
        if(value&&createHash('sha256').update(JSON.stringify(proposed)).digest('hex')!==value.digest)
          fail('RECOVERY_HANDOFF_CONTENT_CHANGED',409);
        row.creation_request=proposed;save();
      }
      // Explicit retry of the same ordinary request resumes this same recorded
      // session. Native create is idempotent and never repeats uncertain creation.
      value=await rotation.create(row.creation_request);
    }
    const deadline=now()+maxWait;
    while(value.phase!=='committed'){
      if(life.closed||life.signal?.aborted)fail('BRIDGE_UNLOADED',503);
      value=await rotation.status(row.rotation_request_id);
      if(value.phase==='committed')break;
      if(value.creation_uncertain||value.last_error)fail('ROTATION_REQUIRES_RECORDED_RECOVERY',409,
        {request_id:row.rotation_request_id,last_error:value.last_error});
      if(value.handoff?.state==='completed'&&!value.handoff?.shared_turn){
        value=await rotation.commit({request_id:row.rotation_request_id});break;
      }
      if(['failed','canceled','shared_turn'].includes(value.handoff?.state))
        fail('HANDOFF_NOT_COMPLETED',409,{request_id:row.rotation_request_id,state:value.handoff.state});
      if(now()>=deadline)fail('ROTATION_PENDING',409,{request_id:row.rotation_request_id});
      await delay(10000);
    }
    if(value.phase!=='committed'||!value.session_id)fail('ROTATION_NOT_COMMITTED',409);
    return value;
  }
  async function beforeSubmit(request,legacy=false){
    // Match the existing API aliases and validation before any side effect.
    const allowed=['session_id','sessionId','request_id','requestId','text','mode'];
    if(!request||typeof request!=='object'||Object.keys(request).some(k=>!allowed.includes(k))
      ||typeof request.text!=='string'||!request.text.trim()||request.text.length>6500
      ||!['queue','steer'].includes(request.mode)
      ||(request.session_id!==undefined&&request.sessionId!==undefined&&request.session_id!==request.sessionId)
      ||(request.request_id!==undefined&&request.requestId!==undefined&&request.request_id!==request.requestId))
      return {request,rotation:null};
    const source=request.session_id??request.sessionId??(legacy?config.sessionId:undefined);
    const id=request.request_id??request.requestId;
    if(typeof source!=='string'||typeof id!=='string'||!/^codex-[\w-]{1,100}$/.test(id))
      return {request,rotation:null};
    request={session_id:source,request_id:id,text:request.text,mode:request.mode};
    const key=source+'|'+request.request_id,sha=digest(request);let row=store.requests[key];
    if(row&&row.digest!==sha)fail('REQUEST_CONTENT_MISMATCH',409);
    if(row?.phase==='committed')return {request:{...request,session_id:row.target_session_id},rotation:receipt(row)};
    if(!row){
      let view;
      try{view=await rotation.inspect(source);}
      catch(e){
        if(e.code==='SESSION_NOT_AUTHORIZED_FOR_ROTATION'
          &&!(config.rotationLayers??[]).some(x=>x.sourceSessionId===source))
          return {request,rotation:null};
        throw e;
      }
      if(!Number.isSafeInteger(view.execution_steps)||view.execution_steps<0)fail('NATIVE_STEP_COUNTER_UNAVAILABLE',503);
      // The single latest request usage is not cumulative billed tokens. Keep
      // unknown context explicitly unknown. UTF8 bytes conservatively reserve
      // the next text; the existing400k model-compaction obligation remains.
      const last=view.latest_model_request_tokens;
      const tokenTrigger=Number.isSafeInteger(last)&&last+Buffer.byteLength(request.text,'utf8')>=360000;
      if(view.execution_steps<650&&!tokenTrigger)return {request,rotation:null,
        preflight:{managed:true,execution_steps:view.execution_steps,token_counter_known:Number.isSafeInteger(last)}};
      row={digest:sha,source_session_id:source,layer:view.layer,workspace_id:view.source.workspace_id,
        next_title:view.next_title,execution_steps:view.execution_steps,phase:'prepared',
        rotation_request_id:'codex-auto-rotate-'+view.layer+'-'+createHash('sha256').update(source).digest('hex').slice(0,20)};
      store.requests[key]=row;save();
    }
    let flight=flights.get(row.rotation_request_id);
    if(!flight){flight=perform(row);flights.set(row.rotation_request_id,flight);}
    let value;
    try{value=await flight;}finally{if(flights.get(row.rotation_request_id)===flight)flights.delete(row.rotation_request_id);}
    row.target_session_id=value.session_id;row.phase='committed';save();
    return {request:{...request,session_id:value.session_id},rotation:receipt(row)};
  }
  function resolveRequest(sessionId,requestId){
    const row=store.requests[sessionId+'|'+requestId];
    return row?.phase==='committed'&&row.source_session_id===sessionId?row.target_session_id:sessionId;
  }
  return {beforeSubmit,resolveRequest};
}
