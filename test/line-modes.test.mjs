import test from 'node:test';
import assert from 'node:assert/strict';
import { LineAssembler } from '../src/lines.mjs';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { tmpRoot } from './helpers.mjs';

const b = (s) => Buffer.from(s, 'utf8');

test('M1 any mode breaks on CR, LF and CRLF', () => {
  const la = new LineAssembler({ lineEnding: 'any' });
  const out = la.feed({ bytes: b('a\rb\nc\r\nd'), seq: 0, tWallMs: 1 });
  assert.deepEqual(out.map((l) => l.text), ['a', 'b', 'c']);
  const tail = la.flush(2);
  assert.equal(tail[0].text, 'd');
});

test('M2 crlf mode ignores lone CR and lone LF', () => {
  const la = new LineAssembler({ lineEnding: 'crlf' });
  const out = la.feed({ bytes: b('a\nb\rc\r\nd'), seq: 0, tWallMs: 1 });
  assert.deepEqual(out.map((l) => l.text), ['a\nb\rc']);
  const tail = la.flush(2);
  assert.equal(tail[0].text, 'd');
});

test('M3 crlf mode holds a trailing CR until the next byte proves the pair', () => {
  const la = new LineAssembler({ lineEnding: 'crlf' });
  assert.deepEqual(la.feed({ bytes: b('line\r'), seq: 0, tWallMs: 1 }), []);
  const out = la.feed({ bytes: b('\nnext'), seq: 6, tWallMs: 2 });
  assert.deepEqual(out.map((l) => l.text), ['line']);
  assert.equal(la.carry, 'next');
});

test('M4 any mode also holds a trailing CR, then pairs it with LF', () => {
  const la = new LineAssembler({ lineEnding: 'any' });
  assert.deepEqual(la.feed({ bytes: b('x\r'), seq: 0, tWallMs: 1 }), []);
  const out = la.feed({ bytes: b('\ny'), seq: 3, tWallMs: 2 });
  assert.deepEqual(out.map((l) => l.text), ['x']);
  assert.equal(la.carry, 'y');
});

test('M5 any mode treats a CR followed by a non-LF as its own break', () => {
  const la = new LineAssembler({ lineEnding: 'any' });
  const out = la.feed({ bytes: b('a\rb'), seq: 0, tWallMs: 1 });
  assert.deepEqual(out.map((l) => l.text), ['a']);
  assert.equal(la.carry, 'b');
});

test('M6 lf mode keeps a lone CR inside the line', () => {
  const la = new LineAssembler({ lineEnding: 'lf' });
  const out = la.feed({ bytes: b('a\rb\nc'), seq: 0, tWallMs: 1 });
  assert.deepEqual(out.map((l) => l.text), ['a\rb']);
});

test('M7 the same bytes yield different line counts per policy, and pending is reported', async (t) => {
  const root = await tmpRoot('m7-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(() => service.dispose());
  const { portId } = await service.open({ port: 'MOCK:M7', baudRate: 115200, project: 'P', conversation: 'c' });
  service.feed(portId, b('a\rb\nc'));
  await new Promise((r) => setTimeout(r, 30));

  const any = await service.tail({ portId, cursor: 0, lineEnding: 'any' });
  const lf = await service.tail({ portId, cursor: 0, lineEnding: 'lf' });
  const crlf = await service.tail({ portId, cursor: 0, lineEnding: 'crlf' });

  assert.deepEqual(any.lines.map((l) => l.text), ['a', 'b']);
  assert.deepEqual(any.pending, { text: 'c', seq: any.pending.seq, partial: true });

  assert.deepEqual(lf.lines.map((l) => l.text), ['a\rb']);
  assert.equal(lf.pending.text, 'c');

  assert.deepEqual(crlf.lines.map((l) => l.text), []);
  assert.equal(crlf.pending.text, 'a\rb\nc');
});
