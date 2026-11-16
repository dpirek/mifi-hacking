'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createManager } = require('../server');
async function setup(t, options = {}) {
 const origin=options.origin || 'http://localhost:3000';
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'mifi-manager-test-'));
 const server=await createManager({password:'test password 12345',origin,dataDir,pollMs:options.pollMs ?? 80,commandMs:options.commandMs ?? 350});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 let cookie='';
 async function request(route,method='GET',body,headers={}) {
  const response=await fetch(base+route,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json(),headers:response.headers};
 }
 const login=await request('/api/login','POST',{password:'test password 12345'});cookie=login.headers.get('set-cookie').split(';')[0];
 return {request,dataDir,cookie,base};
}
test('authentication, origin isolation, persistent hashed pairing, rotation and revocation',async t=>{
 const {request,dataDir,cookie}=await setup(t);
 assert.equal((await request('/api/routers','GET',undefined,{Cookie:''})).status,401);
 assert.equal((await request('/api/routers','POST',{name:'router'},{Origin:'https://attacker.example'})).status,403);
 assert.equal((await request('/api/login','POST',{password:'wrong'})).status,401);
 const paired=await request('/api/routers','POST',{name:'Travel <MiFi>'});assert.equal(paired.status,201);assert.equal(paired.body.token.length,64);
 assert(!fs.readFileSync(path.join(dataDir,'routers.json'),'utf8').includes(paired.body.token));
 const list=await request('/api/routers');assert(!JSON.stringify(list.body).includes('tokenHash'));assert.equal(list.body[0].name,'Travel <MiFi>');
 const rotate=await request(`/api/routers/${paired.body.id}/rotate`,'POST',{});assert.equal(rotate.body.token.length,64);
 assert.equal((await request('/api/agent/poll','POST',{}, {Authorization:'Bearer '+paired.body.token})).status,401);
 assert.equal((await request('/api/agent/poll','POST',{}, {Authorization:'Bearer '+rotate.body.token})).body.idle,true);
 assert.equal((await request(`/api/routers/${paired.body.id}`,'DELETE')).status,200);
 assert.equal((await request('/api/agent/poll','POST',{}, {Authorization:'Bearer '+rotate.body.token})).status,401);
 assert.equal((await request('/api/logout','POST',{})).status,200);
 assert.equal((await request('/api/routers','GET',undefined,{Cookie:cookie})).status,401);
});
test('outbound relay, ownership checks, allowlist, validation, single delivery and bounded timeouts',async t=>{
 const {request}=await setup(t);
 const first=(await request('/api/routers','POST',{name:'First'})).body;
 const second=(await request('/api/routers','POST',{name:'Second'})).body;
 const auth={Authorization:'Bearer '+first.token};
 const route=`/api/routers/${first.id}/commands`;
 assert.equal((await request(route,'POST',{action:'status'})).status,409);
 const poll=request('/api/agent/poll','POST',{},auth);await new Promise(r=>setTimeout(r,20));
 assert.equal((await request(route,'POST',{action:'shell',args:{command:'rm -rf /'}})).status,400);
 assert.equal((await request(route,'POST',{action:'interface.restart',args:{name:'lan;reboot'}})).status,400);
 assert.equal((await request(route,'POST',{action:'sms.send',args:{number:'123,number=456',text:'hello'}})).status,400);
 const response=request(route,'POST',{action:'status',args:{}});
 const delivered=await poll;assert.equal(delivered.body.action,'status');
 assert.equal((await request(route,'POST',{action:'status'})).status,409);
 assert.equal((await request('/api/agent/result','POST',{id:delivered.body.id,result:{}},{Authorization:'Bearer '+second.token})).status,409);
 assert.equal((await request('/api/agent/result','POST',{id:delivered.body.id,result:{model:'MF68E'}},auth)).status,200);
 assert.equal((await response).body.result.model,'MF68E');
 assert.equal((await request('/api/agent/result','POST',{id:delivered.body.id,result:{}},auth)).status,409);
 const pending=request(route,'POST',{action:'sms.send',args:{number:'+15551234',text:'你好, "test"\nnext line'}});
 const sms=await request('/api/agent/poll','POST',{},auth);assert.equal(sms.body.action,'sms.send');
 const timeout=await pending;assert.equal(timeout.status,504);assert.match(timeout.body.error,/not be retried/);
 assert.equal((await request('/api/agent/poll','POST',{},auth)).body.idle,true);
 assert.equal((await request('/api/agent/result','POST',{id:sms.body.id,result:{}},auth)).status,409);
});
test('static app security headers and HTTPS cookie configuration',async t=>{
 const {base}=await setup(t);
 const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await page.text(),/MiFi/);
 assert.equal((await fetch(base+'/server.js')).status,401);
 await assert.rejects(createManager({password:'short'}));
});

