import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createApi, dispatch } from '../src/api.mjs';
import { readFile } from 'node:fs/promises';
import { tmpRoot } from './helpers.mjs';

async function box() {
  const store = await Store.open({ root: await tmpRoot('api-') });
  const service = new SerialService({ store });
  const routes = createApi(service);
  return { store, service, routes, call: (method, path, extra = {}) => dispatch(routes, { method, path, ...extra }) };
}

test('A1 state lists ports and recent captures', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());
  const opened = await call('POST', '/serial/open', { body: { port: 'MOCK:API', baudRate: 115200, project: 'P', conversation: 'c' } });
  assert.equal(opened.status, 200);
  const portId = opened.body.portId;

  const state = await call('GET', '/serial/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.ports.find((p) => p.portId === portId).state, 'open');

  service.feed(portId, Buffer.from('hello\n'));
  await new Promise((r) => setTimeout(r, 30));
  await call('POST', '/serial/close', { body: { portId } });

  const after = await call('GET', '/serial/state');
  assert.equal(after.body.captures.length, 1);
  assert.equal(after.body.captures[0].project, 'P');
  assert.ok(after.body.captures[0].id);
});

test('A2 tail returns lines plus a cursor', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());
  const { body: { portId } } = await call('POST', '/serial/open', { body: { port: 'MOCK:T', project: 'P', conversation: 'c' } });
  service.feed(portId, Buffer.from('a\nb\n'));
  await new Promise((r) => setTimeout(r, 30));

  const first = await call('GET', '/serial/tail', { query: { portId: String(portId), cursor: '0' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.lines.map((l) => l.text), ['a', 'b']);

  const second = await call('GET', '/serial/tail', { query: { portId: String(portId), cursor: String(first.body.cursor) } });
  assert.equal(second.body.lines.length, 0);
});

test('A3 send validates hex and accepts text', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());
  const { body: { portId } } = await call('POST', '/serial/open', { body: { port: 'MOCK:S', project: 'P', conversation: 'c' } });

  const badHex = await call('POST', '/serial/send', { body: { portId, hex: 'zz' } });
  assert.equal(badHex.status, 400);
  assert.equal(badHex.body.error.code, 'E_INVALID_ARGS');

  const sent = await call('POST', '/serial/send', { body: { portId, text: 'AT', append: 'crlf' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.bytes, 4);
});

test('A4 unknown route, bad portId and unknown capture degrade cleanly', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());

  const missing = await call('GET', '/serial/nope');
  assert.equal(missing.status, 404);

  const badPort = await call('GET', '/serial/tail', { query: { portId: 'x' } });
  assert.equal(badPort.status, 400);

  const c1 = await call('POST', '/serial/close', { body: { portId: 999 } });
  assert.equal(c1.status, 400);
  assert.equal(c1.body.error.code, 'E_PORT_NOT_FOUND');
  assert.ok(c1.body.error.hint);
});


test('A5 a closed capture can be read back as lines', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());
  const { body: { portId } } = await call('POST', '/serial/open', { body: { port: 'MOCK:HIST', project: 'P', conversation: 'c' } });
  service.feed(portId, Buffer.from('first\nsecond\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await call('POST', '/serial/close', { body: { portId } });

  const res = await call('GET', '/serial/capture', { query: { id: closed.body.captureId } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lines.map((l) => l.text), ['first', 'second']);
  assert.equal(res.body.port, 'MOCK:HIST');
});

test('A6 delete removes the file and the row, and is not repeatable', async (t) => {
  const { service, store, call } = await box();
  t.after(() => service.dispose());
  const { body: { portId } } = await call('POST', '/serial/open', { body: { port: 'MOCK:DEL', project: 'P', conversation: 'gone' } });
  service.feed(portId, Buffer.from('bye\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await call('POST', '/serial/close', { body: { portId } });

  const del = await call('POST', '/serial/delete', { body: { captureId: closed.body.captureId } });
  assert.equal(del.status, 200);
  assert.equal(del.body.removed, true);
  assert.equal(store.listCaptures({ includeMissing: true }).length, 0);

  const again = await call('POST', '/serial/delete', { body: { captureId: closed.body.captureId } });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'E_NO_SUCH_CAPTURE');
});

test('A7 deleting the capture that is being recorded is refused', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());
  const opened = await call('POST', '/serial/open', { body: { port: 'MOCK:BUSY', project: 'P', conversation: 'live' } });
  const res = await call('POST', '/serial/delete', { body: { captureId: opened.body.captureId } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'E_CAPTURE_BUSY');
  assert.ok(res.body.error.hint.includes('Close the port'));
});


test('A8 export supports text, hex, csv and jsonl', async (t) => {
  const { service, call } = await box();
  t.after(() => service.dispose());
  const { body: { portId } } = await call('POST', '/serial/open', { body: { port: 'MOCK:EXP', project: 'P', conversation: 'exp' } });
  service.feed(portId, Buffer.from('alpha\nbeta\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await call('POST', '/serial/close', { body: { portId } });
  const id = closed.body.captureId;

  const text = await call('POST', '/serial/export', { body: { captureId: id, format: 'text', timestamps: true } });
  assert.equal(text.status, 200);
  assert.ok(text.body.path.endsWith('.txt'));
  const textBody = await readFile(text.body.path, 'utf8');
  assert.match(textBody, /^\[\d\d:\d\d:\d\d\.\d\d\d\] alpha/m);

  const noTs = await call('POST', '/serial/export', { body: { captureId: id, format: 'text', timestamps: false, out: text.body.path.replace(/\.txt$/, '-nots.txt') } });
  assert.ok((await readFile(noTs.body.path, 'utf8')).startsWith('alpha'));

  const hex = await call('POST', '/serial/export', { body: { captureId: id, format: 'hex' } });
  const hexBody = await readFile(hex.body.path, 'utf8');
  assert.match(hexBody, /^00000040  61 6c 70 68 61/m, 'hex dump starts at the first payload byte');
  assert.ok(hex.body.path.includes('-hex'));

  const csv = await call('POST', '/serial/export', { body: { captureId: id, format: 'csv' } });
  const csvBody = await readFile(csv.body.path, 'utf8');
  const rows = csvBody.trim().split('\n');
  assert.equal(rows[0], 'time_iso,mono_us,dir,kind,text,hex');
  assert.ok(rows[1].includes('"alpha'), rows[1]);

  const jsonl = await call('POST', '/serial/export', { body: { captureId: id, format: 'jsonl' } });
  const jlines = (await readFile(jsonl.body.path, 'utf8')).trim().split('\n');
  const first = JSON.parse(jlines[0]);
  assert.equal(first.dir, 'rx');
  assert.ok(first.hex.startsWith('616c706861'));
});
