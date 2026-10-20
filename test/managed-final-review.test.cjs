const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {Mailbox}=require('../dist/mailbox');
const {ManagedAgents}=require('../dist/managed-agents');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('a managed submitted turn reports waiting while approval is pending',async t=>{
 const directory=await fs.mkdtemp('/tmp/vta-final-'),mailbox=new Mailbox(directory),client=new EventEmitter();
 client.endpoint='unix:///tmp/fake.sock';client.closed=false;client.canWake=()=>true;
 client.close=async()=>{client.closed=true;};const threadId=randomUUID();let turnId;
 client.request=async(method)=>{
  if(method==='thread/name/set')return {};
  if(method==='thread/start'||method==='thread/read')return {thread:{id:threadId,status:{type:'idle'}}};
  if(method==='turn/start'){
   turnId=randomUUID();client.emit('notification',{method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});
   return {turn:{id:turnId,status:'inProgress'}};
  }
  throw Error(method);
 };
 const manager=new ManagedAgents({windowId:randomUUID(),directory,mailbox,cliPath:'/tmp/cli.js',intervalMs:0,
  resolveNode:async()=>'/verified/node',createClient:async()=>client,createTerminal:()=>({id:randomUUID(),dispose(){}})});
 t.after(async()=>{await manager.dispose();await fs.rm(directory,{recursive:true,force:true});});
 const agent=await manager.start({requestId:randomUUID(),name:'fixture',cwd:directory});
 for(let n=0;n<100&&manager.status(agent.id).state==='starting';n++)await tick();
 const from=randomUUID();await mailbox.register(from,'peer');
 await mailbox.send({id:randomUUID(),from,to:agent.id,text:'fixture'});await manager.poll();
 assert.equal(manager.status(agent.id).state,'working');
 client.emit('serverRequest',{method:'item/commandExecution/requestApproval',params:{threadId,turnId}});
 client.emit('notification',{method:'thread/status/changed',params:{threadId,status:{type:'active',activeFlags:['waitingOnApproval']}}});
 assert.equal(manager.status(agent.id).state,'waiting');
});
