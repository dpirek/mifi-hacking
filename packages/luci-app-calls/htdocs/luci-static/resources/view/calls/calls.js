'use strict';
'require view';
'require rpc';
'require poll';
var list=rpc.declare({object:'calls',method:'list'});
var dial=rpc.declare({object:'calls',method:'dial',params:['number']});
var actions={};
['answer','reject','hangup'].forEach(function(method){actions[method]=rpc.declare({object:'calls',method:method,params:['id','expected']});});
function checked(result){if(!result||result.error)throw new Error(result&&result.error||_('No response from call service'));return result;}
return view.extend({
 render:function(){
  var busy=false,loading=false,ready=false,rows=[];
  var status=E('p',{'role':'status','aria-live':'polite'},_('Checking voice support…'));
  var feedback=E('p',{'role':'status','aria-live':'polite'});
  var incoming=E('p',{'role':'status','aria-live':'assertive','hidden':true});
  var calls=E('div');
  var number=E('input',{id:'call-number',type:'tel',placeholder:'+1234567890',maxlength:21,autocomplete:'tel'});
  var controls=[];
  function button(label,handler,cls){var b=E('button',{type:'button',class:'cbi-button '+(cls||''),click:handler},label);controls.push(b);return b;}
  function update(){controls.forEach(function(b){b.disabled=busy||!L.hasViewPermission();});refreshButton.disabled=busy||loading;dialButton.disabled=busy||!ready||!/^\+?[0-9]{1,20}$/.test(number.value.trim())||!L.hasViewPermission();number.disabled=busy;}
  async function refresh(){
   if(busy||loading){return;}
   loading=true;refreshButton.disabled=true;
   try{
    var result=checked(await list());if(!Array.isArray(result.calls))throw new Error(_('Invalid call list'));
    ready=true;rows=result.calls;controls=[refreshButton,dialButton];
    var ringing=rows.filter(function(c){return c.direction==='incoming'&&(c.state==='ringing-in'||c.state==='waiting');});
    incoming.hidden=!ringing.length;
    incoming.textContent=ringing.length?_('Incoming call: ')+ringing.map(function(c){return c.number&&c.number!=='--'?c.number:_('Private or unknown number');}).join(', '):'';
    incoming.className='alert-message notice';
    status.textContent=result.partial?_('Some call details could not be loaded. Refresh before using controls.'):_('Voice controls available · updates every 3 seconds');
    calls.replaceChildren.apply(calls,rows.length?rows.map(function(c){
     var canAnswer=c.direction==='incoming'&&(c.state==='ringing-in'||c.state==='waiting');
     var active=['dialing','ringing-in','ringing-out','waiting','active','held'].indexOf(c.state)>=0;
     var buttons=[];
     function act(method){return perform(async function(){
      if(method==='answer'&&!window.confirm(_('Answer this call? Browser audio is unavailable.')))return;
      var result=checked(await actions[method](c.id,c.state));if(!result.ok)throw new Error(_('Call action was not confirmed. Refresh before trying again.'));
      feedback.textContent=method==='answer'?_('Answer requested. Browser audio is unavailable.'):_('Call action completed.');
     });}
     if(canAnswer){buttons.push(button(_('Answer'),function(){return act('answer');},'cbi-button-action'));buttons.push(button(_('Reject'),function(){return act('reject');},'cbi-button-negative'));}
     else if(active)buttons.push(button(_('Hang up'),function(){return act('hangup');},'cbi-button-negative'));
     return E('article',{class:'cbi-section'},[E('h3',{},c.number&&c.number!=='--'?c.number:_('Private or unknown number')),E('p',{},(c.direction||_('Unknown direction'))+' · '+(c.state||_('Unknown state'))),E('p',{},c.reason&&c.reason!=='--'?c.reason:''),E('div',{class:'call-actions'},buttons)]);
    }):[E('p',{},_('No calls. Incoming calls will appear here while this page is open.'))]);
   }catch(e){ready=false;incoming.hidden=true;controls=[refreshButton,dialButton];calls.replaceChildren(E('p',{},_('Call details unavailable.')));status.textContent=_('Voice unavailable: ')+e.message;}
   finally{loading=false;update();}
  }
  async function perform(action){
   if(busy)return;busy=true;update();
   try{await action();}catch(e){feedback.textContent=e.message+' '+_('The action was not retried. Refresh before trying again.');}
   finally{busy=false;update();await refresh();}
  }
  var refreshButton=button(_('Refresh calls'),refresh);
  var dialButton=button(_('Call'),function(){return perform(async function(){
   var target=number.value.trim();if(!/^\+?[0-9]{1,20}$/.test(target))throw new Error(_('Enter a valid phone number'));
   if(!window.confirm(_('Call ')+target+_('? Carrier charges may apply. Browser audio is unavailable.')))return;
   var result=checked(await dial(target));if(!result.ok)throw new Error(_('Dialing was not confirmed. Refresh before trying again.'));
   feedback.textContent=_('Dialing requested. Use Hang up to end the call.');
  });},'cbi-button-action');
  number.addEventListener('input',update);
  poll.add(refresh,3);refresh();update();
  return E('div',{},[E('h2',{},_('Calls')),E('p',{class:'alert-message warning'},_('Call controls only. This router has no working audio path; answering or dialing does not provide microphone or speaker audio in your browser. Carrier voice/VoLTE support is required.')),incoming,E('section',{class:'cbi-section'},[E('h3',{},_('Dial a number')),E('label',{'for':'call-number'},_('Phone number')),E('div',{class:'call-actions'},[number,dialButton]),feedback]),E('section',{class:'cbi-section'},[E('h3',{},_('Call activity')),refreshButton,status,calls]),E('style',{},'.call-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.call-actions input{min-width:0;max-width:100%}')]);
 },handleSaveApply:null,handleSave:null,handleReset:null
});
