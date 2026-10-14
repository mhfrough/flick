# Flick

Flick it to the next screen. Share files and text between nearby devices, straight from the browser.

**Try it:** https://mhfrough.github.io/flick/

- **No sign-up, no codes, no PIN.** Open Flick on two devices on the same Wi-Fi and they find each other.
- **Share with everyone** (like AirForShare): paste text or add files once and every device on the network gets them, including devices that open Flick later.
- **Or send to one device** (like AirDrop): tap a device, or drop files on it.
- **Drag and drop.** Drag files anywhere onto the page and they're shared with everyone at once. Drop them on one device to send to that device only.
- **Different networks?** Share a private link or QR code.
- **Frontend only.** Static files you can host anywhere. No backend, no database, no build step.
- **Direct and encrypted.** Files go browser to browser over WebRTC. Nothing is uploaded or stored.

## How it works

```
 Phone                         public MQTT brokers                      Laptop
   │  encrypted "I'm here" ───────►  (only see noise)  ◄─────── encrypted "I'm here"
   │  encrypted WebRTC handshake ◄──────────────────────────►                │
   │                                                                          │
   └══════════════ direct WebRTC data channel: files and text ════════════════┘
```

1. **Finding your Wi-Fi.** Flick asks `api.ipify.org` (fallback `ipv4.icanhazip.com`) for your public IPv4 address. Devices behind the same router share it, so it becomes a meeting point. The address is hashed before use, and the topic name and encryption key are both derived from it.
2. **Introductions.** Browsers can't reach each other until something passes a few handshake messages (WebRTC signalling). With no server of its own, Flick uses free public MQTT brokers (EMQX, Mosquitto, HiveMQ) through a small built-in MQTT client, all three at once for redundancy. Every message is AES-GCM encrypted in the page first, so brokers see only random bytes on a hashed topic.
3. **Transfer.** Once connected, devices talk over an RTCDataChannel (DTLS-encrypted). Flick's protocol is JSON control messages plus raw 64 KB binary chunks with back-pressure. Files are always offered first and only sent once the receiver accepts.

Bluetooth is not an option for a website: Web Bluetooth can only connect to Bluetooth gadgets. It cannot advertise, so two browsers can never discover each other over it.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Markup |
| `styles.css` | All styling (light and dark) |
| `net.js` | Discovery and connections: tiny MQTT client, encrypted signalling, WebRTC |
| `app.js` | The app: devices, share-with-everyone board, transfers, inbox |
| `icon.svg` | Favicon |
| `assets/fonts/` | Bricolage Grotesque (SIL OFL 1.1, licence alongside), served from here rather than Google Fonts |
| `assets/og-image.jpg`, `robots.txt`, `sitemap.xml` | Share card and search engine files |
| `vendor/qrcode.min.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), the only third-party code. Loaded only when the link sheet opens |

Apart from the services above, the page makes one other request: the star count in the header comes from the GitHub API (`api.github.com`), refreshed at most every five minutes.

## Run it locally

Any static server works. WebRTC and Web Crypto need `https://` or `localhost`.

```bash
python -m http.server 8000
```

Then open http://localhost:8000 on this computer. To test with your phone, deploy it (below) or serve it over HTTPS on your LAN. Phones won't allow `http://192.168.x.x` for these features.

## Deploy

Upload the folder to any static host: GitHub Pages, Netlify, Cloudflare Pages, Vercel. Nothing to configure.

## Limits

- Both pages need to stay open during a transfer. Phones pause background tabs, so keep Flick on screen.
- Received files are held in memory until you save them, so very large files (several GB) work best on a computer.
- Devices on guest Wi-Fi, phone hotspots or networks with client isolation may not see each other. Use the link.
- About 1 in 10 network setups (strict corporate NATs) block direct connections entirely. Fixing that needs a TURN relay server, which this frontend-only build doesn't include. Add one in `ICE_SERVERS` in `net.js` if you have one.
- Everyone behind the same public IP counts as "nearby". On large shared networks (campus, office, mobile carrier) that can include strangers, which is why files always need to be accepted first.
- Public MQTT brokers are free community services with no uptime guarantee. Flick uses three at once, and you can swap or add any MQTT-over-WebSocket broker in `BROKERS` in `net.js`.

## Licence

MIT. See `LICENSE`.

Made by Mohammad Hamza ([@mhfrough](https://github.com/mhfrough)).
