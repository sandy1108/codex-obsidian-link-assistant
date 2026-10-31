import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession, isCodexPageTarget, validatedDebuggerUrl } from '../src/cdp-client.mjs';

const port = 9341;
const target = {
  id: 'page_123',
  type: 'page',
  url: 'app://-/index.html',
  webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page_123`,
};

test('accepts only a local Codex page target with matching id and port', () => {
  assert.equal(isCodexPageTarget(target, port), true);
  assert.equal(isCodexPageTarget({ ...target, url: 'https://example.com' }, port), false);
  assert.equal(isCodexPageTarget({ ...target, id: 'bad/id' }, port), false);
  assert.equal(isCodexPageTarget({ ...target, webSocketDebuggerUrl: target.webSocketDebuggerUrl.replace('9341', '9342') }, port), false);
});

test('rejects debugger endpoints outside loopback or the page endpoint shape', () => {
  for (const endpoint of [
    `ws://192.168.1.5:${port}/devtools/page/page_123`,
    `ws://127.0.0.1:${port}/devtools/browser/page_123`,
    `ws://127.0.0.1:9342/devtools/page/page_123`,
    `ws://user@127.0.0.1:${port}/devtools/page/page_123`,
  ]) {
    assert.throws(() => validatedDebuggerUrl(endpoint, port));
  }
});

test('reports a closed WebSocket session so the supervisor can reconnect safely', () => {
  class FakeWebSocket {
    readyState = 1;
    listeners = new Map();
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() {
      this.readyState = 3;
      this.listeners.get('close')?.();
    }
  }
  const session = new CdpSession(target, port, FakeWebSocket);
  assert.equal(session.closed, false);
  session.close();
  assert.equal(session.closed, true);
});
