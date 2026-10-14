/* Flick networking: finds other browsers and opens a direct WebRTC data channel to each one.
 *
 * Browsers cannot reach each other until something passes them a few handshake messages
 * (WebRTC "signalling"). Flick has no server, so it borrows free public MQTT brokers for that,
 * talking to several at once for redundancy. Every handshake message is encrypted with AES-GCM
 * using a key derived from the room secret, and the topic name is a hash, so a broker only ever
 * sees noise. Once two browsers are connected, all data flows directly between them.
 *
 * API: FlickNet.create({ selfId, onOpen(peerId, channel), onClose(peerId), onState(brokersUp) })
 *        .join(key, secret)  .leave(key)  .brokers()
 */
(() => {
  'use strict'

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ]
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ]
  const ANNOUNCE_MS = 6000
  const CONNECT_TIMEOUT_MS = 25000

  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)))

  /* ---------- a minimal MQTT 3.1.1 client over WebSocket (QoS 0 only) ---------- */

  const mqttString = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b] }

  function mqttPacket(head, body) {
    const len = []
    let x = body.length
    do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; len.push(d) } while (x > 0)
    const out = new Uint8Array(1 + len.length + body.length)
    out[0] = head
    out.set(len, 1)
    out.set(body, 1 + len.length)
    return out
  }

  class Mqtt {
    constructor(url, { onMessage, onState }) {
      this.url = url
      this.onMessage = onMessage
      this.onState = onState
      this.topics = new Set()
      this.ready = false
      this.stopped = false
      this.backoff = 1000
      this.packetId = 1
      this.open()
    }

    open() {
      let ws
      try { ws = new WebSocket(this.url, 'mqtt') } catch { return this.retry() }
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      this.buf = new Uint8Array(0)
      ws.onopen = () => {
        const clientId = `flick${randomId()}`.slice(0, 23)
        ws.send(mqttPacket(0x10, [...mqttString('MQTT'), 4, 0x02, 0, 60, ...mqttString(clientId)]))
      }
      ws.onmessage = e => this.feed(new Uint8Array(e.data))
      ws.onclose = () => this.retry()
      ws.onerror = () => {}
    }

    retry() {
      const wasReady = this.ready
      this.ready = false
      clearInterval(this.pinger)
      if (this.ws) { this.ws.onclose = null; try { this.ws.close() } catch { /* already closed */ } this.ws = null }
      if (wasReady) this.onState()
      if (this.stopped) return
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 30000)
    }

    feed(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length)
      merged.set(this.buf); merged.set(chunk, this.buf.length)
      let buf = merged
      for (;;) {
        if (buf.length < 2) break
        let len = 0, mul = 1, i = 1, byte
        do {
          if (i >= buf.length) { byte = -1; break }
          byte = buf[i++]
          len += (byte & 127) * mul
          mul *= 128
        } while (byte & 128)
        if (byte === -1 || buf.length < i + len) break
        this.handle(buf[0], buf.subarray(i, i + len))
        buf = buf.subarray(i + len)
      }
      this.buf = buf.slice()
    }

    handle(head, body) {
      const type = head >> 4
      if (type === 2) {                     // CONNACK
        if (body[1] !== 0) { this.ws.close(); return }
        this.ready = true
        this.backoff = 1000
        if (this.topics.size) this.send(this.subscribePacket([...this.topics]))
        this.pinger = setInterval(() => this.send(new Uint8Array([0xc0, 0])), 30000)
        this.onState()
      } else if (type === 3) {              // PUBLISH
        const tlen = (body[0] << 8) | body[1]
        const topic = dec.decode(body.subarray(2, 2 + tlen))
        const qos = (head >> 1) & 3
        this.onMessage(topic, body.subarray(2 + tlen + (qos ? 2 : 0)))
      }
    }

    send(bytes) {
      if (this.ready && this.ws?.readyState === 1) { try { this.ws.send(bytes) } catch { /* reconnect will follow */ } }
    }

    nextId() { this.packetId = (this.packetId % 65535) + 1; return this.packetId }
    subscribePacket(topics) { const id = this.nextId(); return mqttPacket(0x82, [id >> 8, id & 255, ...topics.flatMap(t => [...mqttString(t), 0])]) }

    subscribe(topics) { topics.forEach(t => this.topics.add(t)); this.send(this.subscribePacket(topics)) }
    unsubscribe(topics) {
      topics.forEach(t => this.topics.delete(t))
      const id = this.nextId()
      this.send(mqttPacket(0xa2, [id >> 8, id & 255, ...topics.flatMap(mqttString)]))
    }
    publish(topic, payload) {
      const t = mqttString(topic)
      const body = new Uint8Array(t.length + payload.length)
      body.set(t); body.set(payload, t.length)
      this.send(mqttPacket(0x30, body))
    }
  }

  /* ---------- room crypto ---------- */

  async function roomKeys(secret) {
    const sha = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
    const topic = `flick/v1/${hex(await sha(`flick-topic:${secret}`)).slice(0, 40)}`
    const key = await crypto.subtle.importKey('raw', await sha(`flick-key:${secret}`), 'AES-GCM', false, ['encrypt', 'decrypt'])
    return { topic, key }
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))))
    const out = new Uint8Array(12 + ct.length)
    out.set(iv); out.set(ct, 12)
    return out
  }

  async function unseal(key, bytes) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))
      return JSON.parse(dec.decode(pt))
    } catch { return null }
  }

  /* ---------- signalling and peer connections ---------- */

  function create({ selfId, onOpen, onClose, onState }) {
    const rooms = new Map()   // key -> { key, topic, cryptoKey, timer }
    const peers = new Map()   // peerId -> { pc, dc, room, rooms:Set, open, ice:[], remote }
    const early = new Map()   // peerId -> ICE candidates that arrived before the offer
    const seen = new Set()

    const brokersUp = () => clients.filter(c => c.ready).length
    const clients = BROKERS.map(url => new Mqtt(url, {
      onMessage: route,
      onState: () => { onState?.(brokersUp()); announceAll() },
    }))

    async function route(topic, bytes) {
      for (const room of rooms.values()) {
        if (topic !== room.topic && topic !== `${room.topic}/${selfId}`) continue
        const msg = await unseal(room.cryptoKey, bytes)
        if (!msg || msg.f === selfId || typeof msg.f !== 'string' || seen.has(msg.m)) return
        seen.add(msg.m)
        if (seen.size > 2000) seen.delete(seen.values().next().value)
        handle(room, msg).catch(e => console.warn('[flick] signal', e))
        return
      }
    }

    async function signal(room, msg, to) {
      if (!rooms.has(room.key)) return
      const sealed = await seal(room.cryptoKey, { ...msg, f: selfId, m: randomId() })
      const topic = to ? `${room.topic}/${to}` : room.topic
      clients.forEach(c => c.publish(topic, sealed))
    }

    function announceAll() { for (const room of rooms.values()) signal(room, { k: 'here' }) }

    async function handle(room, msg) {
      const id = msg.f
      const p = peers.get(id)
      if (msg.k === 'here') {
        if (p) { p.rooms.add(room.key); return }
        // The lower id dials; the higher id answers with a direct "here" so the lower one notices it.
        if (selfId < id) await dial(room, id)
        else signal(room, { k: 'here' }, id)
      } else if (msg.k === 'sdp' && msg.d?.type === 'offer') {
        if (p?.open) return
        if (p) kill(id)
        const q = makePeer(room, id, false)
        await q.pc.setRemoteDescription(msg.d)
        await flushIce(q)
        await q.pc.setLocalDescription(await q.pc.createAnswer())
        signal(room, { k: 'sdp', d: q.pc.localDescription.toJSON() }, id)
      } else if (msg.k === 'sdp' && msg.d?.type === 'answer') {
        if (!p || p.pc.signalingState !== 'have-local-offer') return
        await p.pc.setRemoteDescription(msg.d)
        await flushIce(p)
      } else if (msg.k === 'ice' && msg.c) {
        if (p?.remote) await p.pc.addIceCandidate(msg.c).catch(() => {})
        else if (p) p.ice.push(msg.c)
        else { const list = early.get(id) || []; list.push(msg.c); early.set(id, list.slice(-50)) }
      }
    }

    async function flushIce(p) {
      p.remote = true
      const queued = [...(early.get(p.id) || []), ...p.ice]
      early.delete(p.id)
      p.ice = []
      for (const c of queued) await p.pc.addIceCandidate(c).catch(() => {})
    }

    async function dial(room, id) {
      const p = makePeer(room, id, true)
      await p.pc.setLocalDescription(await p.pc.createOffer())
      signal(room, { k: 'sdp', d: p.pc.localDescription.toJSON() }, id)
    }

    function makePeer(room, id, initiator) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      const p = { id, pc, dc: null, room, rooms: new Set([room.key]), open: false, ice: [], remote: false }
      peers.set(id, p)
      pc.onicecandidate = e => { if (e.candidate) signal(room, { k: 'ice', c: e.candidate.toJSON() }, id) }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') kill(id)
        if (pc.connectionState === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected') kill(id) }, 6000)
      }
      const wire = dc => {
        p.dc = dc
        dc.binaryType = 'arraybuffer'
        dc.bufferedAmountLowThreshold = 1 << 20
        dc.onopen = () => { p.open = true; clearTimeout(p.timer); onOpen(id, dc) }
        dc.onclose = () => kill(id)
      }
      if (initiator) wire(pc.createDataChannel('flick', { ordered: true }))
      else pc.ondatachannel = e => wire(e.channel)
      p.timer = setTimeout(() => { if (!p.open) kill(id) }, CONNECT_TIMEOUT_MS)
      return p
    }

    function kill(id) {
      const p = peers.get(id)
      if (!p) return
      peers.delete(id)
      clearTimeout(p.timer)
      try { p.dc?.close() } catch { /* ignore */ }
      try { p.pc.close() } catch { /* ignore */ }
      if (p.open) onClose(id)
    }

    return {
      async join(key, secret) {
        if (rooms.has(key)) return
        const { topic, key: cryptoKey } = await roomKeys(secret)
        const room = { key, topic, cryptoKey }
        rooms.set(key, room)
        clients.forEach(c => c.subscribe([topic, `${topic}/${selfId}`]))
        signal(room, { k: 'here' })
        room.timer = setInterval(() => signal(room, { k: 'here' }), ANNOUNCE_MS)
      },
      leave(key) {
        const room = rooms.get(key)
        if (!room) return
        rooms.delete(key)
        clearInterval(room.timer)
        clients.forEach(c => c.unsubscribe([room.topic, `${room.topic}/${selfId}`]))
        for (const p of [...peers.values()]) {
          p.rooms.delete(key)
          if (!p.rooms.size) kill(p.id)
        }
      },
      brokers: brokersUp,
      close() { for (const id of [...peers.keys()]) kill(id); clients.forEach(c => { c.stopped = true; c.retry() }) },
    }
  }

  window.FlickNet = { create }
})()
