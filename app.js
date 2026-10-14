/* Flick: browser-to-browser file and text sharing. No backend.
 *
 * net.js finds other browsers and hands us one open RTCDataChannel per device.
 * This file speaks Flick's own small protocol over that channel:
 *   strings  -> JSON control messages (hello, text, offer, reply, file, got, cancel, unshare)
 *   binary   -> raw chunks of the file most recently announced with a "file" message
 * Files are always offered first and only sent after the receiver accepts.
 *
 * Two ways to share:
 *   - "Share with everyone": goes to every nearby device, including ones that join later.
 *   - A device tile: send files or text to that one device only.
 */
(() => {
  'use strict'

  const CHUNK = 64 * 1024
  const READ_BLOCK = 4 * 1024 * 1024
  const HIGH_WATER = 8 * 1024 * 1024
  const MAX_TEXT = 100000
  const MAX_FILES = 500
  const PREVIEW_LIMIT = 40 * 1024 * 1024

  const $ = sel => document.querySelector(sel)
  document.documentElement.classList.add('js')

  /* ---------- small helpers ---------- */

  const store = {
    get: k => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  }

  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
  const uid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ALPHABET[b % ALPHABET.length]).join('')
  const clean = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max) : ''

  const bytes = n => {
    if (!n) return '0 B'
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
    const v = n / 1024 ** i
    return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${u[i]}`
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  // Next paint, or a short timer when the tab is in the background and paints are paused.
  const frame = fn => { let done = false; const run = () => { if (!done) { done = true; fn() } }; requestAnimationFrame(run); setTimeout(run, 250) }
  const nextFrame = fn => { let queued = false; return () => { if (queued) return; queued = true; frame(() => { queued = false; fn() }) } }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'icon') el.innerHTML = icon(v)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid)
    return el
  }

  const ICONS = {
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18h3"/>',
    tablet: '<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M10.5 18h3"/>',
    laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  }
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`

  function linkify(text) {
    const frag = document.createDocumentFragment()
    const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi
    let last = 0, m
    while ((m = re.exec(text))) {
      frag.append(text.slice(last, m.index), h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }))
      last = m.index + m[0].length
    }
    frag.append(text.slice(last))
    return frag
  }

  function copyButton(text) {
    const b = h('button', { class: 'btn btn-ink', type: 'button', text: 'Copy' })
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy' }, 1600) }
      catch { toast('Copy failed. Select the text and copy it instead.') }
    })
    return b
  }

  /* ---------- this device ---------- */

  function detectDevice() {
    const ua = navigator.userAgent
    const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
    let os = 'Computer', kind = 'laptop'
    if (/iPhone|iPod/.test(ua)) { os = 'iPhone'; kind = 'phone' }
    else if (/iPad/.test(ua) || touchMac) { os = 'iPad'; kind = 'tablet' }
    else if (/Android/.test(ua)) { const m = /Mobile/.test(ua); os = m ? 'Android phone' : 'Android tablet'; kind = m ? 'phone' : 'tablet' }
    else if (/CrOS/.test(ua)) { os = 'Chromebook' }
    else if (/Mac OS X|Macintosh/.test(ua)) { os = 'Mac' }
    else if (/Windows/.test(ua)) { os = 'Windows PC'; kind = 'desktop' }
    else if (/Linux/.test(ua)) { os = 'Linux'; kind = 'desktop' }
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
    return { kind, label: `${os} · ${browser}` }
  }

  const ADJ = ['Amber', 'Brisk', 'Calm', 'Clever', 'Coral', 'Daring', 'Eager', 'Gentle', 'Golden', 'Jolly', 'Lively', 'Lucky', 'Mellow', 'Misty', 'Nimble', 'Olive', 'Plucky', 'Quiet', 'Rapid', 'Rosy', 'Sunny', 'Swift', 'Tidy', 'Velvet', 'Witty', 'Zesty']
  const NOUN = ['Otter', 'Falcon', 'Badger', 'Heron', 'Lynx', 'Panda', 'Robin', 'Walrus', 'Gecko', 'Koala', 'Moose', 'Puffin', 'Raven', 'Seal', 'Tiger', 'Wren', 'Bison', 'Crane', 'Fox', 'Hare', 'Ibis', 'Kiwi', 'Lemur', 'Newt', 'Owl', 'Quail', 'Yak', 'Zebra']
  const pick = list => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length]

  const selfId = uid(16)
  const me = { ...detectDevice(), name: clean(store.get('flick.name'), 32) }
  if (!me.name) { me.name = `${pick(ADJ)} ${pick(NOUN)}`; store.set('flick.name', me.name) }
  const helloMsg = () => ({ t: 'hello', name: me.name, kind: me.kind, label: me.label })

  /* ---------- state ---------- */

  const peers = new Map()      // peerId -> { id, dc, ready, name, kind, label, el, ui, out, chain, recv }
  const outgoing = new Map()   // `${peerId}:${id}` -> transfer we are sending
  const incoming = new Map()   // `${peerId}:${id}` -> transfer we are receiving
  const board = []             // what this device shared with everyone
  const seenText = new Set()
  const declined = new Set()
  let net = null
  let netState = 'finding'     // finding | on | off
  let linkCode = null

  const params = new URLSearchParams(location.search)
  const sharedIn = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join('\n').slice(0, MAX_TEXT)
  if (sharedIn) history.replaceState(null, '', location.pathname + location.hash)

  /* ---------- connections ---------- */

  function onOpen(id, dc) {
    const p = { id, dc, ready: false, out: null, chain: Promise.resolve(), recv: null }
    peers.set(id, p)
    dc.onmessage = e => {
      try {
        if (typeof e.data === 'string') onControl(p, JSON.parse(e.data))
        else onBinary(p, e.data)
      } catch (err) { console.warn('[flick] message', err) }
    }
    ctl(p, helloMsg())
  }

  function onClose(id) {
    const p = peers.get(id)
    if (!p) return
    peers.delete(id)
    p.el?.remove()
    for (const t of outgoing.values()) {
      if (t.peerId === id && ['waiting', 'queued', 'sending', 'flushing'].includes(t.status)) finishOut(t, 'failed')
    }
    for (const t of incoming.values()) {
      if (t.peerId === id && (t.status === 'pending' || t.status === 'receiving')) { t.status = 'failed'; freeParts(t); renderIncoming(t) }
    }
    for (const item of board) item.reached.delete(id)
    renderBoard()
    renderStatus()
    keepAwake()
  }

  function ctl(p, msg) {
    if (p.dc.readyState !== 'open') return false
    try { p.dc.send(JSON.stringify(msg)); return true } catch { return false }
  }

  function onControl(p, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'hello') return onHello(p, msg)
    if (!p.ready) return
    switch (msg.t) {
      case 'text': return onText(p, msg)
      case 'offer': return onOffer(p, msg)
      case 'reply': return onReply(p, msg)
      case 'file': return onFileStart(p, msg)
      case 'got': return onGot(p, msg)
      case 'cancel': return onCancel(p, msg)
      case 'unshare': return onUnshare(p, msg)
    }
  }

  function onHello(p, msg) {
    const first = !p.ready
    p.name = clean(msg.name, 32) || 'Unnamed device'
    p.kind = ['phone', 'tablet', 'laptop', 'desktop'].includes(msg.kind) ? msg.kind : 'laptop'
    p.label = clean(msg.label, 60)
    p.ready = true
    renderPeer(p)
    renderStatus()
    if (!first) return
    toast(`${p.name} is here`)
    for (const item of board) deliver(item, p)
    renderBoard()
  }

  /* ---------- peer tiles ---------- */

  function renderPeer(p) {
    if (!p.el) buildPeer(p)
    p.ui.icon.innerHTML = icon(p.kind)
    p.ui.name.textContent = p.name
    p.ui.meta.textContent = p.label || 'Nearby device'
    p.ui.drop.textContent = `Drop to send to ${p.name} only`
    p.ui.textarea.setAttribute('aria-label', `Message to ${p.name}`)
    renderOut(p)
  }

  function buildPeer(p) {
    const ui = {}
    ui.icon = h('span', { class: 'avatar', 'aria-hidden': 'true' })
    ui.name = h('h3', { class: 'peer-name' })
    ui.meta = h('p', { class: 'peer-meta' })
    ui.picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { sendFiles(p, ui.picker.files); ui.picker.value = '' } })
    ui.actions = h('div', { class: 'peer-actions' },
      h('button', { class: 'btn btn-ink', type: 'button', text: 'Send files', onclick: () => ui.picker.click() }),
      h('button', { class: 'btn btn-soft', type: 'button', text: 'Send text', onclick: () => openComposer(p) }))
    ui.drop = h('p', { class: 'peer-drop' })

    ui.statusText = h('p', { class: 'status-text' })
    ui.fill = h('i')
    ui.track = h('div', { class: 'track', 'aria-hidden': 'true' }, ui.fill)
    ui.statusBtn = h('button', { class: 'btn btn-text', type: 'button' })
    ui.status = h('div', { class: 'status-block', role: 'status', hidden: true },
      h('div', { class: 'status-row' }, ui.statusText, ui.statusBtn), ui.track)

    ui.textarea = h('textarea', { rows: '3', placeholder: 'Type or paste text, a link, a note…', maxlength: String(MAX_TEXT) })
    ui.composer = h('form', { class: 'composer', hidden: true },
      ui.textarea,
      h('div', { class: 'composer-row' },
        h('button', { class: 'btn btn-ink', type: 'submit', text: 'Send' }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: () => closeComposer(p) })))
    ui.composer.addEventListener('submit', e => { e.preventDefault(); sendText(p) })
    ui.textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(p) }
      if (e.key === 'Escape') closeComposer(p)
    })

    p.el = h('article', { class: 'peer', 'data-peer': p.id },
      h('div', { class: 'peer-main' }, ui.icon, h('div', null, ui.name, ui.meta)),
      ui.actions, ui.drop, ui.status, ui.composer, ui.picker)
    dropTarget(p.el, files => sendFiles(p, files))
    p.ui = ui
    $('#peerList').append(p.el)
  }

  function openComposer(p) {
    p.ui.composer.hidden = false
    p.ui.actions.hidden = true
    p.ui.textarea.focus()
  }
  function closeComposer(p) {
    p.ui.composer.hidden = true
    p.ui.actions.hidden = false
    p.ui.textarea.value = ''
  }

  function sendText(p) {
    const text = p.ui.textarea.value.slice(0, MAX_TEXT)
    if (!text.trim()) { p.ui.textarea.focus(); return }
    if (ctl(p, { t: 'text', id: uid(), text })) { closeComposer(p); toast(`Text sent to ${p.name}`) }
    else toast(`Couldn't reach ${p.name}. Try again.`)
  }

  function sendFiles(p, list) {
    const files = Array.from(list || []).slice(0, MAX_FILES)
    if (!files.length || !peers.has(p.id)) return
    if (p.out && ['waiting', 'queued', 'sending', 'flushing'].includes(p.out.status)) {
      toast(`Wait for the current transfer to ${p.name} to finish`)
      return
    }
    p.out = offerFiles(p, uid(), files, false)
    renderOut(p)
  }

  /* ---------- outgoing transfers ---------- */

  function offerFiles(p, id, files, all, item) {
    const t = { key: `${p.id}:${id}`, id, peerId: p.id, files, total: files.reduce((s, f) => s + f.size, 0), sent: 0, status: 'waiting', item }
    outgoing.set(t.key, t)
    const ok = ctl(p, { t: 'offer', id, all, files: files.map(f => ({ name: f.name, size: f.size, type: f.type })) })
    if (!ok) finishOut(t, 'failed')
    return t
  }

  function onReply(p, msg) {
    const t = outgoing.get(`${p.id}:${msg.id}`)
    if (!t || t.status !== 'waiting') return
    if (msg.accept !== true) return finishOut(t, 'declined')
    t.status = 'queued'
    p.chain = p.chain.then(() => pump(p, t))
    redrawOut(t)
    keepAwake()
  }

  function waitForRoom(dc) {
    return new Promise((resolve, reject) => {
      const done = () => { dc.removeEventListener('bufferedamountlow', done); dc.removeEventListener('close', fail); resolve() }
      const fail = () => { dc.removeEventListener('bufferedamountlow', done); reject(new Error('closed')) }
      dc.addEventListener('bufferedamountlow', done)
      dc.addEventListener('close', fail, { once: true })
    })
  }

  async function pump(p, t) {
    if (t.status !== 'queued') return
    t.status = 'sending'
    redrawOut(t)
    const dc = p.dc
    try {
      for (let f = 0; f < t.files.length; f++) {
        const file = t.files[f]
        if (!file.size) continue
        ctl(p, { t: 'file', id: t.id, f })
        for (let o = 0; o < file.size; o += READ_BLOCK) {
          const block = new Uint8Array(await file.slice(o, o + READ_BLOCK).arrayBuffer())
          for (let c = 0; c < block.length; c += CHUNK) {
            if (t.status !== 'sending') return
            if (dc.readyState !== 'open') throw new Error('closed')
            if (dc.bufferedAmount > HIGH_WATER) await waitForRoom(dc)
            const piece = block.subarray(c, c + CHUNK)
            dc.send(piece)
            t.sent += piece.length
            redrawOut(t)
          }
        }
      }
      // The receiver confirms with "got"; until then the bytes are only handed to the browser.
      if (t.status === 'sending') { t.status = 'flushing'; redrawOut(t) }
    } catch {
      if (t.status === 'sending') finishOut(t, 'failed')
    }
  }

  function onGot(p, msg) {
    const t = outgoing.get(`${p.id}:${msg.id}`)
    if (t && ['queued', 'sending', 'flushing'].includes(t.status)) finishOut(t, 'done')
  }

  function finishOut(t, status) {
    t.status = status
    redrawOut(t)
    keepAwake()
    if (t.item) return
    if (status === 'done' || status === 'cancelled') {
      setTimeout(() => {
        const p = peers.get(t.peerId)
        if (p && p.out === t) { p.out = null; renderOut(p) }
        outgoing.delete(t.key)
      }, status === 'done' ? 5000 : 4000)
    }
  }

  function cancelOut(t) {
    const p = peers.get(t.peerId)
    if (p) ctl(p, { t: 'cancel', id: t.id })
    finishOut(t, 'cancelled')
  }

  const outFrames = new Set()
  function redrawOut(t) {
    if (outFrames.has(t.key)) return
    outFrames.add(t.key)
    frame(() => {
      outFrames.delete(t.key)
      if (t.item) renderBoard()
      else { const p = peers.get(t.peerId); if (p) renderOut(p) }
    })
  }

  function renderOut(p) {
    if (!p?.ui) return
    const t = p.out
    const { status, statusText, statusBtn, track, fill } = p.ui
    if (!t) { status.hidden = true; return }
    status.hidden = false
    const what = t.files.length === 1 ? `“${t.files[0].name}”` : plural(t.files.length, 'file')
    const moving = ['waiting', 'queued', 'sending', 'flushing'].includes(t.status)
    statusText.classList.toggle('is-bad', t.status === 'failed' || t.status === 'declined')
    track.classList.toggle('is-wait', t.status === 'waiting' || t.status === 'queued')
    track.hidden = !moving
    fill.style.transform = `scaleX(${t.total ? t.sent / t.total : 1})`
    statusBtn.hidden = false
    const dismiss = () => { p.out = null; outgoing.delete(t.key); renderOut(p) }
    if (moving) {
      statusText.textContent = t.status === 'waiting' ? `Waiting for ${p.name} to accept ${what}`
        : t.status === 'queued' ? 'Starting…' : `Sending ${bytes(t.sent)} of ${bytes(t.total)}`
      statusBtn.textContent = 'Cancel'; statusBtn.onclick = () => cancelOut(t)
    } else if (t.status === 'done') {
      statusText.textContent = `${p.name} got ${what}`; statusBtn.hidden = true
    } else if (t.status === 'declined') {
      statusText.textContent = `${p.name} declined ${what}`
      statusBtn.textContent = 'OK'; statusBtn.onclick = dismiss
    } else if (t.status === 'cancelled') {
      statusText.textContent = 'Transfer cancelled'; statusBtn.hidden = true
    } else {
      statusText.textContent = 'The transfer stopped. The connection dropped.'
      statusBtn.textContent = 'OK'; statusBtn.onclick = dismiss
    }
  }

  /* ---------- share with everyone ---------- */

  const draft = { files: [] }

  function deliver(item, p) {
    if (!p.ready || item.reached.has(p.id)) return
    item.reached.add(p.id)
    if (item.kind === 'text') ctl(p, { t: 'text', id: item.id, text: item.text, all: true })
    else offerFiles(p, item.id, item.files, true, item)
  }

  function shareDraft() {
    const text = $('#shareText').value.slice(0, MAX_TEXT)
    const files = draft.files.slice()
    if (!text.trim() && !files.length) { $('#shareText').focus(); return }
    if (text.trim()) board.unshift({ id: uid(), kind: 'text', text, time: clock(), reached: new Set() })
    if (files.length) board.unshift({ id: uid(), kind: 'files', files, total: files.reduce((s, f) => s + f.size, 0), time: clock(), reached: new Set() })
    $('#shareText').value = ''
    draft.files = []
    renderDraft()
    const ready = readyPeers()
    for (const item of board) for (const p of ready) deliver(item, p)
    renderBoard()
    toast(ready.length ? `Shared with ${plural(ready.length, 'device')} nearby` : 'Shared. Devices that open Flick on this Wi‑Fi will see it.')
  }

  // Dropped files go out straight away, no extra Share press.
  function shareFilesNow(list) {
    const files = Array.from(list || []).slice(0, MAX_FILES)
    if (!files.length) return
    const item = { id: uid(), kind: 'files', files, total: files.reduce((s, f) => s + f.size, 0), time: clock(), reached: new Set() }
    board.unshift(item)
    const ready = readyPeers()
    for (const p of ready) deliver(item, p)
    renderBoard()
    const what = files.length === 1 ? `“${files[0].name}”` : plural(files.length, 'file')
    toast(ready.length ? `Sharing ${what} with ${plural(ready.length, 'device')}` : `${what} ready. Devices that open Flick on this Wi‑Fi will get it.`)
  }

  function unshare(item) {
    board.splice(board.indexOf(item), 1)
    for (const [key, t] of outgoing) {
      if (t.item !== item) continue
      t.status = 'cancelled'
      outgoing.delete(key)
    }
    for (const p of peers.values()) if (item.reached.has(p.id)) ctl(p, { t: 'unshare', id: item.id })
    renderBoard()
    keepAwake()
  }

  function addDraftFiles(list) {
    for (const f of Array.from(list || [])) {
      if (draft.files.length >= MAX_FILES) break
      if (!draft.files.some(d => d.name === f.name && d.size === f.size && d.lastModified === f.lastModified)) draft.files.push(f)
    }
    renderDraft()
  }

  function renderDraft() {
    const box = $('#draftFiles')
    box.replaceChildren(...draft.files.map((f, i) => h('li', { class: 'chip' },
      h('span', { class: 'chip-name', title: f.name, text: f.name }),
      h('span', { class: 'chip-size', text: bytes(f.size) }),
      h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${f.name}`, icon: 'close', onclick: () => { draft.files.splice(i, 1); renderDraft() } }))))
    box.hidden = !draft.files.length
    $('#shareSubmit').textContent = draft.files.length ? `Share ${plural(draft.files.length, 'file')}` : 'Share'
  }

  function boardStatus(item) {
    const reachedNow = [...item.reached].filter(id => peers.get(id)?.ready).length
    if (item.kind === 'text') return reachedNow ? `Seen by ${plural(reachedNow, 'device')}` : 'Waiting for devices to join'
    const ts = [...outgoing.values()].filter(t => t.item === item && peers.has(t.peerId))
    const got = ts.filter(t => t.status === 'done').length
    const moving = ts.filter(t => ['queued', 'sending', 'flushing'].includes(t.status))
    const waiting = ts.filter(t => t.status === 'waiting').length
    const parts = []
    if (moving.length) parts.push(`Sending to ${plural(moving.length, 'device')} · ${Math.floor(100 * moving.reduce((s, t) => s + t.sent, 0) / Math.max(1, moving.length * item.total))}%`)
    if (got) parts.push(`${got} downloaded`)
    if (waiting) parts.push(`${waiting} not downloaded yet`)
    return parts.length ? parts.join(' · ') : 'Waiting for devices to join'
  }

  const renderBoard = nextFrame(() => {
    const list = $('#board')
    list.replaceChildren(...board.map(item => {
      const body = item.kind === 'text'
        ? h('p', { class: 'item-text' }, linkify(item.text))
        : h('ul', { class: 'files' },
          item.files.slice(0, 5).map(f => h('li', { class: 'file' },
            h('span', { class: 'file-thumb', icon: 'file' }),
            h('div', { style: 'min-width:0' }, h('p', { class: 'file-name', title: f.name, text: f.name }), h('p', { class: 'file-size', text: bytes(f.size) })))),
          item.files.length > 5 ? h('li', { class: 'file-more', text: `and ${item.files.length - 5} more` }) : null)
      return h('li', { class: 'item item-mine' },
        h('div', { class: 'item-head' },
          h('p', null, h('strong', { text: 'You' }), item.kind === 'text' ? ' shared text' : ` shared ${plural(item.files.length, 'file')} · ${bytes(item.total)}`),
          h('time', { class: 'item-time', text: item.time })),
        body,
        h('div', { class: 'item-foot' },
          h('p', { class: 'item-status', text: boardStatus(item) }),
          h('button', { class: 'btn btn-text', type: 'button', text: 'Stop sharing', onclick: () => unshare(item) })))
    }))
    list.hidden = !board.length
  })

  $('#shareForm').addEventListener('submit', e => { e.preventDefault(); shareDraft() })
  $('#shareText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); shareDraft() } })
  $('#shareAddFiles').addEventListener('click', () => $('#sharePicker').click())
  $('#sharePicker').addEventListener('change', () => { addDraftFiles($('#sharePicker').files); $('#sharePicker').value = '' })

  /* ---------- incoming ---------- */

  function onText(p, msg) {
    const text = typeof msg.text === 'string' ? msg.text.slice(0, MAX_TEXT) : ''
    const key = `${p.id}:${clean(msg.id, 32)}`
    if (!text.trim() || seenText.has(key)) return
    seenText.add(key)
    const link = text.trim()
    addItem(h('li', { class: 'item is-new', 'data-key': key },
      itemHead(p.kind, h('p', null, h('strong', { text: p.name }), msg.all ? ' shared text with everyone' : ' sent you text'), clock()),
      h('p', { class: 'item-text' }, linkify(text)),
      h('div', { class: 'item-actions' }, copyButton(text),
        /^https?:\/\/\S+$/i.test(link) && h('a', { class: 'btn btn-soft', href: link, target: '_blank', rel: 'noopener noreferrer nofollow', text: 'Open link' }))))
    notify(`${p.name} ${msg.all ? 'shared' : 'sent you'} text`)
  }

  function onOffer(p, msg) {
    const id = clean(msg.id, 32)
    const key = `${p.id}:${id}`
    if (!id || !Array.isArray(msg.files) || !msg.files.length || incoming.has(key) || declined.has(key)) return
    const files = msg.files.slice(0, MAX_FILES).map(f => ({
      name: clean(f?.name, 255).replace(/[\\/]/g, '_') || 'file',
      size: Number.isSafeInteger(f?.size) && f.size >= 0 ? f.size : 0,
      type: clean(f?.type, 120),
      received: 0, parts: [], url: null,
    }))
    const t = { key, id, peerId: p.id, from: p.name, kind: p.kind, all: !!msg.all, files, total: files.reduce((s, f) => s + f.size, 0), received: 0, status: 'pending', time: clock() }
    incoming.set(key, t)
    buildFileItem(t)
    addItem(t.el)
    renderIncoming(t)
    notify(`${t.from} ${t.all ? 'shared' : 'wants to send'} ${t.files.length === 1 ? t.files[0].name : plural(t.files.length, 'file')}`)
  }

  function accept(t) {
    const p = peers.get(t.peerId)
    if (t.status !== 'pending' || !p) return
    t.status = 'receiving'
    t.files.forEach(f => { if (f.size === 0) completeFile(f) })
    ctl(p, { t: 'reply', id: t.id, accept: true })
    renderIncoming(t)
    checkDone(t, p)
    keepAwake()
  }

  function decline(t) {
    const p = peers.get(t.peerId)
    if (p && t.status === 'pending') ctl(p, { t: 'reply', id: t.id, accept: false })
    declined.add(t.key)
    removeIncoming(t)
  }

  function cancelIn(t, status = 'cancelled') {
    const p = peers.get(t.peerId)
    if (p) { ctl(p, { t: 'cancel', id: t.id }); if (p.recv?.t === t) p.recv = null }
    t.status = status
    freeParts(t)
    renderIncoming(t)
    keepAwake()
  }

  function onFileStart(p, msg) {
    const t = incoming.get(`${p.id}:${msg.id}`)
    const f = t?.files[msg.f]
    p.recv = t && t.status === 'receiving' && f && !f.url ? { t, f } : null
  }

  function onBinary(p, data) {
    const cur = p.recv
    if (!cur || cur.t.status !== 'receiving') return
    const { t, f } = cur
    const len = data.byteLength
    if (f.received + len > f.size) { cancelIn(t, 'failed'); return }
    f.parts.push(data)
    f.received += len
    t.received += len
    // Fold chunks into a Blob every few MB so the browser can page them out of memory.
    if (f.parts.length >= 64) f.parts = [new Blob(f.parts)]
    if (f.received === f.size) { completeFile(f); p.recv = null; checkDone(t, p) }
    scheduleIn(t)
  }

  function completeFile(f) {
    const blob = new Blob(f.parts, { type: f.type || 'application/octet-stream' })
    f.parts = null
    f.url = URL.createObjectURL(blob)
  }

  function checkDone(t, p) {
    if (t.status !== 'receiving' || !t.files.every(f => f.url)) return
    t.status = 'done'
    ctl(p, { t: 'got', id: t.id })
    keepAwake()
    renderIncoming(t)
    notify(`${plural(t.files.length, 'file')} from ${t.from} ready to save`)
  }

  function freeParts(t) { t.files.forEach(f => { f.parts = null }) }

  function onCancel(p, msg) {
    const out = outgoing.get(`${p.id}:${msg.id}`)
    if (out && ['waiting', 'queued', 'sending', 'flushing'].includes(out.status)) {
      finishOut(out, out.item ? 'declined' : 'cancelled')
      if (!out.item) toast(`${p.name} stopped the transfer`)
    }
    const inc = incoming.get(`${p.id}:${msg.id}`)
    if (inc && (inc.status === 'pending' || inc.status === 'receiving')) {
      if (p.recv?.t === inc) p.recv = null
      inc.status = 'cancelled'; freeParts(inc); renderIncoming(inc); keepAwake()
    }
  }

  function onUnshare(p, msg) {
    const key = `${p.id}:${msg.id}`
    const inc = incoming.get(key)
    if (inc) {
      if (inc.status === 'done') return
      if (p.recv?.t === inc) p.recv = null
      removeIncoming(inc)
      return
    }
    document.querySelector(`.item[data-key="${CSS.escape(key)}"]`)?.remove()
    renderInboxChrome()
  }

  const inFrames = new Set()
  function scheduleIn(t) {
    if (inFrames.has(t)) return
    inFrames.add(t)
    frame(() => { inFrames.delete(t); renderIncoming(t) })
  }

  /* ---------- inbox rendering ---------- */

  function itemHead(kind, summary, time) {
    return h('div', { class: 'item-head' },
      h('span', { class: 'avatar avatar-sm', 'aria-hidden': 'true', icon: kind || 'laptop' }),
      summary,
      h('time', { class: 'item-time', text: time }))
  }

  function buildFileItem(t) {
    const ui = {}
    ui.summary = h('p')
    ui.list = h('ul', { class: 'files' })
    ui.rows = t.files.map(f => {
      const row = {}
      row.thumb = h('span', { class: 'file-thumb', icon: 'file' })
      row.size = h('p', { class: 'file-size' })
      row.slot = h('span')
      row.el = h('li', { class: 'file' }, row.thumb,
        h('div', { style: 'min-width:0' }, h('p', { class: 'file-name', title: f.name, text: f.name }), row.size),
        row.slot)
      ui.list.append(row.el)
      return row
    })
    ui.fill = h('i')
    ui.track = h('div', { class: 'track', 'aria-hidden': 'true' }, ui.fill)
    ui.actions = h('div', { class: 'item-actions' })
    t.ui = ui
    t.el = h('li', { class: 'item is-new', 'data-key': t.key }, itemHead(t.kind, ui.summary, t.time), ui.list, ui.track, ui.actions)
  }

  function renderIncoming(t) {
    const { ui } = t
    if (!ui) return
    const what = t.files.length === 1 ? 'a file' : plural(t.files.length, 'file')
    const verbs = {
      pending: [t.all ? ' shared ' : ' wants to send you ', what, ` · ${bytes(t.total)}`],
      receiving: [' is sending ', what, ` · ${bytes(t.received)} of ${bytes(t.total)}`],
      done: [t.all ? ' shared ' : ' sent you ', what, ` · ${bytes(t.total)}`],
      cancelled: [' · transfer cancelled'],
      failed: [' · the transfer stopped before it finished'],
    }[t.status]
    ui.summary.replaceChildren(h('strong', { text: t.from }), ...verbs)
    ui.track.hidden = t.status !== 'receiving'
    ui.fill.style.transform = `scaleX(${t.total ? t.received / t.total : 1})`

    t.files.forEach((f, i) => {
      const row = ui.rows[i]
      row.size.textContent = t.status === 'receiving' && !f.url && f.received ? `${bytes(f.received)} of ${bytes(f.size)}` : bytes(f.size)
      if (f.url && !row.saved) {
        row.saved = true
        row.slot.replaceChildren(h('a', { class: 'btn btn-soft', href: f.url, download: f.name, text: 'Save' }))
        if (/^image\//.test(f.type) && !/svg/.test(f.type) && f.size <= PREVIEW_LIMIT) row.thumb.replaceChildren(h('img', { src: f.url, alt: '' }))
      }
    })

    const btns = []
    if (t.status === 'pending') {
      btns.push(h('button', { class: 'btn btn-ink', type: 'button', text: t.all ? 'Download' : 'Accept', onclick: () => accept(t) }))
      btns.push(h('button', { class: 'btn btn-text', type: 'button', text: t.all ? 'Dismiss' : 'Decline', onclick: () => decline(t) }))
    } else if (t.status === 'receiving') {
      btns.push(h('button', { class: 'btn btn-danger', type: 'button', text: 'Cancel', onclick: () => cancelIn(t) }))
    } else if (t.status === 'done' && t.files.length > 1) {
      btns.push(h('button', { class: 'btn btn-ink', type: 'button', text: `Save all ${t.files.length}`, onclick: () => saveAll(t) }))
    } else if (t.status === 'cancelled' || t.status === 'failed') {
      btns.push(h('button', { class: 'btn btn-text', type: 'button', text: 'Remove', onclick: () => removeIncoming(t) }))
    }
    ui.actions.replaceChildren(...btns)
    ui.actions.hidden = !btns.length
  }

  async function saveAll(t) {
    for (const f of t.files) {
      if (!f.url) continue
      h('a', { href: f.url, download: f.name }).click()
      await new Promise(r => setTimeout(r, 350))
    }
  }

  function removeIncoming(t) {
    t.files.forEach(f => { if (f.url) URL.revokeObjectURL(f.url) })
    incoming.delete(t.key)
    t.el?.remove()
    renderInboxChrome()
  }

  function addItem(el) {
    $('#inboxList').prepend(el)
    setTimeout(() => el.classList.remove('is-new'), 4000)
    renderInboxChrome()
  }

  function renderInboxChrome() {
    const n = $('#inboxList').children.length
    $('#inboxEmpty').hidden = n > 0
    $('#clearInbox').hidden = n === 0
  }

  $('#clearInbox').addEventListener('click', () => {
    for (const t of [...incoming.values()]) {
      if (t.status === 'pending') decline(t)
      else if (t.status === 'receiving') cancelIn(t)
      removeIncoming(t)
    }
    $('#inboxList').replaceChildren()
    renderInboxChrome()
  })

  /* ---------- status, notifications ---------- */

  const readyPeers = () => [...peers.values()].filter(p => p.ready)

  function renderStatus() {
    const n = readyPeers().length
    const el = $('#myStatus')
    const brokers = net ? net.brokers() : 0
    el.classList.toggle('is-on', n > 0)
    el.classList.toggle('is-off', n === 0 && netState === 'off')
    let text
    if (n) text = `Connected to ${plural(n, 'device')}`
    else if (netState === 'finding' || (netState === 'on' && !brokers)) text = 'Connecting…'
    else if (netState === 'off') text = linkCode ? 'Waiting for someone to open your link' : "Couldn't detect your Wi‑Fi. Share a link to connect."
    else text = linkCode ? 'Visible on this Wi‑Fi and to anyone with your link' : 'Visible to devices on this Wi‑Fi'
    el.querySelector('span').textContent = text
    $('#emptyState').hidden = n > 0
    $('#linkBtn').textContent = linkCode ? 'Your link' : 'Share a link'
  }

  let toastTimer = 0
  function toast(message, action) {
    const el = $('#toast')
    $('#toastText').textContent = message
    const btn = $('#toastAction')
    btn.hidden = !action
    if (action) { btn.textContent = action.label; btn.onclick = () => { action.run(); el.classList.remove('is-shown') } }
    el.classList.add('is-shown')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('is-shown'), action ? 6000 : 2800)
  }

  let unseen = 0
  function notify(message) {
    const inbox = $('.inbox')
    const r = inbox.getBoundingClientRect()
    const offscreen = r.top > innerHeight - 80 || r.bottom < 80
    toast(message, offscreen ? { label: 'View', run: () => inbox.scrollIntoView({ behavior: 'smooth', block: 'start' }) } : null)
    if (document.hidden) { unseen++; document.title = `(${unseen}) Flick` }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { unseen = 0; document.title = 'Flick' } })

  /* Keep the screen awake and warn before leaving while anything is moving. */
  let wakeLock = null
  const busy = () => [...outgoing.values()].some(t => ['queued', 'sending', 'flushing'].includes(t.status)) ||
    [...incoming.values()].some(t => t.status === 'receiving')
  async function keepAwake() {
    try {
      if (busy() && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen')
        wakeLock.addEventListener('release', () => { wakeLock = null })
      } else if (!busy() && wakeLock) { await wakeLock.release(); wakeLock = null }
    } catch { /* not allowed right now */ }
  }
  addEventListener('beforeunload', e => { if (busy()) { e.preventDefault(); e.returnValue = '' } })

  /* ---------- drag and drop, paste ---------- */

  const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files')

  function dropTarget(el, onFiles) {
    let depth = 0
    el.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; el.classList.add('is-over') })
    el.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault() })
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('is-over') } })
    el.addEventListener('drop', e => {
      if (!hasFiles(e)) return
      e.preventDefault(); e.stopPropagation(); depth = 0
      el.classList.remove('is-over'); document.body.classList.remove('is-dragging')
      onFiles(e.dataTransfer.files)
    })
  }
  dropTarget($('#shareForm'), shareFilesNow)

  // Files dropped anywhere else are shared with everyone nearby at once.
  let dragDepth = 0
  addEventListener('dragenter', e => {
    if (!hasFiles(e)) return
    dragDepth++
    document.body.classList.add('is-dragging')
    $('#dropSub').textContent = readyPeers().length ? 'Or drop it on one device to send it only there.' : 'Anyone who opens Flick on this Wi‑Fi will get it.'
  })
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dragging') } })
  addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } })
  addEventListener('drop', e => {
    if (!hasFiles(e)) return
    e.preventDefault(); dragDepth = 0
    document.body.classList.remove('is-dragging')
    shareFilesNow(e.dataTransfer.files)
  })

  // Pasting outside a text field also goes into "Share with everyone".
  document.addEventListener('paste', e => {
    if (e.target.closest?.('input, textarea')) return
    const files = e.clipboardData?.files
    const text = e.clipboardData?.getData('text/plain')
    if (files?.length) addDraftFiles(files)
    else if (text) { const ta = $('#shareText'); ta.value = (ta.value ? `${ta.value}\n` : '') + text; ta.focus() }
  })

  /* ---------- rename ---------- */

  function renderMe() {
    $('#myName').textContent = me.name
    $('#myIcon').innerHTML = icon(me.kind)
  }
  $('#renameBtn').addEventListener('click', () => {
    $('#renameForm').hidden = false
    $('.me-line').hidden = true
    $('#renameBtn').hidden = true
    const input = $('#renameInput')
    input.value = me.name
    input.focus(); input.select()
  })
  const closeRename = () => { $('#renameForm').hidden = true; $('.me-line').hidden = false; $('#renameBtn').hidden = false }
  $('#renameForm').addEventListener('submit', e => {
    e.preventDefault()
    const name = clean($('#renameInput').value, 32)
    if (name && name !== me.name) {
      me.name = name
      store.set('flick.name', name)
      renderMe()
      for (const p of peers.values()) ctl(p, helloMsg())
    }
    closeRename()
  })
  $('#renameInput').addEventListener('keydown', e => { if (e.key === 'Escape') closeRename() })

  /* ---------- network and link rooms ---------- */

  async function publicIPv4() {
    for (const url of ['https://api.ipify.org?format=json', 'https://ipv4.icanhazip.com']) {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined })
        const body = (await res.text()).trim()
        const ip = body.startsWith('{') ? JSON.parse(body).ip : body
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
      } catch { /* try the next source */ }
    }
    return null
  }

  async function joinNetwork() {
    netState = 'finding'; renderStatus()
    const ip = await publicIPv4()
    if (!ip) { netState = 'off'; renderStatus(); return }
    await net.join('net', `network:${ip}`)
    netState = 'on'; renderStatus()
  }

  function joinLink(code) {
    linkCode = code
    net.join('link', `link:${code}`)
    if (location.hash !== `#r=${code}`) history.replaceState(null, '', `#r=${code}`)
    renderStatus()
  }

  function leaveLink() {
    linkCode = null
    net.leave('link')
    history.replaceState(null, '', location.pathname + location.search)
    renderStatus()
  }

  // The QR library is only needed for the link sheet, so it loads the first time someone reaches for it.
  let qrLib = null
  function loadQR() {
    qrLib ||= new Promise(resolve => {
      const script = document.createElement('script')
      script.src = 'vendor/qrcode.min.js'
      script.onload = () => resolve(window.QR && (window.QR.default || window.QR))
      script.onerror = () => { qrLib = null; resolve(null) }
      document.head.append(script)
    })
    return qrLib
  }
  for (const id of ['#linkBtn', '#emptyLinkBtn']) $(id).addEventListener('pointerenter', loadQR, { once: true })

  const linkUrl = () => `${location.origin}${location.pathname}#r=${linkCode}`
  function openLinkSheet() {
    if (!net) return
    if (!linkCode) joinLink(uid(10))
    const url = linkUrl()
    $('#linkField').value = url
    const box = $('#qrBox')
    box.replaceChildren()
    loadQR().then(QR => {
      if (!QR || $('#linkField').value !== url) return
      try {
        const qr = QR(0, 'M'); qr.addData(url); qr.make()
        box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
      } catch { box.hidden = true }
    })
    $('#shareLink').hidden = !navigator.share
    const dlg = $('#linkDialog')
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '')
  }
  $('#linkBtn').addEventListener('click', openLinkSheet)
  $('#emptyLinkBtn').addEventListener('click', openLinkSheet)
  $('#copyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(linkUrl()); toast('Link copied') }
    catch { $('#linkField').select(); toast('Select the link and copy it') }
  })
  $('#shareLink').addEventListener('click', () => {
    navigator.share({ title: 'Flick', text: 'Open this to share files with me', url: linkUrl() }).catch(() => {})
  })
  $('#stopLink').addEventListener('click', () => { leaveLink(); $('#linkDialog').close(); toast('Link turned off') })
  $('#linkDialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close() })

  /* ---------- entrance motion ---------- */

  function reveal() {
    const els = [...document.querySelectorAll('.reveal')]
    if (!('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('is-in')); return }
    const io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target) }
    }, { rootMargin: '0px 0px -8% 0px' })
    // Measure everything first, then write, so the browser lays out once.
    const tops = els.map(el => el.getBoundingClientRect().top)
    let i = 0
    els.forEach((el, n) => {
      const column = el.parentElement.classList.contains('how-list') ? [...el.parentElement.children].indexOf(el) % 2 : 0
      el.style.setProperty('--d', `${tops[n] < innerHeight ? i++ * 80 : column * 80}ms`)
      io.observe(el)
    })
  }

  /* ---------- GitHub stars ---------- */

  // Shows the last known count straight away, then asks GitHub again if that count is over
  // five minutes old or zero (at most 12 requests an hour; GitHub allows 60 without a token).
  // On any failure the button simply has no count.
  function showStars(n) {
    const link = $('#starLink')
    link.classList.toggle('has-count', n > 0)
    $('#starCount').textContent = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)
    link.querySelector('.star-sr').textContent = n > 0 ? `, ${n} ${n === 1 ? 'star' : 'stars'}` : ''
  }

  async function loadStars() {
    const KEY = 'flick-stars', FRESH = 5 * 60e3
    let cached = null
    try { cached = JSON.parse(localStorage.getItem(KEY)) } catch {}
    if (cached && typeof cached.n === 'number') showStars(cached.n)
    if (cached && cached.n > 0 && Date.now() - cached.t < FRESH) return
    try {
      const res = await fetch('https://api.github.com/repos/mhfrough/flick', { cache: 'no-store' })
      const n = res.ok ? (await res.json()).stargazers_count : null
      if (typeof n !== 'number') return
      try { localStorage.setItem(KEY, JSON.stringify({ n, t: Date.now() })) } catch {}
      showStars(n)
    } catch {}
  }

  /* ---------- theme ---------- */

  // Follows the system until you pick; picking the system's own choice goes back to following it.
  const darkQuery = matchMedia('(prefers-color-scheme: dark)')
  const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')) === 'dark'

  function renderTheme() {
    const dark = isDark(), btn = $('#themeBtn'), label = dark ? 'Switch to light mode' : 'Switch to dark mode'
    btn.innerHTML = icon(dark ? 'sun' : 'moon')
    btn.setAttribute('aria-label', label)
    btn.title = label
    const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim()
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = ground
  }

  $('#themeBtn').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark'
    const system = darkQuery.matches ? 'dark' : 'light'
    if (next === system) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = next
    try { next === system ? localStorage.removeItem('flick-theme') : localStorage.setItem('flick-theme', next) } catch {}
    renderTheme()
  })
  darkQuery.addEventListener?.('change', renderTheme)

  /* ---------- start ---------- */

  renderMe()
  renderDraft()
  renderBoard()
  renderInboxChrome()
  reveal()
  renderTheme()
  loadStars()
  if (sharedIn) $('#shareText').value = sharedIn
  $('#hereLink').href = location.origin + location.pathname
  $('#hereLink').textContent = location.protocol.startsWith('http') ? location.host + location.pathname.replace(/index\.html$/, '') : 'this page'
  setTimeout(() => { if (!peers.size) $('#emptyHint').hidden = false }, 15000)

  if (!window.FlickNet || !window.RTCPeerConnection || !crypto.subtle) {
    netState = 'off'; renderStatus()
    toast('This browser cannot make direct connections. Try a current Chrome, Safari, Edge or Firefox over https.')
    return
  }

  net = window.FlickNet.create({ selfId, onOpen, onClose, onState: renderStatus })
  const hashCode = (location.hash.match(/^#r=([a-z0-9]{6,32})$/) || [])[1]
  if (hashCode) joinLink(hashCode)
  joinNetwork()

})()
