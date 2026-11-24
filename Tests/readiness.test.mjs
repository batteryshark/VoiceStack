import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { wav } from '../Backend/ModeAAdapter/audio.mjs';
import { localUpstreams } from '../Backend/ModeAAdapter/server.mjs';

test('simultaneous cold readiness requests share one speech warm-up', async t => {
  let synthesis = 0, recognition = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    synthesis++;
    await new Promise(r => setTimeout(r, 100));
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav(Buffer.alloc(4800)));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', ws => { recognition++; ws.on('message', (_, binary) => { if (!binary) { ws.send(JSON.stringify({ type: 'transcript', text: '' })); ws.close(1000); } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.close(); });
  const origin = `127.0.0.1:${server.address().port}`;
  const speech = localUpstreams({ breeze: `http://${origin}/v1/audio/speech`, parakeet: `ws://${origin}/v1/transcribe` });
  assert.deepEqual(await Promise.all([speech.ready(), speech.ready(), speech.ready()]), [true, true, true]);
  assert.equal(synthesis, 1); assert.equal(recognition, 1);
  assert.equal(await speech.ready(), true); assert.equal(synthesis, 1);
});
