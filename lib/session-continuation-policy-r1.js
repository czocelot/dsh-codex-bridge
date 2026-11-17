import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function continuation(config,id){
 try{
  const file=resolve(config.workspace,'tools/dsh-session-continuation-20261117-r1/POLICY.json');
  const p=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  return p.schema==='dsh-user-session-continuation/1'&&p.enabled===true
    &&resolve(p.workspace)===resolve(config.workspace)&&Array.isArray(p.session_ids)
    &&p.session_ids.includes(id)&&p.native_permissions_review_SafetyNet_and_compaction_unchanged===true;
 }catch{return false;}
}
export function continuationStatus(config){
 let ids=[];
 try {const p=JSON.parse(readFileSync(resolve(config.workspace,'tools/dsh-session-continuation-20261117-r1/POLICY.json'),'utf8').replace(/^\uFEFF/,''));ids=Array.isArray(p.session_ids)?p.session_ids:[];} catch {}
 return {policy:'user-managed continuation; native compaction retained',session_ids:ids.filter(id=>continuation(config,id)),native_review_and_permissions_unchanged:true};
}

