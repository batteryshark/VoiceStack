import {test, expect} from 'bun:test';
import {harness, uuid} from './harness.ts';
import {TextChannel} from '../src/stubs/devices.ts';

test('Mac and phone discover project-labelled sessions, pin selection, and replay without rediscovery', async () => {
  let rows = [{id:'session:ses_one',label:'Writing',project:'/projects/one'}, {id:'session:ses_two',label:'Writing',project:'/projects/two'}];
  let unavailable = false;
  const h = await harness({catalog: async () => { if(unavailable) throw Error('offline'); return rows; }});
  h.lane.pointer['session:ses_one']='session-one';
  h.lane.pointer['session:ses_two']='session-two';
  let channel: TextChannel | undefined;
  try {
    const mac=await h.pairedDevice('macos','Mac');
    const phone=await h.pairedDevice('ios','Phone');
    for(const d of [mac,phone]) {
      const result=await d.request('GET','/targets');
      expect(result.status).toBe(200);
      expect(result.body.targets.filter((t:any)=>t.is_default).map((t:any)=>t.id)).toEqual(['target_main']);
      expect(result.body.targets.slice(-2).map((t:any)=>t.project)).toEqual(['/projects/one','/projects/two']);
    }
    expect(h.lane.delivered).toHaveLength(0);
    const payload={operation_id:uuid(),direction:'outgoing',target_id:'session:ses_two'};
    const placed=await mac.request('POST','/calls',payload);
    expect(placed.status).toBe(200);
    const call=placed.body.call;
    expect(JSON.parse(h.switchboard.store.call(call.id)!.lane_ref!).conversation).toBe('session-two');
    rows[1].label='Renamed';
    expect((await mac.request('GET','/targets')).body.targets.at(-1).label).toBe('Renamed');
    unavailable=true;
    const replay=await mac.request('POST','/calls',payload);
    expect(replay.status).toBe(200);
    expect(replay.body.call.id).toBe(call.id);
    unavailable=false;
    rows=[];
    expect((await phone.request('POST','/calls',{...payload,operation_id:uuid()})).status).toBe(400);
    expect(h.lane.delivered).toHaveLength(0);
  } finally {channel?.close();h.stop();}
});
