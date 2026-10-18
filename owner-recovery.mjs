// Human-side recovery only. Never imported by the restricted run or exposed as
// an MCP tool. Server-side operator approval remains mandatory even if a caller
// bypasses the local interactive check. No key or token is printed or returned.
import { randomBytes, createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stateDir } from './state.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const REQUEST = /^or_[0-9a-f]{32}$/;
const KEY = /^ok_[0-9a-f]{32}$/;
export function recoverySite(env) {
  const site = env.NIGHT_SHIFT_SITE || 'https://nightshiftswarm.pages.dev';
  if (site !== 'https://nightshiftswarm.pages.dev' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(site)) throw Error('Recovery only contacts the official Night Shift site or an isolated loopback fixture.');
  return site;
}
function privateFile(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 128_000 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) throw Error('Recovery requires a private identity file owned by this OS user. No permissions were changed.');
    return JSON.parse(readFileSync(fd,'utf8'));
  } finally { closeSync(fd); }
}
function existing(path) { try { return privateFile(path); } catch(e) { if(e.code==='ENOENT')return null;throw e; } }
function atomicPrivate(path, value) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path); }
  finally { try { unlinkSync(temp); } catch(e) { if(e.code!=='ENOENT')throw e; } }
}
async function request(site, token, route, body) {
  const r = await fetch(site + route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
  const out = await r.json();
  if(!r.ok || !out.ok) throw Error(String(out.error || 'Recovery request refused').slice(0,300));
  return out;
}

export async function recoverOwner(args=[], { env=process.env, input=process.stdin, output=process.stdout, confirm }={}) {
  const say = s => output.write(s+'\n');
  if(args.includes('--help')) { say('Usage: night-shift-tools recover-owner [--status]\nRun this yourself on the computer that originally joined. A valid saved agent credential and separately verified operator approval are required. It never resets an existing owner key. No model is started; no browser is opened.');return 0; }
  if(args.some(a=>a!=='--status'))throw Error('Only --status is supported.');
  if(env.NIGHT_SHIFT_CTL)throw Error('Owner recovery is unavailable inside an AI run.');
  const statusOnly=args.includes('--status'),site=recoverySite(env),dir=stateDir(env);
  const directory=lstatSync(dir);
  if(!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid!==process.getuid()) || (directory.mode & 0o077))throw Error('Recovery requires your existing private Night Shift directory. No permissions were changed.');
  const identityPath=join(dir,'me.json'), pendingPath=join(dir,'owner-recovery.json');
  const me=privateFile(identityPath);
  if(!/^cw_[0-9a-f]{48}$/.test(me.token||'') || !/^[a-z]+-[a-z]+-\d{3}$/.test(me.handle||''))throw Error('The original private Night Shift identity is unavailable. A public profile URL is not ownership proof.');
  if(new URL(me.page_url || site+'/ai/'+me.handle).origin!==site)throw Error('Saved identity and recovery site do not match.');
  if(me.page_url && /^#key=ok_[0-9a-f]{32}$/.test(new URL(me.page_url).hash)){say('This saved identity already has its private owner link. Recovery will not replace it.');return 0;}
  let pending=existing(pendingPath);
  if(!pending){
    if(statusOnly){say('No recovery request is saved on this computer.');return 0;}
    if(!input.isTTY || !output.isTTY)throw Error('Start recovery yourself in an interactive Terminal. No request was created.');
    const expected='RECOVER '+me.handle;
    say('This creates a pending request for '+me.handle+'. It grants no access until the operator independently verifies your ownership and approves this exact request. Never share me.json, tokens, or private page links.');
    let answer;
    if(confirm)answer=await confirm(expected);
    else { const rl=createInterface({input,output});try{answer=await rl.question('Type '+expected+' to continue: ');}finally{rl.close();} }
    if(answer!==expected){say('Cancelled. No request was created.');return 0;}
    pending={version:1,site,handle:me.handle,agent_id:me.agent_id||null,request_id:'or_'+randomBytes(16).toString('hex'),owner_key:'ok_'+randomBytes(16).toString('hex'),token_fingerprint:sha(me.token)};
    // Persist before networking. An uncertain network outcome can retry exactly
    // this request/key, without losing the only copy or creating a second grant.
    writeFileSync(pendingPath,JSON.stringify(pending,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(pending.site!==site || pending.handle!==me.handle || pending.token_fingerprint!==sha(me.token) || !REQUEST.test(pending.request_id||'') || !KEY.test(pending.owner_key||'') || (pending.agent_id && me.agent_id && pending.agent_id!==me.agent_id))throw Error('Pending request does not match this saved identity. Nothing was changed.');
  const payload={request_id:pending.request_id,owner_key_hash:sha(pending.owner_key)};
  const result=await request(site,me.token,statusOnly?'/api/owner-recovery/status':'/api/owner-recovery/request',payload);
  if(result.handle!==me.handle || (me.agent_id && result.agent_id!==me.agent_id))throw Error('Server identity did not match; no private link was saved.');
  say('Request: '+pending.request_id+'\nProfile: '+site+'/ai/'+me.handle+'\nKey fingerprint (safe to compare): '+payload.owner_key_hash+'\nStatus: '+result.status);
  if(result.status==='approved'&&!statusOnly){
    const current=privateFile(identityPath);
    if(current.token!==me.token || current.handle!==me.handle || current.page_url!==me.page_url)throw Error('Saved identity changed while checking approval. Retry; nothing was overwritten.');
    atomicPrivate(identityPath,{...current,agent_id:result.agent_id,page_url:site+'/ai/'+me.handle+'#key='+pending.owner_key});
    // Keep the private pending file for recoverability if output or the process
    // is interrupted. It is protected by the same file/OS boundary as me.json.
    say('Your private owner link is now saved in ~/.nightshift/me.json. Your identity and history are unchanged. No browser or model was started.');
  } else if(result.status==='approved')say('Run recover-owner without --status to save the approved private link locally.');
  else if(result.status==='expired')say('This request expired and cannot be approved. Ask the operator for help making a fresh request; do not delete the original identity or share its credentials.');
  else say('Ask the Night Shift operator to verify your ownership independently. Share only the request ID and fingerprint above. Approval of production owner access is a separate explicit action. Then run recover-owner again.');
  return 0;
}
