import { encodeHeader, decodeHeader } from './src/codec.mjs';
import { LineAssembler } from './src/lines.mjs';
import { sanitizeName } from './src/store.mjs';

const out = {};
const cn = '串口COM3-测试用端口名字很长';
const buf = encodeHeader({ port: cn, baud: 115200 });
const h = decodeHeader(buf);
out.portClip = { input: cn, got: h.port, hasReplacement: h.port.includes('\ufffd') };

const la = new LineAssembler();
const lines = la.feed({ bytes: Buffer.from('aa\nbb\ncc\n'), seq: 100, tWallMs: 1 });
out.lineSeq = lines.map((l) => ({ text: l.text, seq: l.seq }));
out.lineSeqExpected = [100, 103, 106];

out.sanitize = {
  traversal: sanitizeName('../../etc/passwd'),
  dots: sanitizeName('..'),
  backslash: sanitizeName('a\\..\\b'),
  control: sanitizeName('a\u0000b\u0001c'),
};

console.log(JSON.stringify(out, null, 2));
