'use strict';
const $ = id => document.getElementById(id);
const callDrafts = new Map();
let routers = [], selected = null, tab = 'status', busy = false, currentView = 0;
function el(tag, text, attrs = {}) { const e = document.createElement(tag); if (text != null) e.textContent = text; for (const [k,v] of Object.entries(attrs)) e.setAttribute(k,v); return e; }
function button(text, action, cls) { const b = el('button',text,cls ? {class:cls} : {}); b.type='button'; b.addEventListener('click',action); return b; }
function feedback(message, error=false) { $('feedback').textContent=message; $('feedback').classList.toggle('error',error); }
async function api(url, method='GET', value) {
 const response = await fetch(url,{method,headers:{'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
 const result = await response.json();
 if(!response.ok) { if(response.status===401) showLogin(); throw new Error(result.error||'Request failed'); }
 return result;
}
function showLogin(){ callDrafts.clear(); $('app-header').hidden=true; $('login').hidden=false; $('app').hidden=true; $('logout').hidden=true; $('device-controls').hidden=true; selected=null; currentView++; }
async function refreshRouters(){
 routers=await api('/api/routers');
 const autoSelect=!selected&&!busy&&routers.length>0;
 if(autoSelect)selected=routers[0].id;
 $('app-header').hidden=false; $('login').hidden=true; $('app').hidden=false; $('logout').hidden=false;
 renderDeviceSelection();
 if(autoSelect)await loadView();
}
function renderDeviceSelection(){
 $('device-controls').hidden=false;
 if(selected&&!routers.some(r=>r.id===selected)){selected=null;currentView++;$('content').replaceChildren();}
 $('routers').replaceChildren(el('option',routers.length?'Select a device':'No paired devices',{value:'',disabled:''}),...routers.map(r=>el('option',`${r.name} · ${r.online?'Connected':'Offline'}`,{value:r.id})));
 $('routers').value=selected||'';
 const r=routers.find(r=>r.id===selected);
 $('router-name').textContent=r?r.name:'Select a device';
 $('connection').textContent=r?(r.online?'Connected · outbound relay active':r.lastSeen?'Offline · last seen '+new Date(r.lastSeen).toLocaleString():'Waiting for pairing'):'Pair a device to get started.';
 $('refresh').disabled=busy||!r;
 $('remove-device').hidden=!r;
 $('remove-device').disabled=busy||!r;
 setControls();
}
function refreshRouterList(){return refreshRouters().catch(e=>feedback(e.message,true));}
async function command(action,args={}){
 const response=await api(`/api/routers/${selected}/commands`,'POST',{action,args});
 if(response.result?.error)throw new Error(response.result.error);
 return response.result;
}
async function perform(fn){
 if(busy)return;busy=true;setControls();feedback('Contacting router…');
 try{await fn();}catch(e){feedback(e.message+' Requests are never retried automatically.',true);}finally{busy=false;setControls();}
}
function setControls(){document.querySelectorAll('#tabs button,#content button,#refresh,#remove-device,#routers').forEach(b=>{b.disabled=busy;});document.querySelectorAll('#tabs button').forEach(b=>{b.disabled=busy||!selected;});$('routers').disabled=busy||!routers.length;$('refresh').disabled=busy||!selected;$('remove-device').disabled=busy||!selected;}
async function removeDevice(){
 const router=routers.find(r=>r.id===selected);
 if(busy||!router)return;
 if(!confirm(`Remove device “${router.name}”? Its pairing token will be revoked immediately. To reconnect it, pair it again.`))return;
 await perform(async()=>{
  await api(`/api/routers/${router.id}`,'DELETE');
  selected=null;currentView++;
  $('content').replaceChildren(el('p','Device removed. Select another router or pair a device to get started.'));
  await refreshRouters();
  feedback(`Device “${router.name}” removed. Its access has been revoked.`);
 });
}
function metric(label,value){const e=el('div',null,{class:'metric'});e.append(el('span',label),el('strong',value??'Unavailable'));return e;}
function uptime(seconds){const n=Number(seconds)||0;return `${Math.floor(n/86400)}d ${Math.floor(n%86400/3600)}h ${Math.floor(n%3600/60)}m`;}
function row(title,lines,controls=[]){const r=el('article',null,{class:'row'}),info=el('div');info.append(el('h3',title));lines.filter(Boolean).forEach(line=>info.append(el('p',line)));r.append(info);if(controls.length){const a=el('div',null,{class:'actions'});a.append(...controls);r.append(a);}return r;}
async function loadView(){
 if(!selected)return;
 const view=++currentView;
 document.querySelectorAll('#tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===tab)));
 await perform(async()=>{
  const content=$('content');
  if(tab==='settings'){
   content.replaceChildren(el('h3','Connection access'),el('p','Rotate the pairing token to revoke the old token, then enter the new one on the router. Removing a router immediately revokes its token.'));
   content.append(button('Rotate pairing token',()=>perform(async()=>{
    if(!confirm('Revoke the existing token? The router will disconnect until you enter the new token.'))return;
    const result=await api(`/api/routers/${selected}/rotate`,'POST',{});showPair(result.token);feedback('Old token revoked.');await refreshRouters();
   })),button('Remove device',removeDevice,'danger'));
  }else if(tab==='status'){
   const result=await command('status');if(view!==currentView)return;
   const board=result.board||{},system=result.system||{},memory=system.memory||{};
   const metrics=el('div',null,{class:'metrics'});
   metrics.append(metric('Device',board.model||board.system),metric('Hostname',board.hostname),metric('Firmware',board.release?.description),metric('Uptime',uptime(system.uptime)),metric('Available memory',memory.available?`${Math.round(memory.available/1048576)} MB`:'Unavailable'),metric('Kernel',board.kernel));content.replaceChildren(metrics);
  }else if(tab==='interfaces'){
   const result=await command('interfaces');if(view!==currentView)return;
   const list=(result.interface||[]).filter(n=>n.interface!=='loopback');
   content.replaceChildren(...list.map(n=>row(n.interface,[`${n.up?'Connected':'Down'} · ${n.proto||'No protocol'} · ${n.l3_device||n.device||'No device'}`,(n['ipv4-address']||[]).map(a=>`${a.address}/${a.mask}`).join(', '),n.uptime?'Uptime '+uptime(n.uptime):null],[button('Restart',()=>perform(async()=>{
    if(!confirm(`Restart ${n.interface}? The remote connection may briefly disconnect.`))return;
    await command('interface.restart',{name:n.interface});feedback('Restart requested. Refresh to check the interface.');
   }))])));
   if(!list.length)content.append(el('p','No interfaces reported.'));
  }else if(tab==='wireless'){
   const result=await command('wireless');if(view!==currentView)return;
   content.replaceChildren(...Object.entries(result).map(([name,radio])=>row(name,[`${radio.up?'Enabled':'Stopped'} · ${radio.config?.band||radio.config?.hwmode||'Wireless radio'} · Channel ${radio.config?.channel||'auto'}`,...(radio.interfaces||[]).map(i=>`${i.config?.ssid||i.ifname} · ${i.config?.encryption||'Unknown encryption'}`)],[button(radio.up?'Stop radio':'Start radio',()=>perform(async()=>{
    if(!confirm(`${radio.up?'Stop':'Start'} ${name}? Wireless clients may disconnect. This changes runtime state only.`))return;
    await command(radio.up?'wireless.down':'wireless.up',{name});feedback('Radio change requested. Refresh to check its state.');
   }))])));
   if(!Object.keys(result).length)content.append(el('p','No wireless radios reported.'));
  }else if(tab==='calls'){
   const result=await command('calls.list');if(view!==currentView)return;
   if(!Array.isArray(result.calls))throw new Error('Invalid call list');
   const oldNumber=document.getElementById('call-number');
   const restoreFocus=oldNumber&&document.activeElement===oldNumber;
   const cursor=restoreFocus?[oldNumber.selectionStart,oldNumber.selectionEnd]:null;
   const notice=el('p','Call controls only. Browser microphone and speaker audio are unavailable. Carrier voice/VoLTE support is required.',{class:'call-notice'});
   const form=el('form',null,{class:'section'}),number=el('input',null,{id:'call-number',type:'tel',required:'',placeholder:'+1234567890',pattern:'\\+?[0-9]{1,20}',maxlength:'21'});
   number.value=callDrafts.get(selected)||'';const owner=selected;
   number.addEventListener('input',()=>callDrafts.set(owner,number.value));
   form.append(el('h3','Dial a number'),el('label','Phone number',{for:'call-number'}),number,el('button','Call',{type:'submit',class:'primary'}));
   form.addEventListener('submit',e=>{e.preventDefault();perform(async()=>{
    if(!/^\+?[0-9]{1,20}$/.test(number.value.trim()))throw new Error('Enter a valid phone number');
    if(!confirm(`Call ${number.value.trim()}? Carrier charges may apply. Browser audio is unavailable.`))return;
    const response=await command('calls.dial',{number:number.value.trim()});if(!response?.ok)throw new Error('Dialing was not confirmed. Refresh before trying again.');
    feedback('Dialing requested. Refresh to check the call; it will not be retried.');
   });});
   const ringing=result.calls.filter(c=>c.direction==='incoming'&&['ringing-in','waiting'].includes(c.state));
   const banner=el('p',ringing.length?'Incoming call: '+ringing.map(c=>c.number&&c.number!=='--'?c.number:'Private or unknown number').join(', '):'No incoming call',{role:'status','aria-live':'polite',class:ringing.length?'call-incoming':'muted'});
   content.replaceChildren(notice,banner,form,el('h3','Call activity'));
   if(restoreFocus){number.focus({preventScroll:true});number.setSelectionRange(cursor[0],cursor[1]);}
   if(result.partial)content.append(el('p','Some call details are unavailable. Refresh before using controls.'));
   for(const call of result.calls){
    const incoming=call.direction==='incoming'&&['ringing-in','waiting'].includes(call.state);
    const active=['dialing','ringing-in','ringing-out','waiting','active','held'].includes(call.state);
    const act=method=>perform(async()=>{
     if(method==='answer'&&!confirm('Answer this call? Browser audio is unavailable.'))return;
     const response=await command('calls.'+method,{id:call.id,expected:call.state});
     if(!response?.ok)throw new Error('Call action was not confirmed. Refresh before trying again.');
     feedback(method==='answer'?'Answer requested. Browser audio is unavailable.':'Call action completed. Refresh to check its state.');
    });
    const controls=incoming?[button('Answer',()=>act('answer'),'primary'),button('Reject',()=>act('reject'),'danger')]:active?[button('Hang up',()=>act('hangup'),'danger')]:[];
    content.append(row(call.number&&call.number!=='--'?call.number:'Private or unknown number',[`${call.direction||'Unknown direction'} · ${call.state||'Unknown state'}`,call.reason&&call.reason!=='--'?call.reason:null],controls));
   }
   if(!result.calls.length)content.append(el('p','No calls. This page checks for incoming calls every 5 seconds while open.'));
  }else if(tab==='sms'){
   const result=await command('sms.list');if(view!==currentView)return;
   const paths=result['modem.messaging.sms']||result.modem?.messaging?.sms||[];
   const inbox=el('section',null,{class:'section'});inbox.append(el('h3','Messages'));
   paths.forEach(path=>{const match=/\/SMS\/([0-9]+)$/.exec(typeof path==='string'?path:path.path||'');if(!match)return;
    const item=row('Message '+match[1],[],[button('Read message',()=>perform(async()=>{
     const data=await command('sms.read',{id:match[1]}),sms=data.sms||{};
     const message=el('div',null,{class:'message'});message.append(el('strong',sms.content?.number||'Unknown sender'),el('p',sms.properties?.state||''),el('div',sms.content?.text||'No text content'));item.replaceChildren(message);feedback('Message loaded.');
    }))]);inbox.append(item);
   });if(!paths.length)inbox.append(el('p','No messages.'));
   const form=el('form',null,{class:'section'}),number=el('input',null,{id:'sms-number',type:'tel',required:'',placeholder:'+1234567890',pattern:'\\+?[0-9]{1,20}'}),text=el('textarea',null,{id:'sms-text',required:''});
   const send=el('button','Send SMS',{type:'submit',class:'primary'});
   form.append(el('h3','New message'),el('label','Recipient',{for:'sms-number'}),number,el('label','Message',{for:'sms-text'}),text,el('p','Long messages may use multiple SMS and incur carrier charges.',{class:'muted'}),send);
   form.addEventListener('submit',e=>{e.preventDefault();perform(async()=>{
    if(new TextEncoder().encode(text.value).length>4096)throw new Error('Message exceeds 4096 bytes');
    if(!confirm(`Send this SMS to ${number.value}? Carrier charges may apply.`))return;
    await command('sms.send',{number:number.value,text:text.value});text.value='';feedback('Sent to the network. Delivery to the recipient is not confirmed. Refresh the inbox to see its state.');
   });});content.replaceChildren(form,inbox);
  }
  if(!['settings'].includes(tab))feedback('Updated '+new Date().toLocaleTimeString());else feedback('Manage this router’s connection.');
 });
}
function showPair(token){$('copy-token').textContent='Copy token';$('pair-form').hidden=true;$('pair-result').hidden=false;$('pair-server').value=location.origin;$('pair-token').value=token;$('pair-error').textContent='';if(!$('pair-dialog').open)$('pair-dialog').showModal();}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await api('/api/login','POST',{password:$('password').value});$('password').value='';$('login-error').textContent='';await refreshRouters();}catch(e){$('login-error').textContent=e.message;}finally{b.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await api('/api/logout','POST',{});}finally{showLogin();}});
$('add-router').addEventListener('click',()=>{$('pair-form').hidden=false;$('pair-result').hidden=true;$('pair-error').textContent='';$('router-label').value='';$('pair-dialog').showModal();});
$('close-pair').addEventListener('click',()=>$('pair-dialog').close());
$('done-pair').addEventListener('click',()=>{$('pair-dialog').close();$('pair-token').value='';refreshRouterList();});
$('pair-dialog').addEventListener('close',()=>{$('pair-token').value='';});
$('copy-token').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('pair-token').value);$('copy-token').textContent='Copied';}catch{$('pair-token').select();$('pair-error').textContent='Select and copy the token manually.';}});
$('pair-form').addEventListener('submit',async e=>{e.preventDefault();e.submitter.disabled=true;try{const r=await api('/api/routers','POST',{name:$('router-label').value});selected=r.id;showPair(r.token);await refreshRouters();}catch(e){$('pair-error').textContent=e.message;}finally{e.submitter.disabled=false;}});
$('tabs').addEventListener('click',e=>{const target=e.target.closest('button[data-tab]');if(target&&!busy){tab=target.dataset.tab;loadView();}});
$('routers').addEventListener('change',()=>{if(busy)return;selected=$('routers').value||null;renderDeviceSelection();loadView();});
$('refresh').addEventListener('click',loadView);
$('remove-device').addEventListener('click',removeDevice);
refreshRouterList();setInterval(()=>{if(!$('app').hidden&&!busy)refreshRouterList();},15000);

setInterval(()=>{if(tab==='calls'&&selected&&!busy&&!$('app').hidden&&!document.hidden&&!$('pair-dialog').open)loadView();},5000);