test('HTTPS mode uses Secure, HttpOnly, SameSite cookies',async t=>{
 const {request}=await setup(t,{origin:'https://mifi.example'});
 const response=await request('/api/login','POST',{password:'test password 12345'});
 assert.equal(response.status,200);
 const cookie=response.headers.get('set-cookie');
 assert.match(cookie,/; Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
});

test('device removal revokes polls and pending commands and persists without affecting other devices',async t=>{
 const {request,dataDir}=await setup(t,{pollMs:2000,commandMs:2000});
 const removed=(await request('/api/routers','POST',{name:'Remove me'})).body;
 const kept=(await request('/api/routers','POST',{name:'Keep me'})).body;
 const endpoint=`/api/routers/${removed.id}`;
 const auth={Authorization:'Bearer '+removed.token};
 assert.equal((await request(endpoint,'DELETE',undefined,{Cookie:''})).status,401);
 assert.equal((await request(endpoint,'DELETE',undefined,{Origin:'https://attacker.example'})).status,403);
 const firstPoll=request('/api/agent/poll','POST',{},auth);
 await new Promise(r=>setTimeout(r,20));
 const pending=request(endpoint+'/commands','POST',{action:'status'});
 const delivered=await firstPoll;
 assert.equal(delivered.body.action,'status');
 const waitingPoll=request('/api/agent/poll','POST',{},auth);
 await new Promise(r=>setTimeout(r,20));
 assert.equal((await request(endpoint,'DELETE')).status,200);
 assert.equal((await waitingPoll).status,401);
 assert.equal((await pending).status,409);
 assert.equal((await request('/api/agent/result','POST',{id:delivered.body.id,result:{}},auth)).status,401);
 assert.equal((await request('/api/agent/poll','POST',{},auth)).status,401);
 assert.equal((await request(endpoint,'DELETE')).status,404);
 assert.equal((await request(endpoint+'/commands','POST',{action:'status'})).status,404);
 assert.deepEqual((await request('/api/routers')).body.map(r=>r.id),[kept.id]);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir,'routers.json'),'utf8')).map(r=>r.id),[kept.id]);
});

test('voice call relay validates arguments and forwards each control once',async t=>{
 const {request}=await setup(t);
 const router=(await request('/api/routers','POST',{name:'Call test'})).body;
 const auth={Authorization:'Bearer '+router.token};
 const route=`/api/routers/${router.id}/commands`;
 await request('/api/agent/poll','POST',{},auth);
 for(const value of [
  {action:'calls.dial',args:{number:'1,number=2'}},
  {action:'calls.dial',args:{number:123}},
  {action:'calls.answer',args:{id:'7',expected:'terminated'}},
  {action:'calls.reject',args:{id:'7;reboot',expected:'ringing-in'}},
  {action:'calls.hangup',args:{id:'7'}}
 ])assert.equal((await request(route,'POST',value)).status,400);
 for(const [action,args] of [
  ['calls.list',{}],['calls.dial',{number:'+15551234'}],
  ['calls.answer',{id:'7',expected:'ringing-in'}],
  ['calls.reject',{id:'7',expected:'ringing-in'}],
  ['calls.hangup',{id:'7',expected:'active'}]
 ]){
  const poll=request('/api/agent/poll','POST',{},auth);
  const pending=request(route,'POST',{action,args});
  const job=(await poll).body;assert.equal(job.action,action);assert.deepEqual(job.args,args);
  await request('/api/agent/result','POST',{id:job.id,result:action==='calls.list'?{calls:[],supported:true,browser_audio:false}:{ok:true,id:'7'}},auth);
  assert.equal((await pending).status,200);
 }
 assert.equal((await request('/api/agent/poll','POST',{},auth)).body.idle,true);
});
