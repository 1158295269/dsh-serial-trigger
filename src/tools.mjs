/**
 * Model-facing tool surface.
 *
 * Every tool returns {ok:true, data} or {ok:false, error}, never a bare string:
 * the error carries a hint written for the model (why, what else to try, whether
 * a retry can help) so a failed call is still actionable.
 */
import { SerialError } from './errors.mjs';

const ok = (data) => ({ ok: true, data });

function fail(err) {
  if (err instanceof SerialError) {
    return { ok: false, error: { code: err.code, message: err.message, hint: err.hint, fix: err.fix, retryable: err.retryable } };
  }
  return {
    ok: false,
    error: {
      code: 'E_INTERNAL',
      message: String((err && err.message) || err),
      hint: 'Unexpected failure inside the serial service. Retrying is usually safe; if it repeats, run serial_captures to confirm the capture still exists.',
      fix: ['retry the same call', 'serial_captures() to check state'],
      retryable: true,
    },
  };
}

function badArg(message) {
  return fail(new SerialError('E_INVALID_ARGS', message, {
    hint: 'The call is missing or misusing a parameter; check the schema and retry.',
    fix: ['fix the argument and call again'],
    retryable: true,
  }));
}

/**
 * Who is calling. Sub-agents inherit the root session's identity so a delegated
 * task does not suddenly look like a stranger to its own port.
 */
function ownerOf(exec) {
  let cur = exec;
  let guard = 0;
  while (cur && cur.parent && guard < 8) {
    if (typeof cur.parent === 'string' || typeof cur.parent === 'number') return { kind: 'agent', id: String(cur.parent) };
    cur = cur.parent;
    guard += 1;
  }
  const agent = cur && cur.agent;
  // The host normally hands the Agent instance itself, not an id; a bare string
  // still shows up in tests and older call sites.
  if (typeof agent === 'string' && agent) return { kind: 'agent', id: agent };
  if (agent && typeof agent === 'object') {
    const id = agent.id ?? agent.agentId ?? agent.sessionId;
    if (id !== undefined && id !== null && id !== '') return { kind: 'agent', id: String(id) };
  }
  const sessionId = cur && (cur.sessionId ?? (cur.session && cur.session.id));
  if (sessionId) return { kind: 'session', id: String(sessionId) };
  // Nested PTC bindings may carry neither: the identity is then unknown, and the
  // single-writer rule degrades to last-writer-wins (SPEC 23.5 allows takeover).
  return { kind: 'agent', id: 'unknown' };
}

