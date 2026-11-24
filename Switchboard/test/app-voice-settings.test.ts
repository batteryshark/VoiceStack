import {afterEach,expect,test} from 'bun:test';
import {harness,uuid,type Harness} from './harness.ts';
let h:Harness;afterEach(()=>h?.stop());
test('paired app can choose a voice in the shared profile without redirecting an existing call',async()=>{
 h=await harness();const p=h.switchboard.profiles;
 p.save({...p.active(),health_url:'https://fixture.invalid/health',voice:'ash'});
 p.voices=async()=>({voice:p.active().voice!,default_voice:'ash',voices:[{id:'ash',label:'Ash'},{id:'other',label:'Other'}]});
 const d=await h.pairedDevice('macos','Mac');
 const call=await d.request('POST','/calls',{operation_id:uuid(),direction:'outgoing',target_id:'target_main'});
 const op=uuid();const change=await d.request('PUT','/settings/speech',{operation_id:op,voice:'other'});
 expect(change.status).toBe(200);expect(change.body.voice).toBe('other');expect(p.active().voice).toBe('other');
 expect(p.forCall(h.switchboard.store.call(call.body.call.id)!).voice).toBe('ash');
 p.select('second');
 const retry=await d.request('PUT','/settings/speech',{operation_id:op,voice:'other'});
 expect(retry.status).toBe(200);expect(p.active().voice).toBeUndefined();
});
