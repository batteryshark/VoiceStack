import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeLane } from '../src/connector/native-lane.ts';

test('native voice delivery survives connector replacement without replay or unrelated replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-native-'));
  let prompts = 0;
  let messages: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    expect(req.headers.get('authorization')).toBe('Basic ' + Buffer.from('opencode:fixture').toString('base64'));
    const path = new URL(req.url).pathname;
    if (path.endsWith('/inbox')) return Response.json({ data: [] });
    if (path.endsWith('/wait')) return new Response(null, { status: 204 });
    if (path.endsWith('/prompt')) {
      prompts++;
      const prompt = await req.json();
      expect(prompt.text).toBe('[voice] Hello');
      messages = [{ id: prompt.id, type: 'user', text: prompt.text },
        { id: 'msg_reply', type: 'assistant', finish: 'stop', time: { completed: 1 },
          content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'Your requested reply.' }] },
        { id: 'msg_later', type: 'user', text: 'An unrelated typed question' },
        { id: 'msg_other', type: 'assistant', finish: 'stop', time: { completed: 2 }, content: [{ type: 'text', text: 'Unrelated reply' }] }];
      return Response.json({ data: {} });
    }
    if (path.endsWith('/message')) return Response.json({ data: [...messages].reverse() });
    if (path.includes('/message/')) {
      const found = messages.find(m => m.id === path.split('/').at(-1));
      return found ? Response.json({ data: found }) : new Response(null, { status: 404 });
    }
    return Response.json({ data: { id: 'ses_default' } });
  } });
  const instance = join(dir, 'instance.json');
  const write = (defaultSession = 'ses_default') => writeFileSync(instance, JSON.stringify({ base: server.url.origin, runtimePassword: 'fixture', defaultSession }));
  write();
  const config = { kind: 'native' as const, instance, targets: { target_main: 'default' } };
  const turn = { call_id: 'call_one', operation_id: 'op_one', text: 'Hello', delivery: 'queue' as const };
  try {
    const lane = new NativeLane(config);
    const pin = await lane.resolve('target_main');
    const spoken: string[] = [];
    expect(await lane.deliver(pin, turn, text => spoken.push(text))).toBe('Your requested reply.');
    expect(spoken).toEqual(['Your requested reply.']);
    expect(await new NativeLane(config).deliver(pin, turn, () => {})).toBe('Your requested reply.');
    expect(prompts).toBe(1);
    await expect(lane.deliver(pin, { ...turn, text: 'Changed' }, () => {})).rejects.toThrow('different text');
    write('ses_replacement');
    await expect(lane.deliver(pin, turn, () => {})).rejects.toThrow('replaced');
    expect(prompts).toBe(1);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test('hang-up does not post a synthetic conversation message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-ended-'));
  const received: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    expect(path).toStartWith('/api/session/ses_original/');
    if (path.endsWith('/inbox')) return Response.json({ data: received });
    if (path.includes('/message/')) return new Response(null, { status: 404 });
    expect(path).toEndWith('/prompt');
    received.push(await req.json());
    return Response.json({});
  } });
  const instance = join(dir, 'instance.json');
  writeFileSync(instance, JSON.stringify({ base: server.url.origin, runtimePassword: 'fixture', defaultSession: 'ses_replacement' }));
  const config = { kind: 'native' as const, instance, targets: { target_main: 'default' } };
  const pin = JSON.stringify({ target: 'target_main', session: 'ses_original' });
  try {
    await new NativeLane(config).ended(pin, 'call_one', 'user');
    await new NativeLane(config).ended(pin, 'call_one', 'user');
    expect(received).toHaveLength(0);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test('catalog paginates without waking sessions and native IDs survive renames', async () => {
  const dir=mkdtempSync(join(tmpdir(),'switchboard-catalog-'));
  const seen: string[]=[];
  let archived=false, title='Writing';
  const server=Bun.serve({port:0,fetch(req) {
    expect(req.method).toBe('GET');
    const u=new URL(req.url);seen.push(u.pathname);
    if(u.pathname==='/api/session') return Response.json(u.searchParams.has('cursor') ? {
      data:[{id:'ses_two',title,location:{directory:'/projects/two'}}]
    } : {data:[{id:'ses_default',title:'Default'},{id:'ses_one',title,location:{directory:'/projects/one'}},{id:'ses_archived',time:{archived:1}}],cursor:{next:'page2'}});
    if(u.pathname==='/api/session/ses_two') return Response.json({data:{id:'ses_two',title,time:{archived:archived?1:undefined}}});
    return new Response(null,{status:404});
  }});
  const instance=join(dir,'instance.json');writeFileSync(instance,JSON.stringify({base:server.url.origin,runtimePassword:'fixture',defaultSession:'ses_default'}));
  const lane=new NativeLane({kind:'native',instance,targets:{target_main:'default'}});
  try {
    expect(await lane.catalog()).toEqual([{id:'session:ses_one',label:'Writing',project:'/projects/one'},{id:'session:ses_two',label:'Writing',project:'/projects/two'}]);
    const pin=await lane.resolve('session:ses_two'); title='Renamed';
    expect(await lane.resolve('session:ses_two')).toBe(pin);
    expect(JSON.parse(pin).session).toBe('ses_two');
    archived=true;await expect(lane.resolve('session:ses_two')).rejects.toThrow('archived');
    await expect(lane.resolve('session:ses_missing')).rejects.toThrow('404');
    expect(seen.every(p=>p==='/api/session'||/^\/api\/session\/ses_/.test(p))).toBe(true);
  } finally {server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