export function createTools(service) {
  const list = [
    {
      name: 'serial_ports',
      description: '列出可用的串口与当前已打开的端口。返回 port 名、状态、portId、以及正在录制的 captureId。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        try { return ok({ ports: service.listPorts() }); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_open',
      description: '打开串口并开始录制。返回 portId 与 captureId；captureId 是之后找回这次调试现场的锚点。',
      parameters: {
        type: 'object',
        properties: {
          port: { type: 'string', description: '端口名，例如 COM3 或 MOCK:CM4' },
          baudRate: { type: 'number', description: '波特率，默认 115200' },
          project: { type: 'string', description: '工程名，默认取工作区文件夹名' },
          conversation: { type: 'string', description: '对话名，用于文件名，默认会话标题' },
          sessionId: { type: 'string', description: '会话 id，用于跨对话追溯' },
        },
        required: ['port'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (!args || !args.port) return badArg('port is required');
        // Model opens always take over (SPEC 23.5). The owner travels with the
        // call so the panel can tell a live agent holder from a stale session.
        try { return ok(await service.open({ ...args, owner: ownerOf(exec), autoTakeover: true })); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_close',
      description: '关闭串口并落盘。返回该次录制的文件路径、字节数与行数。',
      parameters: { type: 'object', properties: { portId: { type: 'number' } }, required: ['portId'], additionalProperties: false },
      async execute(args, exec) {
        if (!args || typeof args.portId !== 'number') return badArg('portId is required');
        // Closing ends someone's recording, so it is owner-gated like writing.
        // A takeover (serial_open) is the sanctioned way to end another's capture.
        try { return ok(await service.close(args.portId, { owner: ownerOf(exec) })); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_tail',
      description: '按 cursor 增量读取串口输出。返回新行与新的 cursor；上下文被压缩后不要重读全部，用返回的 cursor 继续。',
      parameters: {
        type: 'object',
        properties: {
          portId: { type: 'number' },
          cursor: { type: 'number', description: '上次返回的 cursor，省略表示从当前开始' },
          maxLines: { type: 'number', description: '本次最多返回多少行，默认 200' },
          timeoutMs: { type: 'number', description: '没有数据时最多等多久，默认 0（立即返回）' },
          lineEnding: { type: 'string', enum: ['any', 'crlf', 'lf'], description: '断行策略：any=\r 或 \n 都断（默认）；crlf=只有 \r\n 断；lf=只有 \n 断' },
        },
        required: ['portId'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || typeof args.portId !== 'number') return badArg('portId is required');
        try { return ok(await service.tail(args)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_send',
      description: '向串口发送数据。text 与 hex 二选一；append 控制行尾（none/cr/lf/crlf）。',
      parameters: {
        type: 'object',
        properties: {
          portId: { type: 'number' },
          text: { type: 'string' },
          hex: { type: 'string', description: '十六进制字节串，例如 1b5b41' },
          append: { type: 'string', enum: ['none', 'cr', 'lf', 'crlf'] },
        },
        required: ['portId'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (!args || typeof args.portId !== 'number') return badArg('portId is required');
        if (!args.text && !args.hex) return badArg('text or hex is required');
        if (args.text && args.hex) return badArg('text and hex are mutually exclusive; pass one of them');
        let payload;
        if (args.hex) {
          const clean = String(args.hex).replace(/\s+/g, '');
          if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
            return badArg('hex must be an even number of hex digits, got ' + JSON.stringify(args.hex));
          }
          payload = Buffer.from(clean, 'hex');
        }
        else payload = Buffer.from(String(args.text), 'utf8');
        const tail = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' }[args.append || 'none'] ?? '';
        if (tail) payload = Buffer.concat([payload, Buffer.from(tail, 'utf8')]);
        try { return ok(await service.send(args.portId, payload, { owner: ownerOf(exec) })); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_captures',
      description: '查询历史录制。上下文被压缩后先调用它找回当前对话正在使用的文件；支持按工程、时间、关键词过滤。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          since: { type: 'number', description: '起始时间，epoch ms' },
          until: { type: 'number', description: '结束时间，epoch ms' },
          keyword: { type: 'string', description: '在 digest 中模糊匹配，例如 i2c / timeout' },
          limit: { type: 'number', description: '最多返回条数，默认 20' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        try { return ok({ captures: await service.captures(args || {}) }); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_grep',
      description: '在单个录制内按正则检索，返回行号、方向、时间戳与前后文。',
      parameters: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          pattern: { type: 'string' },
          context: { type: 'number', description: '命中行前保留多少行上下文，默认 2' },
          maxHits: { type: 'number', description: '默认 50' },
        },
        required: ['captureId', 'pattern'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.captureId || !args.pattern) return badArg('captureId and pattern are required');
        try {
          const hits = await service.grep(args.captureId, args.pattern, { context: args.context, maxHits: args.maxHits });
          return ok({ captureId: args.captureId, hits, count: hits.length });
        } catch (e) {
          if (e instanceof SerialError && e.code === 'E_NO_SUCH_CAPTURE') {
            e.hint = 'This captureId is unknown. Call serial_captures() to list what exists in this workspace.';
            e.fix = ['serial_captures({keyword})', 'pick a captureId from the result'];
          }
          return fail(e);
        }
      },
    },
    {
      name: 'serial_export',
      description: '把录制导出成可读文本（行首时间戳）、hex 或 csv。原始 .slog 不会被修改。',
      parameters: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          format: { type: 'string', enum: ['text', 'hex', 'csv'] },
          timestamps: { type: 'boolean', description: '文本格式是否在行首加时间戳，默认 true' },
          encoding: { type: 'string', enum: ['utf-8', 'gbk', 'latin1'] },
          out: { type: 'string', description: '输出路径，默认与 .slog 同目录同名 .txt' },
        },
        required: ['captureId'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.captureId) return badArg('captureId is required');
        if (args.format !== undefined && !['text', 'hex', 'csv'].includes(args.format)) return badArg('format must be text, hex or csv');
        try { return ok(await service.exportCapture(args.captureId, args)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_scan',
      description: '用一个扫描脚本扫某个录制，产出故障点。脚本是工作区里的 .mjs 文件，导出 createScanner(ctx)，只看到字节流；插件不保存规则，脚本怎么管理由工作区决定。',
      parameters: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          script: { type: 'string', description: '脚本绝对路径或相对工作区的路径，必须在工作区内' },
          label: { type: 'string', description: '标记归属名，默认取脚本文件名' },
          timeoutMs: { type: 'number', description: '默认 20000' },
        },
        required: ['captureId', 'script'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (!args || !args.captureId) return badArg('captureId is required');
        if (!args.script) return badArg('script is required: pass the path of a .mjs scan script');
        // Cancelling the tool call must kill the sandboxed scanner, not let it
        // keep eating a dead pipe.
        try { return ok(await service.scan(args.captureId, { ...args, signal: exec && exec.signal })); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_marks',
      description: '读取故障点。只返回字节引用（dir/offset/length），不返回文本；要看内容再调 serial_bytes。',
      parameters: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          rule: { type: 'string' },
          severity: { type: 'string', enum: ['error', 'warn', 'info'] },
          beforeMs: { type: 'number', description: '窗口向前扩多少毫秒，默认 300' },
          afterMs: { type: 'number', description: '窗口向后扩多少毫秒，默认 1000' },
        },
        required: ['captureId'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.captureId) return badArg('captureId is required');
        try { return ok(await service.marks(args.captureId, args)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_bytes',
      description: '按引用取原始字节。hex 是真相，text 只是方便；单次最多 8 KB，超出会标 truncated。',
      parameters: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          dir: { type: 'string', enum: ['rx', 'tx'] },
          offset: { type: 'number' },
          length: { type: 'number', description: '最多 8192' },
          format: { type: 'string', enum: ['hex', 'text', 'base64'] },
          encoding: { type: 'string' },
        },
        required: ['captureId', 'offset', 'length'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.captureId) return badArg('captureId is required');
        if (!Number.isFinite(Number(args.offset))) return badArg('offset must be a number');
        const length = Number(args.length);
        if (!Number.isFinite(length) || length <= 0) return badArg('length must be a positive number');
        if (length > 8192) return badArg('length is capped at 8192 bytes; call again for the next range');
        try { return ok(await service.bytes(args.captureId, args)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_fsm_start',
      description: '在一个已打开的端口上启动状态机（活体）。一个端口只允许一个状态机；发送必须声明期望回执和目标状态，场景里已强制。',
      parameters: {
        type: 'object',
        properties: {
          portId: { type: 'number' },
          scenario: { type: 'object', description: '场景对象，或传 { path } 指向工作区的 JSON 场景文件' },
        },
        required: ['portId', 'scenario'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        if (!args || !Number.isFinite(Number(args.portId))) return badArg('portId is required');
        if (!args.scenario) return badArg('scenario is required');
        try {
          const scenario = typeof args.scenario === 'string' ? args.scenario : (args.scenario.path || args.scenario);
          return ok(await service.fsmStart({ scenario, portId: args.portId, owner: ownerOf(exec) }));
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_fsm_simulate',
      description: '对着某次录制离线跑状态机，验证脚本后再上真机。不碰端口、不发数据。',
      parameters: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          scenario: { type: 'object' },
          tailMs: { type: 'number', description: '记录结束后再推进多少毫秒，用于触发 after 定时器' },
        },
        required: ['captureId', 'scenario'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.captureId || !args.scenario) return badArg('captureId and scenario are required');
        try {
          const scenario = typeof args.scenario === 'string' ? args.scenario : (args.scenario.path || args.scenario);
          return ok(await service.fsmSimulate(args.captureId, { scenario, tailMs: args.tailMs }));
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_fsm_event',
      description: '向状态机注入事件（切换操作模式）。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, name: { type: 'string' } },
        required: ['runId', 'name'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.runId || !args.name) return badArg('runId and name are required');
        try { return ok(await service.fsmEvent(args.runId, args.name)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_fsm_wait',
      description: '长轮询：等状态机产生下一次转移，或超时返回当前状态。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, timeoutMs: { type: 'number', description: '默认 5000' } },
        required: ['runId'],
        additionalProperties: false,
      },
      async execute(args) {
        if (!args || !args.runId) return badArg('runId is required');
        try { return ok(await service.fsmWait(args.runId, args)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_fsm_status',
      description: '查看状态机当前状态、允许的事件与最近轨迹。',
      parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      async execute(args) {
        if (!args || !args.runId) return badArg('runId is required');
        try { return ok(service.fsmStatus(args.runId)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_fsm_stop',
      description: '停止状态机，把过程中产生的标记写入录制的 .marks。',
      parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      async execute(args) {
        if (!args || !args.runId) return badArg('runId is required');
        try { return ok(await service.fsmStop(args.runId)); } catch (e) { return fail(e); }
      },
    },
    {
      name: 'serial_cleanup',
      description: '查看历史录制的保留情况（只读）：返回若按当前策略清理会涉及多少条、多少字节、跳过多少条人的录制。它不会删除任何东西；删除不由模型发起。',
      parameters: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: '默认 true：只给计划，不删。' },
          olderThanDays: { type: 'number', description: '只清早于 N 天的录制，默认 0（不限）' },
          keepLast: { type: 'number', description: '保留最近的 N 条，其余可清，默认 0' },
          project: { type: 'string', description: '只清某个工程的录制' },
          includeHuman: { type: 'boolean', description: '默认 false：只看 agent 自己录的；人类自己开的录制不动' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const opts = args || {};
        // 只读：删除永远不是模型能发起的行为（用户明确要求）。
        if (opts.planId) {
          return fail(new SerialError('E_READ_ONLY', 'recording deletion is not a model action', {
            hint: 'This tool only reports the retention plan. Deleting recordings is a human decision, done outside the tool surface.',
            fix: ['serial_cleanup({olderThanDays, keepLast}) to inspect', 'ask the user to delete the capture themselves'],
            retryable: false,
          }));
        }
        try { return ok(await service.cleanup({ ...opts, planOnly: true })); } catch (e) { return fail(e); }
      },
    },  ];

  // DSH requires every tool to declare how its result is rendered.
  const output = {
    schema: { type: 'object' },
    render: (_args, value) => [
      {
        type: 'text',
        text: (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).slice(0, 8000),
      },
    ],
  };
  for (const tool of list) if (!tool.output) tool.output = output;
  return list;
}