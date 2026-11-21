/**
 * UI scenarios against a running DSH instance.
 *
 *   node test/ui/run.mjs --base http://127.0.0.1:51990 --token XXX [--only layout]
 *
 * Every scenario prints PASS/FAIL with the evidence it used, and writes a
 * screenshot into test/ui/out/ so a failure can be inspected without re-running.
 */
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page, sleep } from './page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
await mkdir(outDir, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const BASE = args.base || 'http://127.0.0.1:51990';
const TOKEN = args.token || '';

const results = [];
function record(name, ok, detail, shot) {
  results.push({ name, ok, detail, shot });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

async function connect() {
  const target = await (await fetch('http://127.0.0.1:9343/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
  const page = await new Page(target.webSocketDebuggerUrl).open();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
  await page.goto(BASE + '/?token=' + TOKEN, 8000);
  return page;
}

/** Open the first real conversation so the view tabs exist. */
async function openSession(page) {
  const clicked = await page.clickText('dsh-publisher-radar 是什么', { exact: false });
  await sleep(2500);
  return clicked;
}

async function openSerialView(page) {
  return page.eval(`(() => {
    const el = [...document.querySelectorAll('span')].find((n) => (n.textContent || '').trim() === '串口' && String(n.className).includes('tabLabel'));
    if (!el) return 'not-found';
    (el.closest('button,[role=tab]') || el).click();
    return 'clicked';
  })()`);
}

const page = await connect();
const only = args.only;

// S1: the view tab exists next to 对话/轨迹
if (!only || only === 'view-tab') {
  const session = await openSession(page);
  const tabs = await page.eval("(() => [...document.querySelectorAll('span')].filter(n => String(n.className).includes('tabLabel')).map(n => n.textContent.trim()))()");
  const ok = Array.isArray(tabs) && tabs.includes('串口');
  const shot = join(outDir, 'view-tab.png');
  await page.screenshot(shot, fs);
  record('view-tab: 「串口」标签出现在会话头部', ok, 'session=' + session + ' tabs=' + JSON.stringify(tabs), shot);
}

// S2: clicking it keeps the session and renders the panel inside the view area
if (!only || only === 'layout') {
  await openSerialView(page);
  await sleep(1200);
  const layout = await page.eval(`(() => {
    const root = document.querySelector('.sst-root');
    if (!root) return { found: false };
    const r = root.getBoundingClientRect();
    let box = root.parentElement;
    while (box && box !== document.body && box.clientHeight <= 80) box = box.parentElement;
    const hostH = box && box !== document.body ? box.clientHeight : 0;
    return { found: true, rootH: Math.round(r.height), hostH: Math.round(hostH), bottom: Math.round(r.bottom), vh: window.innerHeight, top: Math.round(r.top) };
  })()`);
  const ok = layout.found && layout.hostH > 0 && Math.abs(layout.rootH - layout.hostH) <= 2 && layout.bottom <= layout.vh;
  const shot = join(outDir, 'layout.png');
  await page.screenshot(shot, fs);
  record('layout: 面板高度贴合容器且不越过视口', ok, JSON.stringify(layout), shot);
}

// S3: the identity shown in the status bar tells us whether a real session id arrived
if (!only || only === 'identity') {
  const status = await page.text('.sst-status');
  const m = /身份\s*(\S+)/.exec(status || '');
  const id = m ? m[1] : '';
  const real = /^session-|^[0-9a-f]{8}-/.test(id);
  record('identity: 状态栏显示身份', !!id, 'id=' + id + (real ? ' (真实 sessionId)' : ' (退化为实例 id)'));
}

// S4: ports render and a capture list is present
if (!only || only === 'ports') {
  const ports = await page.text('.sst-side');
  const hasCom = /COM\d/.test(ports || '');
  record('ports: 端口列表渲染', hasCom, (ports || '').split('\n').slice(0, 6).join(' | '));
}


// S5: ownership — a session that did not open the port must not write or close it
if (!only || only === 'ownership') {
  const boot = await fetch(BASE + '/?token=' + TOKEN, { redirect: 'manual' });
  const cookie = (boot.headers.getSetCookie?.() ?? [boot.headers.get('set-cookie') ?? ''])[0].split(';')[0];
  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const opened = await api('POST', '/serial/open', { port: 'MOCK:UIT', baudRate: 115200, sessionId: 'session-A' });
  const portId = opened.json?.portId;
  const foreignSend = await api('POST', '/serial/send', { portId, text: 'x', sessionId: 'session-B' });
  const ownSend = await api('POST', '/serial/send', { portId, text: 'x', sessionId: 'session-A' });
  const foreignClose = await api('POST', '/serial/close', { portId, sessionId: 'session-B' });
  const ownClose = await api('POST', '/serial/close', { portId, sessionId: 'session-A' });

  const blocked = foreignSend.json?.error?.code === 'E_NOT_OWNER' && foreignClose.json?.error?.code === 'E_NOT_OWNER';
  record('ownership: 非 owner 不能写、不能关', blocked, JSON.stringify({
    open: opened.status, foreignSend: foreignSend.json?.error?.code, ownSend: ownSend.status,
    foreignClose: foreignClose.json?.error?.code, ownClose: ownClose.status,
  }));
}


// S6: switching sessions must change the identity the panel uses
if (!only || only === 'identity-switch') {
  const readId = async () => {
    const status = await page.text('.sst-status');
    const m = /身份\s*(\S+)/.exec(status || '');
    return m ? m[1] : '';
  };
  await page.clickText('dsh-publisher-radar 是什么', { exact: false });
  await sleep(2500);
  await openSerialView(page);
  await sleep(1200);
  const idA = await readId();

  await page.clickText('三家订阅性价比口碑对比', { exact: false });
  await sleep(2500);
  await openSerialView(page);
  await sleep(1200);
  const idB = await readId();

  record('identity-switch: 切会话后身份跟随', !!idA && !!idB && idA !== idB, idA + ' -> ' + idB);
}


// S7: a port opened by another session must read as 被占用 in this panel
if (!only || only === 'occupied-label') {
  const boot = await fetch(BASE + '/?token=' + TOKEN, { redirect: 'manual' });
  const cookie = (boot.headers.getSetCookie?.() ?? [boot.headers.get('set-cookie') ?? ''])[0].split(';')[0];
  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const opened = await api('POST', '/serial/open', { port: 'MOCK:UIT', baudRate: 115200, sessionId: 'session-other' });
  await openSerialView(page);
  await sleep(800);
  // the panel polls /serial/state every 1.5 s; give it one cycle
  await sleep(2000);
  const side = await page.text('.sst-side');
  const row = (side || '').split('\n').find((l) => l.includes('MOCK:UIT')) || '';
  const status = await page.text('.sst-status');
  const me = (/身份\s*(\S+)/.exec(status || '') || [])[1] || '';
  const marked = /被占用/.test(side || '');
  record('occupied-label: 他人端口显示被占用', marked && opened.status === 200, 'row=' + row + ' me=' + me);
  await api('POST', '/serial/close', { portId: opened.json?.portId, sessionId: 'session-other' });
}

const pass = results.filter((r) => r.ok).length;
console.log('\nsummary: ' + pass + '/' + results.length);
console.log('console errors:', page.console.filter((l) => /error|EXCEPTION/i.test(l)).slice(0, 5).join(' | ') || '(none)');
process.exit(pass === results.length ? 0 : 1);
