import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, TOPIC } from '../src/hub.mjs';
import { LineAssembler } from '../src/lines.mjs';

const bytes = (s) => new TextEncoder().encode(s);

test('hub: two subscribers both see ordered, gapless seq', async () => {
  const hub = new Hub({ ringBytes: 1 << 20 });
  const a = hub.subscribe(TOPIC.STREAM, { filter: { portId: 1 } });
  const b = hub.subscribe(TOPIC.STREAM, { filter: { portId: 1 } });

  hub.publishData(1, { dir: 0, bytes: bytes('aa'), tMonoUs: 1, tWallMs: 1000 });
  hub.publishData(1, { dir: 0, bytes: bytes('bbb'), tMonoUs: 2, tWallMs: 1001 });

  const a1 = await a.next(50), a2 = await a.next(50);
  const b1 = await b.next(50), b2 = await b.next(50);
  assert.equal(a1.seq, 0);
  assert.equal(a2.seq, 2);
  assert.equal(b1.seq, 0);
  assert.equal(b2.seq, 2);
  assert.equal(hub.head(1), 5);
  a.close(); b.close();
});

test('hub: slow subscriber drops oldest and reports gap, fast one unaffected', async () => {
  const hub = new Hub({ ringBytes: 1 << 20 });
  const slow = hub.subscribe(TOPIC.STREAM, { filter: { portId: 2 }, queueBytes: 100 });
  const fast = hub.subscribe(TOPIC.STREAM, { filter: { portId: 2 }, queueBytes: 1 << 20 });

  for (let i = 0; i < 50; i++) {
    hub.publishData(2, { dir: 0, bytes: Buffer.alloc(10, i), tMonoUs: i, tWallMs: i });
  }

  // fast subscriber drains everything, in order
  let seen = 0;
  while (true) {
    const m = await fast.next(1);
    if (!m) break;
    assert.equal(m.seq, seen * 10);
    seen++;
  }
  assert.equal(seen, 50);

  // slow subscriber kept a bounded queue and flagged the loss
  const first = await slow.next(1);
  assert.ok(first.gapBytes > 0, 'expected gapBytes on the first delivered batch');
  assert.ok(slow.dropped === 0);
  slow.close(); fast.close();
});

test('hub: cursor catch-up replays backlog from the ring', async () => {
  const hub = new Hub({ ringBytes: 1 << 20 });
  hub.registerPort(3);
  hub.publishData(3, { dir: 0, bytes: bytes('abcd'), tMonoUs: 1, tWallMs: 1 });
  hub.publishData(3, { dir: 0, bytes: bytes('efgh'), tMonoUs: 2, tWallMs: 2 });

  const back = hub.backlog(3, 2);
  assert.equal(back.length, 2);
  assert.equal(Buffer.from(back[1].bytes).toString(), 'efgh');

  const sub = hub.subscribe(TOPIC.STREAM, { filter: { portId: 3 }, cursor: 4 });
  const caught = await sub.next(50);
  assert.equal(Buffer.from(caught.bytes).toString(), 'efgh');
  sub.close();
});

test('hub: ring evicts old batches but keeps the newest', async () => {
  const hub = new Hub({ ringBytes: 100 });
  hub.registerPort(4);
  for (let i = 0; i < 30; i++) hub.publishData(4, { dir: 0, bytes: Buffer.alloc(10), tMonoUs: i, tWallMs: i });
  const back = hub.backlog(4, 0, 1 << 20);
  assert.ok(back.length >= 2);
  assert.ok(back.length < 30);
  assert.equal(back[back.length - 1].seq, 290);
});

test('lines: LF splits, CRLF strips CR, partial tail is flushed on idle', () => {
  const la = new LineAssembler();
  const out = la.feed({ bytes: bytes('one\r\ntwo\nthree'), seq: 0, tWallMs: 10 });
  assert.deepEqual(out.map((l) => l.text), ['one', 'two']);
  const tail = la.flush(11);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].text, 'three');
  assert.equal(tail[0].partial, true);
});

test('lines: a multi-byte UTF-8 char split across batches survives', () => {
  const la = new LineAssembler();
  const full = Buffer.from('温度=25\n', 'utf8');
  const cut = full.indexOf(Buffer.from('度', 'utf8')) + 1; // split inside the 3-byte char
  const a = la.feed({ bytes: full.subarray(0, cut), seq: 0, tWallMs: 1 });
  const b = la.feed({ bytes: full.subarray(cut), seq: cut, tWallMs: 2 });
  assert.deepEqual([...a, ...b].map((l) => l.text), ['温度=25']);
});

test('lines: jsonl style batches from a device keep one record per line', () => {
  const la = new LineAssembler();
  const payload = ['{"i":1,"v":3.3}', '{"i":2,"v":3.4}', '{"i":3,"v":3.5}'].join('\n') + '\n';
  const out = la.feed({ bytes: Buffer.from(payload), seq: 0, tWallMs: 5 });
  assert.equal(out.length, 3);
  assert.equal(JSON.parse(out[1].text).i, 2);
});
