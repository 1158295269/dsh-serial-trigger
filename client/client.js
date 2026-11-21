// dsh-serial-trigger, browser half.
//
// Plain hand-written bundle, same shape as DSH's shipped client modules: the
// module loader hands us a require, the only module asked for is React.
// Layout: ports and recordings on the left, log in the middle, statistics on a
// second tab. The log is virtualised: only the visible slice is mounted, so a
// 5000 lines/second stream cannot freeze the window.
window.__ModuleLoader__.load({
  id: 'dsh-serial-trigger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'serial-trigger'
    const API = '/serial'
    const ROW = 19
    const MAX_LINES = 20000
    const SAMPLES = 120

    const CSS = ".sst-root{display:grid;grid-template-columns:236px 1fr;height:100%;gap:10px;padding:12px;box-sizing:border-box;font:13px/1.45 -apple-system,\"Segoe UI\",\"Microsoft YaHei\",system-ui,sans-serif;color:#1f2328}\n.sst-side{background:#fff;border:1px solid #e4e5e9;border-radius:12px;padding:13px;display:flex;flex-direction:column;gap:14px;overflow:auto}\n.sst-sec h4{margin:0 0 7px;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8b929c;font-weight:600}\n.sst-port{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:9px;cursor:pointer}\n.sst-port:hover{background:#f7f8fa}.sst-port.on{background:#f2f5f9}\n.sst-name{font-weight:600;font-size:12.5px}.sst-meta{color:#98a0ab;font-size:11px;margin-top:1px}\n.sst-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#ccd1d8}\n.sst-dot.on{background:#2f9e75;box-shadow:0 0 0 3px rgba(47,158,117,.15)}\n.sst-rec{padding:7px 8px;border-radius:9px;cursor:pointer}.sst-rec:hover{background:#f7f8fa}.sst-rec.on{background:#f2f5f9}\n.sst-rec .a{font-size:12.5px}.sst-rec .b{font-size:11px;color:#98a0ab;margin-top:2px;display:flex;gap:8px}\n.sst-main{background:#fff;border:1px solid #e4e5e9;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;min-width:0}\n.sst-head{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid #eef0f2;flex-wrap:wrap}\n.sst-tabs{display:flex;background:#f1f2f4;border-radius:8px;padding:2px}\n.sst-tabs button{border:0;background:transparent;padding:3px 11px;border-radius:6px;color:#5b616e;font-size:12px;cursor:pointer}\n.sst-tabs button.on{background:#fff;color:#1f2328;box-shadow:0 1px 2px rgba(0,0,0,.05)}\n.sst-grow{flex:1}\n.sst-chip{border:1px solid #e2e3e6;background:#fff;color:#5b616e;border-radius:999px;padding:2px 9px;font-size:11.5px;cursor:pointer}\n.sst-chip.on{background:#1f2328;color:#fff;border-color:#1f2328}\n.sst-btn{border:1px solid #d9dbe0;background:#fff;border-radius:7px;padding:4px 11px;color:#2b313a;font-size:12px;cursor:pointer}\n.sst-btn.primary{background:#1f2328;color:#fff;border-color:#1f2328}\n.sst-log{flex:1;overflow:auto;padding:6px 0;font-family:\"Cascadia Mono\",Consolas,monospace;font-size:12px;position:relative}\n.sst-line{display:grid;grid-template-columns:96px 16px 1fr;gap:7px;padding:0 16px;line-height:19px;white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere}\n.sst-line:hover{background:#fafbfc}.sst-t{color:#a8aeb7}.sst-d{color:#c6ccd4}\n.sst-tx{color:#2563eb}.sst-err{color:#cf5656}.sst-errline{background:rgba(207,86,86,.07)}\n.sst-pending{opacity:.55;font-style:italic}\n.sst-spacer{position:relative}\n.sst-slice{position:absolute;left:0;right:0}\n.sst-hexline{display:grid;grid-template-columns:96px 72px 1fr;gap:8px;padding:0 16px;height:19px;line-height:19px;white-space:pre}\n.sst-off{color:#b3b9c2}.sst-bytes{color:#3d444d}\n.sst-send{display:flex;gap:8px;padding:9px 13px;border-top:1px solid #eef0f2;align-items:center}\n.sst-send input{flex:1;font:inherit;border:1px solid #dcdee3;border-radius:8px;padding:6px 10px}\n.sst-send select,.sst-head select{font:inherit;border:1px solid #dcdee3;border-radius:8px;padding:4px 7px;background:#fff;font-size:12px}\n.sst-status{display:flex;gap:16px;padding:5px 14px;border-top:1px solid #f1f2f4;color:#7b8390;font-size:11px;background:#fbfbfc}\n.sst-status b{color:#414852}\n.sst-empty{padding:40px 20px;color:#98a0ab;text-align:center;font-size:12px}\n.sst-stats{padding:18px 20px;overflow:auto}\n.sst-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}\n.sst-card{border:1px solid #eceef1;border-radius:11px;padding:13px 15px}\n.sst-card .k{color:#8b929c;font-size:11px}.sst-card .v{font-size:21px;font-weight:600;margin-top:5px}\n.sst-card .s{color:#98a0ab;font-size:11px;margin-top:3px}\n.sst-chart{margin-top:16px;border:1px solid #eceef1;border-radius:11px;padding:13px 15px 6px}\n.sst-chart h5{margin:0 0 2px;font-size:12px;color:#4b525c}.sst-chart .sub{color:#98a0ab;font-size:11px}"

    const CSS_EXTRA = [
      '.sst-menu{position:fixed;z-index:60;min-width:184px;background:#fff;border:1px solid #e2e4e8;border-radius:9px;padding:4px;box-shadow:0 10px 26px rgba(20,24,30,.14)}',
      '.sst-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:7px 10px;border-radius:6px;font-size:12.5px;color:#2b313a;cursor:pointer}',
      '.sst-menu button:hover{background:#f3f5f8}',
      '.sst-menu .sep{height:1px;background:#eef0f3;margin:4px 6px}',
      '.sst-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);background:#1f2328;color:#fff;padding:7px 14px;border-radius:999px;font-size:12px;z-index:70}',
      '.sst-jump{width:136px;font:inherit;border:1px solid #dcdee3;border-radius:8px;padding:4px 8px;font-size:12px}',
      '.sst-rowsel{background:#eef4ff}',
      '.sst-hit{background:#ffe9a8}',
      '.sst-find{background:#fff7dd}',
      '.sst-mark{padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12px;border-left:3px solid transparent}',
      '.sst-mark:hover{background:#f3f5f8}',
      '.sst-mark .a{color:#2b313a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sst-mark .b{display:flex;justify-content:space-between;color:#98a0ab;font-size:11px;margin-top:2px}',
      '.sst-sev-error{border-left-color:#e5484d}',
      '.sst-sev-warn{border-left-color:#f2a33c}',
      '.sst-sev-info{border-left-color:#4b8bf5}',
      '.sst-modal{position:fixed;inset:0;background:rgba(20,24,30,.28);display:flex;align-items:center;justify-content:center;z-index:80}',
      '.sst-dialog{background:#fff;border-radius:12px;padding:18px;width:380px;box-shadow:0 20px 50px rgba(20,24,30,.25)}',
      '.sst-dialog h3{margin:0 0 4px;font-size:14px}',
      '.sst-dialog label{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:#4b525c}',
      '.sst-dialog label select,.sst-dialog label input[type=text]{flex:1;font:inherit;border:1px solid #dcdee3;border-radius:8px;padding:5px 8px;font-size:12px}',
      '.sst-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
    ].join('\n')

    let stylesInjected = false
    function ensureStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const el = document.createElement('style')
      el.setAttribute('data-dsh-serial-trigger', '')
      el.textContent = CSS + CSS_EXTRA
      document.head.appendChild(el)
    }

    async function api(method, path, body) {
      // Tolerate callers that already include the '/serial' prefix: silently
      // producing '/serial/serial/x' turned every one of them into a 404.
      const rel = path.startsWith('/serial/') ? path.slice('/serial'.length) : path
      const res = await fetch(API + rel, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
      return json
    }

    function displayWidth(text) {
      let w = 0
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) { w += 2; i += 1; continue }
        w += code > 0x2e80 ? 2 : 1
      }
      return w
    }

    function fmtBytes(n) {
      if (!n) return '0 B'
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1048576).toFixed(2) + ' MB'
    }

    function hexOf(text, limit) {
      const bytes = new TextEncoder().encode(text)
      const parts = []
      const n = Math.min(bytes.length, limit || 32)
      for (let i = 0; i < n; i += 1) parts.push(bytes[i].toString(16).padStart(2, '0'))
      if (bytes.length > n) parts.push('…')
      return parts.join(' ')
    }

    function asciiOf(text, limit) {
      const bytes = new TextEncoder().encode(text)
      let out = ''
      const n = Math.min(bytes.length, limit || 32)
      for (let i = 0; i < n; i += 1) out += bytes[i] >= 32 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : '.'
      return out
    }

    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (e) {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        let ok = false
        try { ok = document.execCommand('copy') } catch (err) { ok = false }
        ta.remove()
        return ok
      }
    }

    function escapeText(text) {
      return text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
    }

    function Icon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none' },
        h('rect', { x: 2.5, y: 4.5, width: 13, height: 9, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M5.5 7.5v3M8 7.5v3M10.5 7.5v3M13 7.5v3', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }))
    }

    function Spark(props) {
      const values = props.values
      if (!values.length) return h('div', { className: 'sst-empty' }, '等待采样…')
      const w = 900, hgt = 140, max = Math.max(1, ...values)
      const step = values.length > 1 ? w / (values.length - 1) : w
      const pts = values.map((v, i) => [i * step, hgt - (v / max) * (hgt - 8)])
      const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')
      const area = line + ' L' + w + ',' + hgt + ' L0,' + hgt + ' Z'
      return h('svg', { viewBox: '0 0 ' + w + ' ' + hgt, width: '100%', height: 150, preserveAspectRatio: 'none' },
        h('defs', null, h('linearGradient', { id: 'sst-g', x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: 0, stopColor: '#4f8ff0', stopOpacity: 0.18 }),
          h('stop', { offset: 1, stopColor: '#4f8ff0', stopOpacity: 0 }))),
        h('path', { d: area, fill: 'url(#sst-g)' }),
        h('path', { d: line, fill: 'none', stroke: '#4f8ff0', strokeWidth: 2, strokeLinejoin: 'round' }))
    }

    function Panel(props) {
      const sessionId = (props && props.sessionId) || ''
      const [state, setState] = React.useState({ ports: [], captures: [] })
      const [active, setActive] = React.useState(null)
      const [lines, setLines] = React.useState([])
      const [pending, setPending] = React.useState(null)
      const [totals, setTotals] = React.useState({ rx: 0, tx: 0 })
      const [tab, setTab] = React.useState('log')
      const [view, setView] = React.useState('text')
      const [lineEnding, setLineEnding] = React.useState('any')
      const [filter, setFilter] = React.useState('all')
      const [follow, setFollow] = React.useState(true)
      const [scrollTop, setScrollTop] = React.useState(0)
      const [cols, setCols] = React.useState(100)
      const [charW, setCharW] = React.useState(7.2)
      const [viewH, setViewH] = React.useState(560)
      const [rates, setRates] = React.useState([])
      const [peak, setPeak] = React.useState(0)
      const [error, setError] = React.useState('')
      const [menu, setMenu] = React.useState(null)
      const [toast, setToast] = React.useState('')
      const [mode, setMode] = React.useState('live')
      const [historyMeta, setHistoryMeta] = React.useState(null)
      const [marks, setMarks] = React.useState([])
      const [sources, setSources] = React.useState([])
      const [onlyMarks, setOnlyMarks] = React.useState(false)
      const [rescanning, setRescanning] = React.useState(false)
      const [capMenu, setCapMenu] = React.useState(null)
      const [exportDlg, setExportDlg] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [matches, setMatches] = React.useState([])
      const [matchIdx, setMatchIdx] = React.useState(-1)
      const lastQuery = React.useRef('')

      const cursor = React.useRef(0)
      const followRef = React.useRef(true)
      const logRef = React.useRef(null)
      const lastSample = React.useRef(null)

      React.useEffect(() => { ensureStyles() }, [])

      React.useEffect(() => {
        const el = logRef.current
        if (!el || typeof ResizeObserver === 'undefined') return
        let cw = charW
        const measure = () => {
          if (!cw) {
            const probe = document.createElement('span')
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:12px "Cascadia Mono",Consolas,monospace'
            probe.textContent = 'M'.repeat(100)
            document.body.appendChild(probe)
            cw = probe.getBoundingClientRect().width / 100 || 7.2
            probe.remove()
            setCharW(cw)
          }
          const avail = Math.max(160, el.clientWidth - 32 - 96 - 16 - 21)
          setCols(Math.max(16, Math.floor(avail / cw)))
          setViewH(el.clientHeight)
        }
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }, [tab, view])
      React.useEffect(() => { followRef.current = follow }, [follow])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try { const s = await api('GET', '/state'); if (alive) setState(s) } catch (e) { /* boot */ }
        }
        tick()
        const id = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(id) }
      }, [])

      React.useEffect(() => {
        if (!active) return
        let alive = true
        let timer = null
        const poll = async () => {
          try {
            const res = await api('GET', '/tail?portId=' + active + '&cursor=' + cursor.current + '&lineEnding=' + lineEnding)
            if (!alive) return
            cursor.current = res.cursor
            if (res.lines && res.lines.length) {
              setLines((prev) => {
                const next = prev.concat(res.lines)
                return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
              })
            }
            setPending(res.pending || null)
            if (typeof res.bytesRx === 'number') setTotals({ rx: res.bytesRx, tx: res.bytesTx || 0 })

            const now = Date.now()
            const last = lastSample.current
            if (last) {
              const dt = (now - last.at) / 1000
              if (dt > 0.2) {
                const rate = Math.max(0, (res.bytesRx - last.rx) / dt)
                lastSample.current = { at: now, rx: res.bytesRx }
                setRates((prev) => {
                  const next = prev.concat(rate)
                  return next.length > SAMPLES ? next.slice(next.length - SAMPLES) : next
                })
                setPeak((p) => (rate > p ? rate : p))
              }
            } else {
              lastSample.current = { at: now, rx: res.bytesRx || 0 }
            }
          } catch (e) { if (alive) setError(String(e.message || e)) }
          if (alive) timer = setTimeout(poll, 250)
        }
        poll()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [active, lineEnding])

      React.useEffect(() => {
        if (!followRef.current || !logRef.current) return
        // Selecting text and jumping to the bottom cannot both win: while a
        // selection exists inside the log, leave the viewport alone.
        const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
        const selecting = sel && sel.rangeCount > 0 && String(sel).length > 0 && logRef.current.contains(sel.anchorNode)
        if (selecting) return
        logRef.current.scrollTop = logRef.current.scrollHeight
      }, [lines, pending])

      React.useEffect(() => {
        if (!menu && !capMenu) return
        const close = () => { setMenu(null); setCapMenu(null) }
        const onKey = (e) => { if (e.key === 'Escape') { setMenu(null); setCapMenu(null) } }
        window.addEventListener('click', close)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('click', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [menu, capMenu])

      React.useEffect(() => {
        if (!toast) return
        const id = setTimeout(() => setToast(''), 1600)
        return () => clearTimeout(id)
      }, [toast])

      const open = async (port, opts) => {
        setError('')
        try {
          const res = await api('POST', '/open', { port, baudRate: 115200, project: 'default', sessionId, takeover: !!(opts && opts.takeover) })
          cursor.current = 0
          setLines([]); setRates([]); setPeak(0); setPending(null); lastSample.current = null
          setActive(res.portId)
        } catch (e) { setError(String(e.message || e)) }
      }

      const close = async () => {
        if (!active) return
        try { await api('POST', '/close', { portId: active }); setActive(null); setLines([]); setPending(null) }
        catch (e) { setError(String(e.message || e)) }
      }

      const send = async () => {
        if (!active || !draft) return
        try { await api('POST', '/send', { portId: active, text: draft, append: 'crlf' }); setDraft('') }
        catch (e) { setError(String(e.message || e)) }
      }

      const [draft, setDraft] = React.useState('')
      const baseVisible = filter === 'all' ? lines : lines.filter((l) => l.dir === filter)
      const visible = onlyMarks && marks.length
        ? baseVisible.filter((l) => marks.some((m) => Math.abs((l.t || 0) - (m.t || 0)) <= 1000))
        : baseVisible

      const rowAt = (offsetY) => {
        const row = Math.max(0, offsetY) / ROW
        let lo = 0
        let hi = Math.max(0, visible.length - 1)
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if ((layout.tops[mid] || 0) <= row) lo = mid
          else hi = mid - 1
        }
        return lo
      }

      const copySelection = async () => {
        setMenu(null)
        const sel = typeof window !== 'undefined' && window.getSelection ? String(window.getSelection()) : ''
        if (!sel) { setToast('没有选中内容'); return }
        setToast((await copyToClipboard(sel)) ? '已复制选中内容' : '复制失败')
      }
      const copyRow = async (i, withTs) => {
        setMenu(null)
        const l = visible[i]
        if (!l) return
        const ts = withTs ? new Date(l.t || Date.now()).toISOString().slice(11, 23) + ' ' : ''
        setToast((await copyToClipboard(ts + l.text)) ? '已复制第 ' + (i + 1) + ' 行' : '复制失败')
      }
      const copyRowHex = async (i) => {
        setMenu(null)
        const l = visible[i]
        if (!l) return
        setToast((await copyToClipboard(hexOf(l.text, 100000))) ? '已复制为 Hex' : '复制失败')
      }
      const copyRowEscape = async (i) => {
        setMenu(null)
        const l = visible[i]
        if (!l) return
        setToast((await copyToClipboard(escapeText(l.text))) ? '已复制为转义文本' : '复制失败')
      }
      const jumpToMark = (mark) => {
        const idx = visible.findIndex((l) => (l.t || 0) >= (mark.t || 0))
        if (idx < 0) { setToast('标记时间不在当前视图'); return }
        setFollow(false)
        if (logRef.current) logRef.current.scrollTop = (layout.tops[idx] || 0) * ROW
        setToast(mark.label || '故障点')
      }

      const rescan = async () => {
        if (!historyMeta) return
        const scripts = sources.filter((s) => s.script)
        if (scripts.length === 0) {
          setToast('还没有扫描过：让 Agent 用 serial_scan 扫一次，脚本会留在工作区')
          return
        }
        setRescanning(true)
        try {
          const done = []
          for (const s of scripts) {
            const r = await api('POST', '/scan', { captureId: historyMeta.id, script: s.script, label: s.label })
            done.push((r.label || s.label) + ':' + r.marks)
          }
          const m = await api('GET', '/marks?captureId=' + encodeURIComponent(historyMeta.id))
          setMarks(m.marks || [])
          setSources(m.sources || [])
          setToast('重扫完成 ' + done.join('  '))
        } catch (e) { setToast(String(e.message || e)) }
        setRescanning(false)
      }

      const copyQuote = async (i) => {
        setMenu(null)
        const l = visible[i]
        if (!l) return
        const ts = new Date(l.t || Date.now()).toISOString().slice(11, 23)
        const body = String(l.text).split('\n').map((s) => '> ' + s).join('\n')
        const ok = await copyToClipboard('> [' + ts + '] ' + body.replace(/^> /, ''))
        setToast(ok ? '已复制引用块，粘贴到输入框即可' : '复制失败')
      }
      const runSearch = (delta) => {
        const q = query.trim().toLowerCase()
        if (!q) { setMatches([]); setMatchIdx(-1); setToast('输入关键词后回车'); return }
        let list = matches
        if (list.length === 0 || lastQuery.current !== q) {
          list = []
          for (let i = 0; i < visible.length; i += 1) {
            if (String(visible[i].text).toLowerCase().includes(q)) list.push(i)
          }
          lastQuery.current = q
          setMatches(list)
        }
        if (list.length === 0) { setMatchIdx(-1); setToast('没有匹配'); return }
        const step = delta === undefined ? 1 : delta
        const next = ((matchIdx < 0 ? (step > 0 ? -1 : 0) : matchIdx) + step + list.length) % list.length
        setMatchIdx(next)
        setFollow(false)
        if (logRef.current) logRef.current.scrollTop = (layout.tops[list[next]] || 0) * ROW
        setToast((next + 1) + ' / ' + list.length)
      }

      const openCapture = async (cap) => {
        try {
          const res = await api('GET', '/capture?id=' + encodeURIComponent(cap.id))
          setLines(res.lines || [])
          setHistoryMeta(res)
          setMode('history')
          setActive(null)
          setPending(null)
          setFollow(false)
          setMatches([])
          setMatchIdx(-1)
          if (res.lines) setLines(res.lines)
          try {
            const m = await api('GET', '/marks?captureId=' + encodeURIComponent(cap.id))
            setMarks(m.marks || [])
            setSources(m.sources || [])
          } catch (e) { setMarks([]); setSources([]) }
          setToast('已打开录制（只读）')
        } catch (e) { setToast(String(e.message || e)) }
      }

      const deleteCapture = async (cap) => {
        if (typeof window !== 'undefined' && !window.confirm('删除录制 ' + cap.id + ' ？文件会被直接删掉。')) return
        try {
          await api('POST', '/delete', { captureId: cap.id })
          if (historyMeta && historyMeta.id === cap.id) { setMode('live'); setHistoryMeta(null); setLines([]) }
          setToast('已删除')
          const s = await api('GET', '/state')
          setState(s)
        } catch (e) { setToast(String(e.message || e)) }
      }
      const activeMeta = active === null ? null : state.ports.find((p) => p.portId === active)

      // Monospace + known column count = exact row counts, so a wrapped list can
      // still be virtualised without measuring a single DOM node.
      const layout = React.useMemo(() => {
        const tops = new Array(visible.length)
        let acc = 0
        for (let i = 0; i < visible.length; i += 1) {
          tops[i] = acc
          acc += Math.max(1, Math.ceil(displayWidth(visible[i].text) / cols))
        }
        return { tops, total: acc }
      }, [visible, cols])

      const rowOf = (i) => (layout.tops[i + 1] === undefined ? layout.total : layout.tops[i + 1]) - layout.tops[i]

      let lo = 0
      let hi = visible.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (layout.tops[mid] * ROW < scrollTop) lo = mid + 1
        else hi = mid
      }
      const start = Math.max(0, lo - 6)
      let end = start
      while (end < visible.length && layout.tops[end] * ROW < scrollTop + viewH + ROW * 6) end += 1
      const slice = visible.slice(start, end)
      const rateNow = rates.length ? rates[rates.length - 1] : 0

      const capMenuNode = capMenu
        ? h('div', { className: 'sst-menu', style: { left: capMenu.x, top: capMenu.y } },
            h('button', { onClick: () => { const cap = capMenu.cap; setCapMenu(null); openCapture(cap) } }, '打开（只读）'),
            h('button', {
              onClick: () => {
                const cap = capMenu.cap
                setCapMenu(null)
                setExportDlg({ cap, format: 'text', timestamps: true, encoding: 'utf-8', out: '' })
              },
            }, '导出…'),
            h('button', {
              onClick: async () => {
                const cap = capMenu.cap
                setCapMenu(null)
                setToast((await copyToClipboard(cap.path || cap.id)) ? '已复制文件路径' : '复制失败')
              },
            }, '复制文件路径'),
            h('button', {
              onClick: async () => {
                const cap = capMenu.cap
                setCapMenu(null)
                const txt = '> 录制 ' + (cap.port || '未知端口') + ' · ' + new Date(cap.startedMs || Date.now()).toLocaleString() + ' · ' + fmtBytes(cap.bytes) + ' · ' + cap.id
                setToast((await copyToClipboard(txt)) ? '已复制引用块，粘贴到输入框即可' : '复制失败')
              },
            }, '引用到对话'),
            h('div', { className: 'sep' }),
            h('button', { onClick: () => { const cap = capMenu.cap; setCapMenu(null); deleteCapture(cap) } }, '删除录制…'))
        : null
      const doExport = async () => {
        const d = exportDlg
        if (!d) return
        try {
          const res = await api('POST', '/export', {
            captureId: d.cap.id, format: d.format, timestamps: d.timestamps, encoding: d.encoding, out: d.out || undefined,
          })
          setExportDlg(null)
          setToast('已导出：' + res.path)
        } catch (e) { setToast(String(e.message || e)) }
      }

      const exportNode = exportDlg
        ? h('div', { className: 'sst-modal', onClick: (e) => { if (e.target === e.currentTarget) setExportDlg(null) } },
            h('div', { className: 'sst-dialog' },
              h('h3', null, '导出录制'),
              h('div', { className: 'sst-meta' }, exportDlg.cap.id),
              h('label', null, '格式',
                h('select', {
                  value: exportDlg.format,
                  onChange: (e) => setExportDlg({ ...exportDlg, format: e.target.value }),
                },
                  h('option', { value: 'text' }, '文本（可读，行首可带时间戳）'),
                  h('option', { value: 'hex' }, 'Hex 转储（偏移 + 16 字节 + ASCII）'),
                  h('option', { value: 'csv' }, 'CSV（Excel / pandas）'),
                  h('option', { value: 'jsonl' }, 'JSONL（一行一条记录）'))),
              exportDlg.format === 'text' ? h('label', null,
                h('input', { type: 'checkbox', checked: exportDlg.timestamps, onChange: (e) => setExportDlg({ ...exportDlg, timestamps: e.target.checked }) }),
                ' 行首时间戳') : null,
              exportDlg.format === 'text' ? h('label', null, '编码',
                h('select', { value: exportDlg.encoding, onChange: (e) => setExportDlg({ ...exportDlg, encoding: e.target.value }) },
                  h('option', { value: 'utf-8' }, 'UTF-8'),
                  h('option', { value: 'gbk' }, 'GBK'),
                  h('option', { value: 'latin1' }, 'Latin-1'))) : null,
              h('label', null, '输出路径',
                h('input', {
                  type: 'text',
                  value: exportDlg.out,
                  placeholder: '留空 = 与 .slog 同目录',
                  onChange: (e) => setExportDlg({ ...exportDlg, out: e.target.value }),
                })),
              h('div', { className: 'sst-actions' },
                h('button', { className: 'sst-btn', onClick: () => setExportDlg(null) }, '取消'),
                h('button', { className: 'sst-btn primary', onClick: doExport }, '导出'))))
        : null

      const marksNode = mode === 'history'
        ? h('div', { className: 'sst-sec' },
            h('h4', null, '故障点 ' + (marks.length ? '(' + marks.length + ')' : '')),
            marks.length === 0
              ? h('div', { className: 'sst-meta' }, '没有标记，先点右上角「重扫规则」')
              : marks.slice(0, 40).map((m, i) =>
                  h('div', {
                    key: m.id || i,
                    className: 'sst-mark sst-sev-' + (m.severity || 'warn'),
                    title: (m.hypothesis || '') + (m.code && m.code.symbol ? '\n' + m.code.file + ' :: ' + m.code.symbol : ''),
                    onClick: () => jumpToMark(m),
                  },
                    h('div', { className: 'a' }, m.label),
                    h('div', { className: 'b' },
                      h('span', null, m.rule),
                      h('span', null, new Date(m.t || Date.now()).toLocaleTimeString())))))
        : null

      const menuNode = menu
        ? h('div', { className: 'sst-menu', style: { left: menu.x, top: menu.y } },
            h('button', { onClick: copySelection }, '复制选中内容'),
            h('div', { className: 'sep' }),
            h('button', { onClick: () => copyRow(menu.index, true) }, '复制本行（含时间戳）'),
            h('button', { onClick: () => copyRow(menu.index, false) }, '复制本行（仅内容）'),
            h('button', { onClick: () => copyRowHex(menu.index) }, '复制为 Hex'),
            h('button', { onClick: () => copyRowEscape(menu.index) }, '复制为转义'),
            h('button', { onClick: () => copyQuote(menu.index) }, '引用到对话（复制引用块）'),
            h('div', { className: 'sep' }),
            h('button', { onClick: () => { const i = menu.index; setMenu(null); doJump(String(i + 1)) } }, '跳到本行'))
        : null
      const toastNode = toast ? h('div', { className: 'sst-toast' }, toast) : null

      return h('div', { className: 'sst-root' },
        h('aside', { className: 'sst-side' },
          h('div', { className: 'sst-sec' }, h('h4', null, '端口'),
            (state.ports.length ? state.ports : [{ port: '（未发现端口）', state: 'none' }]).map((p, i) =>
              h('div', {
                key: i,
                className: 'sst-port' + (p.portId !== null && p.portId === active ? ' on' : ''),
                onClick: () => {
                  const mine = !p.owner || p.owner.id === sessionId
                  if (p.state === 'open' && mine) { setActive(p.portId); return }
                  if (p.state === 'open' && !mine) {
                    if (window.confirm('端口已被 ' + (p.owner && p.owner.id) + ' 占用，接管会先结束对方的录制。继续？')) open(p.port, { takeover: true })
                    return
                  }
                  open(p.port)
                },
              },
                h('span', { className: 'sst-dot' + (p.state === 'open' ? ' on' : '') }),
                h('div', null,
                  h('div', { className: 'sst-name' }, p.port),
                  h('div', { className: 'sst-meta' }, p.baudRate ? (p.baudRate + ' · 8N1' + (p.state === 'open' && p.owner && p.owner.id !== sessionId ? ' · 被占用' : '')) : (p.state === 'open' ? '已连接' : '可用')))))),
          h('div', { className: 'sst-sec' }, h('h4', null, '本次录制'),
            activeMeta
              ? h('div', { className: 'sst-rec on' },
                  h('div', { className: 'a' }, activeMeta.captureId || (activeMeta.port + ' · 录制中')),
                  h('div', { className: 'b' }, h('span', null, fmtBytes(activeMeta.bytesRx)), h('span', null, activeMeta.state)))
              : h('div', { className: 'sst-meta' }, '未在录制')),
          marksNode,
          h('div', { className: 'sst-sec' }, h('h4', null, '最近录制'),
            (state.captures || []).slice(0, 8).map((cap) =>
              h('div', {
                key: cap.id,
                className: 'sst-rec' + (historyMeta && historyMeta.id === cap.id ? ' on' : ''),
                title: cap.path || cap.id,
                onClick: () => openCapture(cap),
                onContextMenu: (e) => {
                  e.preventDefault()
                  const maxX = (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220
                  const maxY = (typeof window !== 'undefined' ? window.innerHeight : 800) - 200
                  setCapMenu({ x: Math.min(e.clientX, maxX), y: Math.min(e.clientY, maxY), cap })
                },
              },
                h('div', { className: 'a' }, (cap.port || '未知端口') + ' · ' + new Date(cap.startedMs || Date.now()).toLocaleTimeString()),
                h('div', { className: 'b' },
                  h('span', null, new Date(cap.startedMs || Date.now()).toLocaleDateString()),
                  h('span', null, fmtBytes(cap.bytes)))))),
          h('div', { className: 'sst-grow' }),
          error ? h('div', { className: 'sst-meta', style: { color: '#cf5656' } }, error) : null),

        h('section', { className: 'sst-main' },
          h('div', { className: 'sst-head' },
            h('div', { className: 'sst-tabs' },
              h('button', { className: tab === 'log' ? 'on' : '', onClick: () => setTab('log') }, '终端'),
              h('button', { className: tab === 'stats' ? 'on' : '', onClick: () => setTab('stats') }, '统计')),
            tab === 'log' ? h('div', { className: 'sst-tabs' },
              h('button', { className: view === 'text' ? 'on' : '', onClick: () => setView('text') }, '文本'),
              h('button', { className: view === 'hex' ? 'on' : '', onClick: () => setView('hex') }, 'Hex')) : null,
            tab === 'log' ? h('select', { value: lineEnding, onChange: (e) => { setLineEnding(e.target.value); cursor.current = 0; setLines([]) }, title: '断行策略' },
              h('option', { value: 'any' }, '断行 any'),
              h('option', { value: 'crlf' }, '断行 CRLF'),
              h('option', { value: 'lf' }, '断行 LF')) : null,
            tab === 'log' ? h('input', {
              className: 'sst-jump',
              placeholder: '搜索… 回车下一个 / Shift+回车 上一个',
              value: query,
              onChange: (e) => { setQuery(e.target.value); setMatches([]); setMatchIdx(-1); lastQuery.current = '' },
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(e.shiftKey ? -1 : 1) },
            }) : null,
            tab === 'log' && matches.length > 0 ? h('span', { className: 'sst-meta' }, (matchIdx + 1) + '/' + matches.length) : null,
            tab === 'log' ? h('button', { className: 'sst-btn', onClick: () => runSearch(-1) }, '↑') : null,
            tab === 'log' ? h('button', { className: 'sst-btn', onClick: () => runSearch(1) }, '↓') : null,
            mode === 'history' ? h('button', { className: 'sst-chip' + (onlyMarks ? ' on' : ''), onClick: () => setOnlyMarks(!onlyMarks) }, '只看故障点') : null,
            mode === 'history' ? h('button', { className: 'sst-btn', onClick: rescan, disabled: rescanning }, rescanning ? '重扫中…' : '重扫规则') : null,
            mode === 'history' ? h('button', { className: 'sst-chip on', onClick: () => { setMode('live'); setHistoryMeta(null); setLines([]); setMatches([]); setMatchIdx(-1); setMarks([]) } }, '返回实时') : null,
            h('span', { className: 'sst-grow' }),
            tab === 'log' ? h('label', { className: 'sst-meta' },
              h('input', { type: 'checkbox', checked: follow, onChange: (e) => setFollow(e.target.checked) }), ' 跟随') : null,
            tab === 'log' ? h('button', { className: 'sst-chip' + (filter === 'all' ? ' on' : ''), onClick: () => setFilter('all') }, '全部') : null,
            tab === 'log' ? h('button', { className: 'sst-chip' + (filter === 'rx' ? ' on' : ''), onClick: () => setFilter('rx') }, 'RX') : null,
            tab === 'log' ? h('button', { className: 'sst-chip' + (filter === 'tx' ? ' on' : ''), onClick: () => setFilter('tx') }, 'TX') : null,
            h('button', { className: 'sst-btn', onClick: close, disabled: !active }, active ? '关闭串口' : '未连接')),

          tab === 'log'
            ? h('div', {
                className: 'sst-log',
                ref: logRef,
                onContextMenu: (e) => {
                  e.preventDefault()
                  const rect = e.currentTarget.getBoundingClientRect()
                  const y = e.clientY - rect.top + e.currentTarget.scrollTop
                  const maxX = (typeof window !== 'undefined' ? window.innerWidth : 1200) - 210
                  const maxY = (typeof window !== 'undefined' ? window.innerHeight : 800) - 250
                  setMenu({ x: Math.min(e.clientX, maxX), y: Math.min(e.clientY, maxY), index: rowAt(y) })
                },
                onScroll: (e) => {
                  const el = e.target
                  setScrollTop(el.scrollTop)
                  setViewH(el.clientHeight)
                  followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
                  if (!followRef.current && follow) setFollow(false)
                },
              },
                visible.length === 0 && !pending
                  ? h('div', { className: 'sst-empty' }, active ? '等待数据…' : '选择左侧端口开始')
                  : h('div', { className: 'sst-spacer', style: { height: layout.total * ROW + (pending ? ROW : 0) } },
                      h('div', { className: 'sst-slice', style: { top: (layout.tops[start] || 0) * ROW } },
                        slice.map((l, i) =>
                          view === 'hex'
                            ? h('div', { key: start + i, className: 'sst-hexline' + (/error|timeout|fail/i.test(l.text) ? ' sst-errline' : ''), title: l.text },
                                h('span', { className: 'sst-t' }, new Date(l.t || Date.now()).toISOString().slice(11, 23)),
                                h('span', { className: 'sst-hexdump' }, '  ' + (l.seq || 0).toString(16).padStart(8, '0') + '  ' + hexOf(l.text, 16).padEnd(48) + '  |' + asciiOf(l.text, 16) + '|'))
                            : h('div', { key: start + i, style: { height: rowOf(start + i) * ROW }, className: 'sst-line' + (/error|timeout|fail/i.test(l.text) ? ' sst-errline' : '') + (matchIdx >= 0 && matches[matchIdx] === start + i ? ' sst-hit' : matches.indexOf(start + i) >= 0 ? ' sst-find' : ''), title: l.text },
                                h('span', { className: 'sst-t' }, new Date(l.t || Date.now()).toISOString().slice(11, 23)),
                                h('span', { className: 'sst-d' }, l.dir === 'tx' ? '→' : '←'),
                                h('span', { className: l.dir === 'tx' ? 'sst-tx' : '' }, l.text))),
                        pending ? h('div', { className: 'sst-line sst-pending' },
                          h('span', { className: 'sst-t' }, '…'),
                          h('span', { className: 'sst-d' }, '←'),
                          h('span', null, pending.text)) : null)))
            : h('div', { className: 'sst-stats' },
                h('div', { className: 'sst-cards' },
                  h('div', { className: 'sst-card' }, h('div', { className: 'k' }, '接收'), h('div', { className: 'v' }, fmtBytes(totals.rx)), h('div', { className: 's' }, lines.length + ' 行')),
                  h('div', { className: 'sst-card' }, h('div', { className: 'k' }, '发送'), h('div', { className: 'v' }, fmtBytes(totals.tx)), h('div', { className: 's' }, '—')),
                  h('div', { className: 'sst-card' }, h('div', { className: 'k' }, '当前速率'), h('div', { className: 'v' }, (rateNow / 1024).toFixed(1) + ' KB/s'), h('div', { className: 's' }, '峰值 ' + (peak / 1024).toFixed(1) + ' KB/s')),
                  h('div', { className: 'sst-card' }, h('div', { className: 'k' }, '端口'), h('div', { className: 'v' }, activeMeta ? activeMeta.port : '—'), h('div', { className: 's' }, activeMeta ? activeMeta.state : '未连接'))),
                h('div', { className: 'sst-chart' },
                  h('h5', null, '接收速率'),
                  h('div', { className: 'sub' }, '最近 ' + rates.length + ' 次采样 · 峰值 ' + (peak / 1024).toFixed(1) + ' KB/s'),
                  h('div', { style: { marginTop: 8 } }, h(Spark, { values: rates })))),

          tab === 'log'
            ? h('div', { className: 'sst-send' },
                h('input', {
                  value: draft,
                  placeholder: mode === 'history' ? '历史录制（只读），先返回实时' : active ? '输入要发送的内容，回车发送' : '先打开一个端口',
                  disabled: !active || mode === 'history',
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') send() },
                }),
                h('select', { defaultValue: 'crlf' }, h('option', { value: 'crlf' }, 'CRLF'), h('option', { value: 'lf' }, 'LF'), h('option', { value: 'none' }, '无')),
                h('button', { className: 'sst-btn primary', onClick: send, disabled: !active }, '发送'))
            : null,

          h('div', { className: 'sst-status' },
            h('span', null, '端口 ', h('b', null, activeMeta ? activeMeta.port : '—')),
            h('span', null, 'RX ', h('b', null, fmtBytes(totals.rx))),
            h('span', null, 'TX ', h('b', null, fmtBytes(totals.tx))),
            h('span', null, '行 ', h('b', null, String(lines.length))),
            h('span', null, '断行 ', h('b', null, lineEnding)),
            h('span', null, mode === 'history' ? '历史（只读）' : '实时'),
            h('span', null, view === 'hex' ? 'Hex 视图' : '文本视图')), menuNode, capMenuNode, exportNode, toastNode))
    }

    function apply(ctx) {
      try {
        if (!ctx || ctx.slots === undefined || ctx.slots === null) {
          console.error('serial-trigger: this DSH has no slots service; the panel stays unmounted')
          return
        }
        // "main" replaces the whole conversation area and drops the session.
        // A conversation.view is a tab inside the session, next to 对话/轨迹.
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'serial-trigger',
            order: 20,
            label: () => '串口',
            inject: (sessionId) => ({ sessionId }),
          }, Panel),
        )
      } catch (error) {
        console.error('serial-trigger: registering the panel failed', error)
      }
    }

    exports.apply = apply
    // The slot registry must be declared before ctx.slots is readable.
    exports.inject = ['slots']
    return module.exports
  },
})
