'use strict';
'require view';
'require rpc';
'require poll';
var status = rpc.declare({object:'mifi-remote',method:'status'});
var configure = rpc.declare({object:'mifi-remote',method:'configure',params:['server','token','enabled']});
return view.extend({
 load: function() { return status().catch(function(e) { return {error:e.message}; }); },
 render: function(data) {
  var busy=false;
  var server=E('input',{id:'remote-server',type:'url',style:'width:100%',placeholder:'https://mifi.bohoosh.com',value:data.server||'https://mifi.bohoosh.com'});
  var token=E('input',{id:'remote-token',type:'password',autocomplete:'new-password',style:'width:100%',placeholder:data.token_set?_('Token saved; leave blank to keep it'):_('Paste pairing token'),maxlength:64});
  var enabled=E('input',{id:'remote-enabled',type:'checkbox',checked:!!data.enabled});
  var state=E('p',{'role':'status','aria-live':'polite'},data.error||data.message||_('Not connected'));
  var feedback=E('p',{'role':'status','aria-live':'polite'});
  var button=E('button',{type:'button',class:'cbi-button cbi-button-action',disabled:!L.hasViewPermission(),click:async function(){
   if(busy)return;busy=true;button.disabled=true;feedback.textContent=_('Saving…');
   try {
    var result=await configure(server.value.trim().replace(/\/$/,''),token.value.trim(),enabled.checked);
    if(!result||result.error)throw new Error(result&&result.error||_('No response'));
    token.value='';token.placeholder=_('Token saved; leave blank to keep it');
    feedback.textContent=_('Saved. The router will connect when internet access is available.');
    await refresh();
   }catch(e){feedback.textContent=e.message;}finally{busy=false;button.disabled=!L.hasViewPermission();}
  }},_('Save connection'));
  async function refresh(){try{var result=await status();state.textContent=result.error||result.state+': '+result.message;}catch(e){state.textContent=e.message;}}
  poll.add(refresh,10);
  return E('div',{},[E('h2',{},_('Remote management')),E('section',{class:'cbi-section'},[
   E('h3',{},_('Connect to your management server')),
   E('p',{},_('Sign in to the management app, add this router, and paste its pairing token below. The router connects outward over HTTPS; no port forwarding is required.')),
   E('p',{},[E('label',{'for':'remote-server'},_('Management server')),E('br'),server]),
   E('p',{},[E('label',{'for':'remote-token'},_('Pairing token')),E('br'),token]),
   E('p',{},[enabled,' ',E('label',{'for':'remote-enabled'},_('Enable remote management'))]),
   E('p',{},_('The management server can read system, network and SMS data, send SMS, restart interfaces and start or stop wireless radios. Disabling this connection stops remote access.')),
   state,button,feedback
  ])]);
 },handleSaveApply:null,handleSave:null,handleReset:null
});
