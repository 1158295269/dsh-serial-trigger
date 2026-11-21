/**
 * Minimal CDP driver: enough to click, read text and take screenshots.
 */
export class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.console = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('ws failed'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.console.push(msg.params.type + ': ' + text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.console.push('EXCEPTION: ' + String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
      }
    };
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    return this;
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async goto(url, waitMs = 6000) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error('eval failed: ' + (res.result.exceptionDetails.exception?.description || ''));
    return res.result?.result?.value;
  }

  /** Click the first element whose trimmed text equals (or contains) the label. */
  async clickText(label, { exact = true, tag = '*' } = {}) {
    return this.eval(`(() => {
      const nodes = [...document.querySelectorAll(\`${tag}\`)];
      const el = nodes.reverse().find((n) => {
        if (n.children.length > 2) return false;
        const t = (n.textContent || '').trim();
        return ${exact ? 't === ' + JSON.stringify(label) : 't.includes(' + JSON.stringify(label) + ')'};
      });
      if (!el) return 'not-found';
      (el.closest('button,[role=button],[role=tab],a') || el).click();
      return 'clicked';
    })()`);
  }

  async text(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : null })()`);
  }

  async exists(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  }

  async screenshot(path, fs) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    if (path && fs) fs.writeFileSync(path, Buffer.from(shot.result?.data ?? '', 'base64'));
    return path;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
