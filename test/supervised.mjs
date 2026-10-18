// No real authentication or inference. Fake CLI plus a tiny loopback MCP endpoint.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { stateDir } from '../state.mjs';
const F=mkdtempSync(join(tmpdir(),'ns-supervised-test-')), home=join(F,'home'), state=join(F,'state'), tmp=join(F,'tmp');
for(const p of [home,state,tmp]) mkdirSync(p);
mkdirSync(join(home,'.nightshift')); writeFileSync(join(home,'.nightshift','me.json'),'PRESERVE-REAL-STATE');
let failures=0; const ok=(b,s)=>{console.log((b?'PASS ':'FAIL ')+s);if(!b)failures++;};
for(const env of [{NIGHT_SHIFT_STATE_DIR:'relative',NIGHT_SHIFT_SITE:'http://127.0.0.1:1'},{NIGHT_SHIFT_STATE_DIR:state,NIGHT_SHIFT_SITE:'https://example.com'}]) {
  let threw=false;try{stateDir(env);}catch{threw=true;}ok(threw,'separate state refuses relative paths or non-loopback APIs');
}
let calls=[];const token='cw_'+'a'.repeat(48);
const server=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const msg=body?JSON.parse(body):{};calls.push(req.url+':'+(msg.params?.name||''));res.setHeader('content-type','application/json');
  if(req.url==='/api/join')return res.end(JSON.stringify({ok:true,token,handle:'local-test',agent_id:'a',mission:'indus-script',hours:1,page_url:'http://127.0.0.1:1/ai/local-test#key=private-fixture'}));
  const data=msg.params?.name==='check_in'?{action:'start'}:msg.params?.name==='report'?{finalized:true}:{ok:true};
  res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const site='http://127.0.0.1:'+server.address().port;
const fake=join(F,'claude'), capture=join(F,'capture.json');
writeFileSync(fake,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';const a=process.argv.slice(2);if(a.includes('--version'))console.log('2.1.299 (Claude Code)');else if(a.includes('auth'))console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));else{writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:a,env:process.env}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Fixture',num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}));}`);
// The fixture CLI lives outside a package, so give its extensionless file ESM semantics through its own package.
writeFileSync(join(F,'package.json'),' {"type":"module"}');chmodSync(fake,0o755);
const bridge=resolve(new URL('../bridge.mjs',import.meta.url).pathname);
const env={PATH:process.env.PATH,HOME:home,NIGHT_SHIFT_STATE_DIR:state,NIGHT_SHIFT_SITE:site,NIGHT_SHIFT_TMP:tmp,NIGHT_SHIFT_CLAUDE:fake};
async function launch(args,extra={}){const p=spawn(process.execPath,[bridge,...args],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);const code=await new Promise(r=>p.on('exit',r));return{code,out};}
const bad=await launch(['start','--supervised'],{NIGHT_SHIFT_STATE_DIR:''});ok(bad.code===2&&!existsSync(capture),'supervised mode refuses missing isolated state before CLI/inference');
const weekly=await launch(['start','--supervised','--weekly']);ok(weekly.code===2&&!existsSync(capture),'supervised mode cannot start weekly work');
const good=await launch(['start','--supervised'],{NIGHT_SHIFT_LIMIT_SECONDS:'9999'});
const c=JSON.parse(readFileSync(capture,'utf8'));
ok(good.code===0&&c.args.includes('--restricted')&&c.args.includes('--strict-mcp-config')&&c.args[c.args.indexOf('--max-turns')+1]==='16'&&c.args[c.args.indexOf('--model')+1]==='haiku','bounded child keeps the privacy flags and receives Haiku plus 16-turn cap');
ok(c.env.HOME===home&&c.env.NIGHT_SHIFT_STATE_DIR===state&&c.env.NIGHT_SHIFT_NO_OPEN==='1'&&c.env.NIGHT_SHIFT_SINGLE_RUN==='1','only Night Shift state is redirected; HOME is unchanged and browser/second run are disabled');
ok(c.env.CLAUDE_CODE_MAX_RETRIES==='0'&&c.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK==='1'&&c.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS==='2048'&&!c.env.CLAUDE_CODE_RETRY_WATCHDOG,'retry/output controls reach the child without a retry watchdog');
ok(/at most 120 seconds/.test(good.out)&&/not a dollar cap/.test(good.out),'time bound cannot be raised above 120 seconds and is not presented as a dollar cap');
ok(readdirSync(tmp).length===0&&readdirSync(join(state,'reports')).some(f=>f.endsWith('-provider.json'))&&readFileSync(join(home,'.nightshift','me.json'),'utf8')==='PRESERVE-REAL-STATE','cleanup and provider evidence use fixture state while normal identity stays untouched');

const ctl=join(F,'ctl');mkdirSync(ctl);
const p=spawn(process.execPath,[bridge],{env:{...env,NIGHT_SHIFT_CTL:ctl,NIGHT_SHIFT_SINGLE_RUN:'1',NIGHT_SHIFT_NO_OPEN:'1'},stdio:['pipe','pipe','pipe']});let buf='',n=0;const waits=new Map();p.stdout.on('data',b=>{buf+=b;let i;while((i=buf.indexOf('\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);waits.get(m.id)?.(m);}});
const call=(name,args={})=>new Promise(r=>{const id=++n;waits.set(id,r);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});
await call('join');await call('check_in');await call('report');const count=calls.length;
const second=await call('check_in'), choice=await call('record_choice',{choice:'weekly'});
ok(second.result.isError&&choice.result.isError&&calls.length===count,'after report a second run and weekly choice are refused before server access');
ok(JSON.parse(readFileSync(join(state,'me.json'),'utf8')).handle==='local-test'&&readFileSync(join(home,'.nightshift','me.json'),'utf8')==='PRESERVE-REAL-STATE','bridge joins only into separate fixture identity storage');
p.kill();await new Promise(r=>p.on('close',r));await new Promise(r=>server.close(r));
console.log(failures?`${failures} FAILED`:'all passed');process.exitCode=failures?1:0;
