const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./helpers.cjs');
const {discover,request}=require('../dist/transport');
test('extension launches native remote Codex terminals and refuses unmanaged/remote automatic control',async t=>{
 const directory=await fs.mkdtemp('/tmp/vta-ext-'),previous=process.env.VSCODE_TERMINAL_BRIDGE_DIR;
 process.env.VSCODE_TERMINAL_BRIDGE_DIR=directory;
 const f=fixture(),created=[],clients=[];
 const create=f.window.createTerminal.bind(f.window);f.window.createTerminal=options=>{created.push(options);return create(options);};
 f.window.createOutputChannel=()=>({appendLine(){},dispose(){}});
 const api={window:f.window,env:{},workspace:{isTrusted:true,workspaceFolders:[]},commands:{registerCommand:()=>({dispose(){}})}};
 const fake={start:async()=>{const c=new EventEmitter();c.endpoint='unix:///tmp/owned';c.closed=false;
  c.canWake=()=>true; c.request=async()=>({thread:{id:randomUUID(),status:{type:'idle'}}});c.close=async()=>{c.closed=true;};clients.push(c);return c;}};
 const original=Module._load;let extension;
 try{Module._load=function(name,...args){return name==='vscode'?api:name==='./codex-client'?{CodexClient:fake}:original.call(this,name,...args);};extension=require('../dist/extension');}
 finally{Module._load=original;}
 t.after(async()=>{await extension.deactivate();if(previous===undefined)delete process.env.VSCODE_TERMINAL_BRIDGE_DIR;else process.env.VSCODE_TERMINAL_BRIDGE_DIR=previous;await fs.rm(directory,{recursive:true,force:true});});
 await extension.activate({subscriptions:[]});const [window]=await discover(directory);
 const agent=await request(window.id,'agent.start',{name:'Managed Codex',cwd:directory,requestId:randomUUID()},directory);
 assert.equal(agent.state,'starting');
 let status;for(let n=0;n<100;n++){status=await request(window.id,'agent.status',{id:agent.id},directory);if(status.state==='idle')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(status.state,'idle');assert.equal(created[0].shellPath,'codex');
 assert.deepEqual(created[0].shellArgs,['-c','check_for_update_on_startup=false','--remote','unix:///tmp/owned','resume',status.threadId]);
 assert.deepEqual(f.terminals[0].sent,[],'no untracked terminal input');
 assert.equal((await request(window.id,'terminal.list',{},directory))[0].id,status.terminalId);
 api.env.remoteName='ssh-remote';
 await assert.rejects(request(window.id,'agent.start',{name:'Remote',cwd:directory,requestId:randomUUID()},directory),{code:'REMOTE_AGENT_UNSUPPORTED'});
 api.env.remoteName=undefined;
 await assert.rejects(request(window.id,'agent.status',{id:randomUUID()},directory),{code:'MANAGED_AGENT_NOT_FOUND'});
 await request(window.id,'agent.stop',{id:agent.id},directory);assert.equal(clients[0].closed,true);assert.equal(f.terminals.length,0);
});
