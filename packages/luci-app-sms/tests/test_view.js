const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
function assert(value, message) { if (!value) throw new Error(message); }
class Element {
 constructor(tag, attrs, children) { this.tag = tag; this.attrs = attrs || {}; this.children = Array.isArray(children) ? children : [children || '']; this.value = ''; this.disabled = !!this.attrs.disabled; this.textContent = ''; this.events = {}; }
 addEventListener(name, cb) { this.events[name] = cb; }
 replaceChildren(...children) { this.children = children; }
}
let nodes = [];
function E(tag, attrs, children) { let e = new Element(tag, attrs, children); nodes.push(e); return e; }
let mode = 'ok', sent = 0, polls = [];
let rpc = { declare: spec => async (...args) => {
 if (spec.method === 'list') { if(mode === 'offline') return {error:'modem not enabled yet'}; return {'modem.messaging.sms':['/org/freedesktop/ModemManager1/SMS/12']}; }
 if (spec.method === 'read') return {sms:{content:{number:'+15551234', text:'<script>alert(1)</script>\n你好'}, properties:{state:'received',timestamp:'2026-11-15'}}};
 sent++; if(mode === 'fail') return {error:'Timed out; check state'}; return {ok:true,id:'13'};
} };
let source = ByteArray.toString(GLib.file_get_contents('packages/luci-app-sms/htdocs/luci-static/resources/view/sms/messages.js')[1]);
let screen = new Function('view','rpc','poll','ui','E','_','L',source)({extend:x=>x},rpc,{add:cb=>polls.push(cb)},{},E,x=>x,{hasViewPermission:()=>true});
let root = screen.render();
let loop = new GLib.MainLoop(null,false);
(async () => {
 // Wait for initial list/read microtasks.
 await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
 let recipient = nodes.find(e=>e.attrs.id==='sms-number');
 let body = nodes.find(e=>e.attrs.id==='sms-text');
 let button = nodes.find(e=>e.tag==='button' && e.children[0]==='Send SMS');
 let refresh = nodes.find(e=>e.tag==='button' && e.children[0]==='Refresh messages');
 assert(nodes.some(e=>e.children.includes('<script>alert(1)</script>\n你好')), 'SMS must render as text');
 recipient.value='+15551234'; body.value='Hello'; body.events.input();
 assert(!button.disabled, 'valid message can send');
 recipient.value='1,number=2'; recipient.events.input(); assert(button.disabled,'reject property injection');
 recipient.value='+15551234'; body.value='😀'.repeat(1100); body.events.input(); assert(button.disabled,'limit UTF8 bytes');
 body.value='你好, \"quoted\"'; body.events.input(); mode='fail';
 await button.attrs.click(); assert(body.value.length>0,'retain draft after failure'); assert(sent===1,'no automatic retry');
 mode='ok'; await button.attrs.click(); assert(body.value==='','clear draft only after success'); assert(sent===2,'send once');
 mode='offline'; await refresh.attrs.click(); assert(button.disabled,'disable sending when modem unavailable');
 assert(nodes.some(e=>e.children.some(c=>typeof c==='string' && c.includes('modem not enabled yet'))),'show modem errors');
 print('PASS: rendering, safe text, validation, UTF8 limit, send success/failure, no retries, offline state');
 loop.quit();
})().catch(e=>{printerr(e.stack); imports.system.exit(1);});
loop.run();
