// Installed CLI, synthetic HOME/key, deterministic loopback responses. No provider inference.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { streamCounters } from '../budget.mjs';
const dest=process.env.EVIDENCE_DIR || mkdtempSync(join(tmpdir(),'ns-turn-evidence-'));
mkdirSync(dest,{recursive:true});
let failures=0;const ok=(b,s)=>{console.log((b?'PASS ':'FAIL ')+s);if(!b)failures++;};
async function scenario(name,plan,maxTurns){
 const f=mkdtempSync(join(tmpdir(),'ns-turn-count-')), home=join(f,'home');mkdirSync(home);mkdirSync(join(home,'.claude'));writeFileSync(join(f,'sample.txt'),'fixture');
 const sock=createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const log=join(f,'mock.jsonl'),model=spawn(process.execPath,[resolve('test/mock-model.mjs'),String(port),log,JSON.stringify(plan)],{stdio:'ignore'});
 let child, timer;
 try{
  await new Promise(r=>setTimeout(r,250));
  child=spawn('/Users/mikerogers/.local/bin/claude',['-p','Read the fixture as scripted, then finish.','--restricted','--settings','{}','--tools','Read','--allowedTools','Read','--permission-mode','acceptEdits','--permission-prompts','none','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','stream-json','--verbose','--no-session-persistence','--max-turns',String(maxTurns),'--no-chrome'],{cwd:f,env:{PATH:process.env.PATH,HOME:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,ANTHROPIC_API_KEY:'sk-ant-test-turn-counting',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1'},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  timer=setTimeout(()=>child.kill('SIGKILL'),25000);
  const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer);
  const events=out.trim().split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x);}catch{return{};}}),counter=streamCounters();events.forEach(m=>counter.observe(m));
  const result=events.findLast(m=>m.type==='result'),requests=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.main).length:0;
  const evidence={name,code,maxTurns,requests,observed:counter.snapshot(),result:result?{subtype:result.subtype,num_turns:result.num_turns,is_error:result.is_error}:null,stderr:err.slice(0,1000),events:events.filter(m=>['assistant','user','result'].includes(m.type)).map(m=>({type:m.type,message_id:m.message?.id,tool_ids:m.message?.content?.filter(c=>c.type==='tool_use').map(c=>c.id),result_ids:m.message?.content?.filter(c=>c.type==='tool_result').map(c=>c.tool_use_id),subtype:m.subtype,num_turns:m.num_turns}))};
  writeFileSync(join(dest,name+'.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
 }finally{clearTimeout(timer);if(child?.exitCode===null)child.kill('SIGKILL');model.kill();await new Promise(r=>model.on('close',r));rmSync(f,{recursive:true,force:true});}
}
const read=()=>({name:'Read',input:{file_path:'sample.txt'}});
const parallel=await scenario('parallel-sixteen',[Array.from({length:16},read)],16);
ok(parallel.code===0&&parallel.result?.num_turns===17&&parallel.requests===2&&parallel.observed.tool_use_turns===1&&parallel.observed.tool_calls_requested===16,'16 parallel tool results produce num_turns 17 but only one tool-use cycle and two loopback requests');
const capped=await scenario('sequential-limit',Array.from({length:5},read),3);
ok(capped.code!==0&&capped.result?.subtype==='error_max_turns'&&capped.requests===3&&capped.observed.tool_use_turns===3,'native max-turns 3 stops sequential tool-use cycles after exactly three loopback requests');
console.log(failures?`${failures} FAILED`:'all passed');process.exitCode=failures?1:0;
