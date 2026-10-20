const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {Mailbox}=require('../dist/mailbox');
const {ManagedAgents}=require('../dist/managed-agents');
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t) {
 const directory=await fs.mkdtemp('/tmp/vta-test-'), mailbox=new Mailbox(directory);
 const client=new EventEmitter(); client.endpoint='unix:///tmp/fake.sock'; client.closed=false;
 client.bound=true; client.canWake=()=>client.bound;
 client.calls=[]; client.threadId=randomUUID(); client.liveStatus={type:'idle'};
 client.close=async()=>{client.closed=true; client.emit('closed',{code:'CLOSED'});};
 client.request=async(method,params)=>{
  client.calls.push({method,params});
  if(method==='thread/name/set')return {};
  if(method==='thread/start')return {thread:{id:client.threadId,status:{type:'idle'}}};
  if(method==='thread/read')return {thread:{id:client.threadId,status:client.liveStatus}};
  if(method==='turn/start') {
   const turn={id:randomUUID(),status:'inProgress'};
   client.liveStatus={type:'active',activeFlags:[]};
   client.emit('notification',{method:'turn/started',params:{threadId:client.threadId,turn}});
   return {turn};
  }
  throw Error(method);
 };
 let terminalCreates=0, terminalClosed=0, namedAtCreation=false;
 const manager=new ManagedAgents({windowId:randomUUID(),directory,mailbox,cliPath:'/tmp/cli.js',intervalMs:0,
  createClient:async()=>client,createTerminal:()=>{namedAtCreation=client.calls.some(x=>x.method==='thread/name/set');terminalCreates++;return {id:randomUUID(),dispose(){terminalClosed++;}};}});
 t.after(async()=>{await manager.dispose();await fs.rm(directory,{recursive:true,force:true});});
 const input={requestId:randomUUID(),name:'worker',cwd:directory};
 const agent=await manager.start(input);
 for(let n=0;n<100&&manager.status(agent.id).state==='starting';n++)await tick();
 assert.equal(manager.status(agent.id).state,'idle');
 const sender=randomUUID();await mailbox.register(sender,'sender');
 const send=async()=>mailbox.send({id:randomUUID(),from:sender,to:agent.id,text:'check fixture'});
 return {manager,client,mailbox,agent,input,send,counts:()=>({terminalCreates,terminalClosed,namedAtCreation})};
}
test('managed launch is retry-stable and creates a real-TUI binding without a turn',async t=>{
 const f=await fixture(t);
 assert.equal((await f.manager.start(f.input)).id,f.agent.id);
 assert.equal(f.counts().terminalCreates,1);
 assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,0);
 await assert.rejects(f.manager.start({...f.input,name:'other'}),{code:'ID_CONFLICT'});
});
test('idle mailbox automatically starts one turn, records events separately, and never acknowledges',async t=>{
 const f=await fixture(t), m=await f.send();
 await Promise.all([f.manager.poll(),f.manager.poll()]);
 const starts=f.client.calls.filter(x=>x.method==='turn/start');assert.equal(starts.length,1);
 assert.equal(starts[0].params.clientUserMessageId,m.id);
 let d=await f.mailbox.delivery({id:m.id,agentId:f.agent.id});assert.equal(d.stage,'turn_started');
 f.client.emit('notification',{method:'turn/completed',params:{threadId:f.client.threadId,turn:{id:d.turnId,status:'completed'}}});
 for(let n=0;n<100;n++){await tick();d=await f.mailbox.delivery({id:m.id,agentId:f.agent.id});if(d.stage==='turn_completed')break;}
 assert.equal(d.stage,'turn_completed');
 f.client.liveStatus={type:'idle'};
 f.client.emit('notification',{method:'thread/status/changed',params:{threadId:f.client.threadId,status:{type:'idle'}}});
 await f.manager.poll();assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,1);
 assert.equal((await f.mailbox.messages({agentId:f.agent.id})).messages[0].acknowledgedAt,null);
});
test('busy and approval-waiting agents defer messages, then wake on idle',async t=>{
 const f=await fixture(t);await f.send();
 for(const status of [{type:'active',activeFlags:[]},{type:'active',activeFlags:['waitingOnApproval']}]){
  f.client.liveStatus=status;f.client.emit('notification',{method:'thread/status/changed',params:{threadId:f.client.threadId,status}});
  await f.manager.poll();assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,0);
 }
 f.client.liveStatus={type:'idle'};f.client.emit('notification',{method:'thread/status/changed',params:{threadId:f.client.threadId,status:{type:'idle'}}});
 await f.manager.poll();assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,1);
});
test('ambiguous submit failure is durable and never retried automatically',async t=>{
 const f=await fixture(t),m=await f.send(),original=f.client.request;
 f.client.request=async(method,params)=>{if(method==='turn/start'){f.client.calls.push({method,params});throw Object.assign(Error('lost reply'),{code:'CODEX_TIMEOUT'});}return original(method,params);};
 await f.manager.poll();await f.manager.poll();
 assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,1);
 assert.equal((await f.mailbox.delivery({id:m.id,agentId:f.agent.id})).stage,'submission_unknown');
 assert.equal(f.manager.status(f.agent.id).state,'uncertain');
});
test('closing the managed terminal prevents queued work and closes only its owned server',async t=>{
 const f=await fixture(t);await f.send();
 await f.manager.terminalClosed(f.manager.status(f.agent.id).terminalId);
 await f.manager.poll();assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,0);
 assert.equal(f.client.closed,true);assert.equal(f.counts().terminalClosed,0);
 assert.equal(f.manager.status(f.agent.id).state,'closed');
});

test('automatic wake requires the current native TUI binding and resumes only after confirmed attachment',async t=>{
 const f=await fixture(t),m=await f.send();
 f.client.bound=false;f.client.emit('bindingChanged');
 await f.manager.poll();
 assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,0);
 assert.equal(f.manager.status(f.agent.id).state,'detached');
 assert.equal((await f.mailbox.delivery({id:m.id,agentId:f.agent.id})).stage,'queued');
 f.client.bound=true;f.client.emit('bindingChanged');await f.manager.poll();
 assert.equal(f.client.calls.filter(x=>x.method==='turn/start').length,1);
});

test('a late correlated start after the confirmation deadline recovers without resubmitting',async t=>{
 const f=await fixture(t),m=await f.send(),original=f.client.request;
 const turn={id:randomUUID(),status:'inProgress'};
 f.client.request=async(method,params)=>method==='turn/start'?{turn}:original(method,params);
 await f.manager.poll();
 const now=Date.now;Date.now=()=>now()+31000;
 try{await f.manager.poll();}finally{Date.now=now;}
 assert.equal(f.manager.status(f.agent.id).state,'uncertain');
 f.client.emit('notification',{method:'turn/started',params:{threadId:f.client.threadId,turn}});
 for(let n=0;n<100;n++){await tick();if((await f.mailbox.delivery({id:m.id,agentId:f.agent.id})).stage==='turn_started' && f.manager.status(f.agent.id).state==='working')break;}
 assert.equal(f.manager.status(f.agent.id).state,'working');
});

test('native TUI is launched only after naming materializes its fresh thread',async t=>{
 const f=await fixture(t);
 assert.equal(f.counts().namedAtCreation,true);
 assert.deepEqual(f.client.calls.find(x=>x.method==='thread/name/set').params,{threadId:f.client.threadId,name:f.input.name});
});
