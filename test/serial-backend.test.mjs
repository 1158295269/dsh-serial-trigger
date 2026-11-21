import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialBackend } from '../src/serial-backend.mjs';

/** Minimal stand-in for serialport's SerialPort so error mapping is testable. */
function fakeClass(behaviour = {}) {
  return class FakePort {
    constructor(opts) { this.opts = opts; this.isOpen = false; this.handlers = {} }
    static async list() { return behaviour.list || [] }
    on(evt, fn) { this.handlers[evt] = fn }
    open(cb) {
      if (behaviour.openError) return cb(behaviour.openError)
      this.isOpen = true
      cb(null)
    }
    write(bytes, cb) { if (behaviour.writeError) return cb(behaviour.writeError); cb(null) }
    close(cb) { this.isOpen = false; cb(null) }
  }
}

test('SB1 access denied maps to E_PORT_BUSY with a fix list', async () => {
  const backend = createSerialBackend({ SerialPortClass: fakeClass({ openError: new Error('Access denied') }) });
  await assert.rejects(
    () => backend.open({ path: 'COM3', baudRate: 115200 }),
    (err) => {
      assert.equal(err.code, 'E_PORT_BUSY');
      assert.ok(err.hint.includes('SSCOM') || err.hint.length > 20);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('SB2 missing device maps to E_PORT_NOT_FOUND and is not retryable', async () => {
  const backend = createSerialBackend({ SerialPortClass: fakeClass({ openError: new Error('File not found') }) });
  await assert.rejects(
    () => backend.open({ path: 'COM99', baudRate: 9600 }),
    (err) => {
      assert.equal(err.code, 'E_PORT_NOT_FOUND');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('SB3 an unknown driver failure still carries a code and a hint', async () => {
  const backend = createSerialBackend({ SerialPortClass: fakeClass({ openError: new Error('weird driver thing') }) });
  await assert.rejects(
    () => backend.open({ path: 'COM7', baudRate: 9600 }),
    (err) => {
      assert.equal(err.code, 'E_OPEN_FAILED');
      assert.ok(err.hint.length > 10);
      return true;
    },
  );
});

test('SB4 list normalises the driver payload', async () => {
  const backend = createSerialBackend({
    SerialPortClass: fakeClass({ list: [{ path: 'COM6', friendlyName: 'USB Serial Port', manufacturer: 'FTDI' }] }),
  });
  const ports = await backend.list();
  assert.deepEqual(ports, [{ path: 'COM6', friendlyName: 'USB Serial Port', manufacturer: 'FTDI', serialNumber: '' }]);
});

test('SB5 open delivers data through onData and closes cleanly', async () => {
  const backend = createSerialBackend({ SerialPortClass: fakeClass() });
  const chunks = [];
  const handle = await backend.open({ path: 'COM1', baudRate: 9600, onData: (c) => chunks.push(Buffer.from(c)) });
  assert.equal(handle.info.path, 'COM1');
  await handle.write(Buffer.from('ping'));
  await handle.close();
  assert.deepEqual(chunks, []);
});
