/**
 * Replay a recorded capture back into the hub.
 *
 * Two uses:
 *  - tests and UI work without hardware
 *  - "what did the device actually say" without owning the port
 *
 * speed 1 = real time, 10 = ten times faster, 0 = as fast as possible.
 */
import { SlogReader, KIND } from './codec.mjs';

export async function replayCapture(opts) {
  const { service, path, speed = 10, portName = 'MOCK:REPLAY', maxRecords = Infinity } = opts;
  const reader = await SlogReader.open(path);
  const records = [];
  await reader.scan((rec) => {
    if (records.length >= maxRecords) return;
    if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return;
    records.push({ dir: rec.kind === KIND.TX ? 1 : 0, bytes: Buffer.from(rec.bytes), t: rec.tMonoUs });
  });

  const opened = await service.open({
    port: portName,
    baudRate: reader.header.baud || 115200,
    project: opts.project || 'replay',
    conversation: opts.conversation || 'replay',
    record: opts.record === true,
  });

  let prev = records.length > 0 ? records[0].t : 0;
  let sinceFlush = 0;
  for (const rec of records) {
    if (speed > 0) {
      const delay = Math.min(50, Math.max(0, (rec.t - prev) / speed));
      if (delay >= 1) await new Promise((r) => setTimeout(r, delay));
      prev = rec.t;
    }
    service.feed(opened.portId, rec.bytes, rec.dir);
    // Unpaced replay can outrun the disk; drain periodically so RSS stays bounded.
    sinceFlush += rec.bytes.length;
    if (sinceFlush >= 8 * 1024 * 1024) {
      await service.flush(opened.portId);
      sinceFlush = 0;
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  return { portId: opened.portId, records: records.length, port: portName };
}
