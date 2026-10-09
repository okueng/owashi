// The sim's end of the Art-Net bridge (bridge/artnet-bridge.mjs), over a WebSocket.
//   send   — the universes the show writes go out to the real rig, ~40 times a second
//   mirror — the show stops and whatever a desk sends on the network is drawn instead

import { universes } from './dmx.js';

export const artnet = {
  mode: 'off',
  state: 'off',          // off · connecting · connected · offline
  nodes: [],             // Art-Net boxes / WLED that answered the bridge's poll
  routes: [],
  receiving: true,       // false if the bridge couldn't open port 6454 (then it can't mirror)
  lastIn: 0,             // performance.now() of the last frame from a desk
  onChange: () => {},
};

let ws = null, retry = 0, lastSend = 0;
const url = () => `ws://${location.hostname || 'localhost'}:8770`;

function connect() {
  clearTimeout(retry);
  artnet.state = 'connecting'; artnet.onChange();
  ws = new WebSocket(url());
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    artnet.state = 'connected';
    ws.send(JSON.stringify({ type: 'mode', mode: artnet.mode }));
    artnet.onChange();
  };
  ws.onclose = () => {
    ws = null;
    if (artnet.mode === 'off') { artnet.state = 'off'; artnet.onChange(); return; }
    artnet.state = 'offline'; artnet.onChange();
    retry = setTimeout(connect, 3000);
  };
  ws.onmessage = e => {
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.routes) artnet.routes = m.routes;
      if (m.nodes) artnet.nodes = m.nodes;
      if ('receiving' in m) artnet.receiving = m.receiving;
      artnet.onChange();
      return;
    }
    const b = new Uint8Array(e.data);   // [2, sim universe, 512 bytes]
    if (b[0] === 2 && artnet.mode === 'mirror' && universes[b[1] - 1]) {
      universes[b[1] - 1].set(b.subarray(2, 514));
      artnet.lastIn = performance.now();
    }
  };
}

export function setMode(mode) {
  artnet.mode = mode;
  if (mode === 'off') {
    clearTimeout(retry);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mode', mode }));
    ws?.close();
  } else if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'mode', mode }));
  } else if (!ws) {
    connect();
  }
  artnet.onChange();
}

export function poll() { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'poll' })); }

// Call once per frame, after the show has written the universes.
export function pump(now) {
  if (artnet.mode !== 'send' || ws?.readyState !== WebSocket.OPEN || now - lastSend < 24) return;
  lastSend = now;
  const buf = new Uint8Array(1 + universes.length * 513);
  buf[0] = 1;
  universes.forEach((u, i) => { buf[1 + i * 513] = i + 1; buf.set(u, 2 + i * 513); });
  ws.send(buf);
}
