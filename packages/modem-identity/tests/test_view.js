// Run with node. RPC, timers and DOM are isolated from hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname,
    '../../luci-app-modem-identity/htdocs/luci-static/resources/view/modem-identity/config.js'), 'utf8');
if (!String.prototype.format) String.prototype.format = function(value) { return this.replace('%s', value); };
const original = '490154203237518', target = '356938035643809';
function fixture(initial = { imei: original, persistent_writes: false }) {
    const calls = [], notices = [], nodes = [], timers = new Map();
    let state = { ...initial }, custom, clock = 0, timerId = 0;
    const rpc = { declare: spec => (...args) => {
        calls.push({ method: spec.method, args });
        if (custom) return custom(spec.method, args, state);
        if (spec.method === 'status') return Promise.resolve({ ...state });
        if (spec.method === 'write_mode') { state.persistent_writes = args[0]; return Promise.resolve({ ok: true }); }
        if (spec.method === 'change' || spec.method === 'restore') {
            assert(state.persistent_writes, 'No write before writable mode is confirmed');
            assert.equal(args[1], state.imei, 'Use the fresh current IMEI');
            state.imei = spec.method === 'change' ? args[0] : original;
            return Promise.resolve({ changed: true, imei: state.imei, backup: '/etc/modem-identity-backups/item550-test.nv' });
        }
        throw new Error('Unexpected RPC');
    } };
    function E(tag, attrs, children) {
        const node = { tag, attrs: attrs || {}, children, value: '', textContent: children,
            hidden: !!(attrs && attrs.hidden), disabled: false,
            setAttribute(key, value) { this.attrs[key] = value; } };
        nodes.push(node); return node;
    }
    function schedule(fn, delay) {
        const id = ++timerId;
        if (delay === 2000) queueMicrotask(() => { clock += delay; fn(); });
        else timers.set(id, fn);
        return id;
    }
    const definition = new Function('view','rpc','ui','E','_','L','setTimeout','clearTimeout','Date',source)(
        { extend: x => x }, rpc, { addNotification: (...args) => notices.push(args) }, E, x => x,
        { resource: value => '/luci-static/resources/' + value }, schedule, id => timers.delete(id), { now: () => clock });
    const root = definition.render({ ...initial });
    const button = action => nodes.find(n => n.attrs['data-action'] === action);
    return { calls, notices, nodes, root, button, state,
        input: nodes.find(n => n.attrs.id === 'mi-new-imei'),
        backup: nodes.find(n => n.attrs.id === 'mi-backup'),
        feedback: nodes.find(n => n.attrs.role === 'status'),
        click: action => button(action).attrs.click(),
        type: (node, value) => { node.value = value; node.attrs.input(); },
        handler: value => { custom = value; },
        expire: () => { for (const fn of [...timers.values()]) fn(); }
    };
}
const methods = f => f.calls.map(x => x.method);
const ready = f => {
    assert.equal(f.root.attrs['aria-busy'], 'false');
    assert.equal(f.button('refresh').disabled, false);
    assert.equal(f.input.disabled, false);
};
(async () => {
    let f = fixture();
    assert.equal(f.button('change').disabled, true);
    assert.equal(f.button('mode').hidden, true);
    assert.equal(f.nodes.find(n => n.tag === 'details').attrs.open, undefined);
    assert.equal(f.input.attrs.inputmode, 'numeric');
    assert.equal(f.button('change').children, 'Apply & restart');
    const generated = new Set();
    for (let i=0;i<1000;i++) {
        await f.click('generate');
        assert.match(f.input.value,/^[0-9]{15}$/);
        assert.equal(f.input.value.slice(0,8),original.slice(0,8));
        assert.notEqual(f.input.value,original);
        const sum=[...f.input.value].reduce((total,value,index)=>{let d=Number(value)*(index%2?2:1);return total+(d>9?d-9:d);},0);
        assert.equal(sum%10,0);
        assert.equal(f.input.attrs['aria-invalid'],'false');
        assert.equal(f.button('change').disabled,false,'Read-only mode must not block Apply');
        generated.add(f.input.value);
    }
    assert(generated.size>990); assert.equal(f.calls.length,0);

    f=fixture(); f.type(f.input,'356938035643800'); await f.click('change');
    assert.equal(f.calls.length,0); ready(f);

    f=fixture(); f.type(f.input,target); await f.click('change');
    assert.deepEqual(methods(f),['status','write_mode','status','change','write_mode','status']);
    assert.deepEqual(f.calls[3].args,[target,original]);
    assert.deepEqual(f.calls.filter(c=>c.method==='write_mode').map(c=>c.args),[[true],[false]]);
    assert.equal(f.state.persistent_writes,false);
    assert.equal(f.backup.value,'item550-test.nv');
    assert.equal(f.nodes.find(n=>n.attrs.id==='mi-current').textContent,target);
    assert.match(f.feedback.textContent,/verified after restart/); ready(f);

    f=fixture({imei:original,persistent_writes:true}); f.type(f.input,target); await f.click('change');
    assert.deepEqual(methods(f),['status','change','write_mode','status']); ready(f);

    f=fixture(); f.type(f.input,original); await f.click('change');
    assert.deepEqual(methods(f),['status']); assert.match(f.feedback.textContent,/already set/); ready(f);

    f=fixture(); f.type(f.input,target);
    let reads=0;
    f.handler((method,args,state)=>{
        if(method==='status') {
            reads++;
            if(reads===2)return Promise.resolve({error:'Modem is restarting'});
            if(reads===3)return Promise.resolve({...state,mode_changing:true});
            return Promise.resolve({...state});
        }
        if(method==='write_mode'){state.persistent_writes=args[0];return Promise.resolve({ok:true});}
        if(method==='change'){state.imei=args[0];return Promise.resolve({changed:true,imei:state.imei});}
    });
    await f.click('change');
    assert.equal(f.calls.filter(c=>c.method==='change').length,1); assert.match(f.feedback.textContent,/verified after restart/); ready(f);

    f=fixture(); f.type(f.input,target);
    f.handler((method,args,state)=>{
        if(method==='status')return Promise.resolve({...state});
        if(method==='write_mode'){state.persistent_writes=args[0];return Promise.resolve({ok:true});}
        return Promise.resolve({error:'NV write timed out; outcome unknown',backup:'/etc/modem-identity-backups/item550-failed.nv'});
    });
    await f.click('change');
    assert.equal(f.calls.filter(c=>c.method==='change').length,1);
    assert.equal(f.state.persistent_writes,false);
    assert.equal(f.backup.value,'item550-failed.nv'); assert.match(f.feedback.textContent,/outcome unknown/); ready(f);

    f=fixture(); f.type(f.input,target);
    f.handler((method,args,state)=>{
        if(method==='status')return Promise.resolve({...state});
        if(method==='write_mode'){state.persistent_writes=args[0];return Promise.resolve({ok:true});}
        return Promise.resolve({changed:true,imei:target});
    });
    await f.click('change'); assert.match(f.feedback.textContent,/did not survive/); ready(f);

    f=fixture(); f.type(f.input,target);
    f.handler((method,args,state)=>{
        if(method==='status')return Promise.resolve({...state});
        if(method==='write_mode')return Promise.resolve({ok:true}); // Never actually becomes writable.
        throw new Error('Must never write');
    });
    await f.click('change'); assert.match(f.feedback.textContent,/did not become ready/);
    assert.equal(f.calls.filter(c=>c.method==='change').length,0); ready(f);
    assert.equal(f.button('change').disabled,false,'Timeout must leave a recoverable page');

    f=fixture(); f.type(f.input,target); f.state.imei='356938035643809'; await f.click('change');
    assert.deepEqual(methods(f),['status']); assert.match(f.feedback.textContent,/Review the updated/); ready(f);

    f=fixture(); f.type(f.backup,'../etc/shadow'); await f.click('restore');
    assert.equal(f.calls.length,0); ready(f);
    f=fixture({imei:target,persistent_writes:false}); f.type(f.backup,'item550-123.nv'); await f.click('restore');
    assert.deepEqual(methods(f),['status','write_mode','status','restore','write_mode','status']);
    assert.equal(f.state.imei,original); assert.equal(f.state.persistent_writes,false); ready(f);

    f=fixture({imei:original,persistent_writes:true}); await f.click('mode');
    assert.deepEqual(methods(f),['write_mode','status']); assert.equal(f.button('mode').hidden,true); ready(f);

    f=fixture(); f.type(f.input,target);
    f.handler(()=>new Promise(()=>{})); const pending=f.click('change'); await Promise.resolve();
    assert.equal(f.root.attrs['aria-busy'],'true'); assert.equal(f.button('refresh').disabled,true);
    await f.click('change'); assert.equal(f.calls.length,1);
    f.expire(); await pending; assert.match(f.feedback.textContent,/timed out/); ready(f);

    // NV readback is not a commit. Keep writable storage alive until fsync is acknowledged.
    f=fixture(); f.type(f.input,target);
    let commitPolls=0;
    f.handler((method,args,state)=>{
        if(method==='status') {
            if(state.commit_pending && ++commitPolls>=3) {state.storage_write_seq=2;state.storage_write_bytes=4096;}
            return Promise.resolve({...state});
        }
        if(method==='write_mode') {
            if(!args[0] && state.commit_pending)assert(state.storage_write_seq>state.commit_seq,'Never restart before disk acknowledgement');
            state.persistent_writes=args[0];if(!args[0])state.commit_pending=false;
            return Promise.resolve({ok:true});
        }
        state.imei=target;
        Object.assign(state,{commit_pending:true,commit_pid:7,commit_seq:1,commit_bytes:0,commit_imei:target,storage_pid:7,storage_write_seq:1,storage_write_bytes:0});
        return Promise.resolve({...state,changed:true,readback_verified:true});
    });
    await f.click('change');
    assert(commitPolls>=3); assert.equal(f.calls.filter(c=>c.method==='change').length,1);
    assert.match(f.feedback.textContent,/verified after restart/);ready(f);

    f=fixture();f.type(f.input,target);
    f.handler((method,args,state)=>{
        if(method==='status')return Promise.resolve({...state});
        if(method==='write_mode') {
            if(!args[0] && state.commit_pending)assert(state.storage_write_seq>state.commit_seq);
            state.persistent_writes=args[0];if(!args[0])state.commit_pending=false;
            return Promise.resolve({ok:true});
        }
        Object.assign(state,{imei:target,commit_pending:true,commit_pid:8,commit_seq:0,commit_bytes:0,commit_imei:target,storage_pid:8,storage_write_seq:0,storage_write_bytes:0});
        return Promise.resolve({...state,changed:true,readback_verified:true});
    });
    await f.click('change');ready(f);
    assert.equal(f.state.persistent_writes,true,'A timeout must preserve the live value');
    assert.deepEqual(f.calls.filter(c=>c.method==='write_mode').map(c=>c.args[0]),[true]);
    assert.match(f.feedback.textContent,/has not acknowledged/);
    assert.equal(f.button('mode').disabled,false); assert.equal(f.button('change').disabled,true);
    f.state.storage_write_seq=1;f.state.storage_write_bytes=512;
    await f.click('mode');ready(f);
    assert.equal(f.state.persistent_writes,false);
    assert.equal(f.calls.filter(c=>c.method==='change').length,1,'Finish saving must never issue another NV write');

    f=fixture({error:'Modem restarting',mode_changing:true});
    let reloadReads=0;
    f.handler(method=>{
        assert.equal(method,'status');
        return Promise.resolve(++reloadReads===1 ? {error:'Still restarting'} : {imei:original,persistent_writes:false,mode_changing:false});
    });
    for(let i=0;i<100 && f.root.attrs['aria-busy']==='true';i++)await Promise.resolve();
    ready(f); assert.equal(f.nodes.find(n=>n.attrs.id==='mi-current').textContent,original);

    f=fixture({error:'Modem unavailable'});
    assert.equal(f.button('change').disabled,true); assert.equal(f.button('refresh').disabled,false);
    assert.equal(f.feedback.textContent,'Modem unavailable');
    console.log('View checks passed: generation, automatic apply/restore/restart verification, delayed readiness, failures, deadlines, stale identity, recovery, and no duplicate writes');
})().catch(error=>{console.error(error);process.exitCode=1;});
