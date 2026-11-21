/**
 * Real serial transport, isolated behind a tiny interface so tests can inject a
 * fake and the service never imports serialport directly.
 *
 * Interface:
 *   list()                        -> [{ path, friendlyName, manufacturer, serialNumber }]
 *   open({ path, baudRate, ... }) -> { write(bytes), close(), info }
 *
 * Error mapping is the interesting part: Windows reports "Access denied" both
 * for a port held by another program and for a driver-level refusal, so the
 * message is inspected rather than trusted blindly.
 */
import { SerialError } from './errors.mjs';

const OPEN_TIMEOUT_MS = 4000;

export function createSerialBackend(options = {}) {
  // Lazy import keeps the plugin loadable on hosts where the native binding is
  // missing; only actually opening a port fails in that case.
  let cached = options.SerialPortClass || null;

  async function loadClass() {
    if (cached) return cached;
    try {
      const mod = await import('serialport');
      cached = mod.SerialPort || mod.default;
      return cached;
    } catch (err) {
      throw new SerialError('E_SERIAL_UNAVAILABLE', 'the serialport native binding is not available: ' + (err && err.message), {
        hint: 'Install the plugin with its dependencies (pnpm add serialport) or use a MOCK port for logic-only tests.',
        fix: ['pnpm add serialport', 'use serial_open({port:"MOCK:x"})'],
      });
    }
  }

  /** Translate a driver error into something a model can act on. */
  function mapOpenError(path, err) {
    const message = String((err && err.message) || err);
    const lower = message.toLowerCase();
    if (lower.includes('access denied') || lower.includes('busy') || lower.includes('cannot lock')) {
      return new SerialError('E_PORT_BUSY', path + ' is already open by another program', {
        hint: 'Another process holds this port (SSCOM, a vendor tool, or a previous session that did not close). Close it, or pick a different port.',
        fix: ['close the program using ' + path, 'serial_ports() to pick another port', 'retry serial_open'],
        retryable: true,
      });
    }
    if (lower.includes('file not found') || lower.includes('no such file') || lower.includes('cannot find')) {
      return new SerialError('E_PORT_NOT_FOUND', 'no serial port named ' + path, {
        hint: 'The port name is wrong or the device is unplugged. serial_ports() lists what actually exists right now.',
        fix: ['serial_ports()', 'check the cable', 'retry with the exact name'],
        retryable: false,
      });
    }
    if (lower.includes('permission') || lower.includes('eacces')) {
      return new SerialError('E_PERMISSION', 'permission denied opening ' + path, {
        hint: 'The driver refused access. Replug the device or check port permissions.',
        fix: ['replug the device', 'try another port'],
      });
    }
    return new SerialError('E_OPEN_FAILED', 'cannot open ' + path + ': ' + message, {
      hint: 'The driver rejected the connection. Check the port name and whether the device is present.',
      fix: ['serial_ports()', 'retry'],
      retryable: true,
    });
  }

  return {
    async list() {
      const SerialPort = await loadClass();
      const ports = await SerialPort.list().catch(() => []);
      return ports.map((p) => ({
        path: p.path,
        friendlyName: p.friendlyName || p.manufacturer || '',
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
      }));
    },

    async open(opts) {
      const SerialPort = await loadClass();
      const { path, baudRate = 115200, onData, onError } = opts;
      const device = new SerialPort({ path, baudRate, autoOpen: false, highWaterMark: 1 << 20 });

      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new SerialError('E_OPEN_TIMEOUT', 'opening ' + path + ' timed out after ' + OPEN_TIMEOUT_MS + 'ms', {
            hint: 'The driver did not answer. The device may be wedged; replug it and retry.',
            fix: ['replug the device', 'retry serial_open'],
            retryable: true,
          }));
        }, OPEN_TIMEOUT_MS);
        device.open((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(mapOpenError(path, err));
          else resolve();
        });
      });

      device.on('data', (chunk) => { if (onData) onData(chunk); });
      device.on('error', (err) => { if (onError) onError(err); });

      return {
        info: { path, baudRate, friendlyName: opts.friendlyName || '' },
        write(bytes) {
          return new Promise((resolve, reject) => {
            device.write(bytes, (err) => (err ? reject(err) : resolve()));
          });
        },
        close() {
          return new Promise((resolve) => {
            if (!device.isOpen) return resolve();
            device.close(() => resolve());
          });
        },
      };
    },
  };
}
