import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { isVaultMarkdownHref, buildRendererSource } from '../src/renderer-patch.mjs';

const vaultRoot = '/Users/example/ExampleVault/';
const prefix = pathToFileURL(vaultRoot).href;

test('decorates only file Markdown links inside the selected vault', () => {
  assert.equal(isVaultMarkdownHref(`${prefix}笔记/计划.md#后续`, prefix), true);
  assert.equal(isVaultMarkdownHref(`${prefix}笔记/image.png`, prefix), false);
  assert.equal(isVaultMarkdownHref(`${prefix}../outside.md`, prefix), false);
  assert.equal(isVaultMarkdownHref('https://example.com/note.md', prefix), false);
  assert.equal(isVaultMarkdownHref(`${prefix}other.md?download=1`, prefix), false);
  assert.equal(isVaultMarkdownHref('file:///Users/example/ExampleVault-Evil/note.md', prefix), false);
});

test('builds an isolated renderer payload with a validated binding name', () => {
  const source = buildRendererSource({ bindingName: 'openObsidianNote9', vaultFileUrlPrefix: prefix });
  assert.match(source, /window\.top\s*!==\s*window/u);
  assert.match(source, /data-local-conversation-final-assistant/u);
  assert.match(source, /↗ 在 Obsidian 打开/u);
  assert.match(source, /复制 Obsidian URI/u);
  assert.match(source, /:hover/u);
  assert.match(source, /:focus-visible/u);
  assert.match(source, /outline: none/u);
  assert.doesNotMatch(source, /outline: 2px solid currentColor/u);
  assert.match(source, /border-radius:\s*999px/u);
  assert.throws(() => buildRendererSource({ bindingName: 'bad-name', vaultFileUrlPrefix: prefix }));
});

test('renderer is idempotent and removes observer, buttons, and listeners during cleanup', () => {
  const source = buildRendererSource({ bindingName: 'openObsidianNote9', vaultFileUrlPrefix: prefix });
  assert.match(source, /existing\.cleanup\?\.\(\)/u);
  assert.match(source, /observer\?\.disconnect\(\)/u);
  assert.match(source, /removeEventListener\('click'/u);
  assert.match(source, /window\.removeEventListener\('pagehide'/u);
  assert.match(source, /record\.target\.isConnected/u);
  assert.match(source, /data-prompt-link-href/u);
});

test('renderer decorates current Codex prompt-link file references and cleans removed DOM nodes', () => {
  class Element {
    constructor(tag, href = '', attributes = {}) {
      this.tagName = tag.toUpperCase();
      this.textContent = '';
      this.href = href;
      this.attributes = new Map(Object.entries(attributes));
      if (href) this.attributes.set('href', href);
      this.listeners = new Map();
      this.children = [];
      this.parentElement = null;
      this.isConnected = false;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
    }
    get nextSibling() { return this.nextElementSibling; }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value = '') { this.attributes.set(name, String(value)); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
      this.isConnected = false;
    }
    insertBefore(node, next) {
      const index = next ? this.children.indexOf(next) : -1;
      if (index < 0) this.children.push(node);
      else this.children.splice(index, 0, node);
      node.parentElement = this;
      node.isConnected = this.isConnected;
    }
  }

  const root = new Element('main');
  root.isConnected = true;
  const validHref = `${prefix}目录/笔记.md#标题`;
  const legacyHref = `${prefix}旧DOM/笔记.md`;
  const valid = new Element('span', '', { role: 'button', 'data-prompt-link-href': validHref });
  const legacy = new Element('a', legacyHref);
  const outside = new Element('span', '', {
    role: 'button', 'data-prompt-link-href': 'file:///Users/example/ExampleVault-Evil/其他.md',
  });
  const image = new Element('span', '', { role: 'button', 'data-prompt-link-href': `${prefix}image.png` });
  const queried = new Element('span', '', {
    role: 'button', 'data-prompt-link-href': `${prefix}笔记.md?download=1`,
  });
  for (const target of [valid, outside, image, queried, legacy]) root.insertBefore(target, null);
  const targets = [valid, outside, image, queried, legacy];
  const document = {
    documentElement: root,
    querySelectorAll: (selector) => selector.includes('data-prompt-link-href')
      ? targets.filter((target) => target.isConnected)
      : [],
    createElement: (tag) => new Element(tag),
  };
  let observerCallback;
  let observerDisconnected = false;
  class MutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  }
  const animationFrames = new Map();
  let nextFrame = 1;
  const flushAnimationFrames = () => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of callbacks) callback();
  };
  const pageWindow = {
    top: null,
    addEventListener() {},
    removeEventListener() {},
  };
  pageWindow.top = pageWindow;
  const requests = [];
  pageWindow.openObsidianNote9 = (payload) => requests.push(JSON.parse(payload));
  const source = buildRendererSource({ bindingName: 'openObsidianNote9', vaultFileUrlPrefix: prefix });
  const context = vm.createContext({
    window: pageWindow,
    document,
    location: { protocol: 'app:', href: 'app://-/index.html' },
    URL,
    MutationObserver,
    Map,
    JSON,
    requestAnimationFrame: (callback) => {
      const id = nextFrame++;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => animationFrames.delete(id),
  });

  vm.runInContext(source, context);
  assert.equal(root.children.filter((item) => item.hasAttribute('data-codex-obsidian-link-assistant-v1')).length, 2);
  const stylesheet = root.children.find((item) => item.hasAttribute('data-codex-obsidian-link-assistant-style-v1'));
  assert.ok(stylesheet);
  assert.match(stylesheet.textContent, /border-radius:\s*999px/u);
  assert.match(stylesheet.textContent, /:hover/u);
  assert.match(stylesheet.textContent, /:focus-visible/u);
  assert.match(stylesheet.textContent, /outline:\s*none/u);
  assert.doesNotMatch(stylesheet.textContent, /outline:\s*2px solid currentColor/u);
  assert.match(stylesheet.textContent, /border-color:\s*rgba\(127,127,127,0\.72\)/u);
  assert.match(stylesheet.textContent, /\[data-codex-obsidian-link-assistant-v1\]:hover, \[data-codex-obsidian-link-assistant-copy-v1\]:hover/u);
  assert.match(stylesheet.textContent, /\[data-codex-obsidian-link-assistant-v1\]:focus-visible, \[data-codex-obsidian-link-assistant-copy-v1\]:focus-visible/u);
  assert.match(stylesheet.textContent, /\[data-codex-obsidian-link-assistant-v1\]:active, \[data-codex-obsidian-link-assistant-copy-v1\]:active/u);
  assert.match(stylesheet.textContent, /width:\s*1\.8em/u);
  assert.match(stylesheet.textContent, /height:\s*1\.8em/u);
  assert.match(stylesheet.textContent, /\[data-codex-obsidian-link-assistant-copy-v1\]\s*\{[^}]*border-radius:\s*0\.35em/u);
  const button = root.children.find((item) => item.hasAttribute('data-codex-obsidian-link-assistant-v1'));
  const legacyButton = root.children.find((item) => item.hasAttribute('data-codex-obsidian-link-assistant-v1') && item !== button);
  const copyButton = root.children.find((item) => item.hasAttribute('data-codex-obsidian-link-assistant-copy-v1'));
  assert.equal(button.textContent, '↗ 在 Obsidian 打开');
  assert.ok(copyButton);
  assert.equal(valid.nextElementSibling, button);
  assert.equal(button.nextElementSibling, copyButton);
  assert.equal(copyButton.textContent, '⧉');
  assert.equal(copyButton.getAttribute('aria-label'), '复制 Obsidian URI');
  const tooltipRequests = requests.splice(0);
  assert.deepEqual(tooltipRequests, [
    { action: 'tooltip', href: validHref, token: 'tooltip-1' },
    { action: 'tooltip', href: legacyHref, token: 'tooltip-2' },
  ]);
  const tooltipRequest = tooltipRequests.find((request) => request.href === validHref);
  const canonicalUri = 'obsidian://open?vault=ExampleVault&file=目录/笔记.md';
  assert.equal(pageWindow.__codexObsidianLinkAssistantV1.setTooltip(tooltipRequest.token, canonicalUri), true);
  assert.equal(button.title, canonicalUri);
  assert.equal(copyButton.title, canonicalUri);
  let prevented = false;
  let stopped = false;
  button.listeners.get('click')({
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  assert.deepEqual(requests, [{ href: validHref }]);
  assert.equal(prevented && stopped, true);
  legacyButton.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(requests, [{ href: validHref }, { href: legacyHref }]);
  copyButton.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(requests, [
    { href: validHref },
    { href: legacyHref },
    { action: 'copy', href: validHref },
  ]);

  vm.runInContext(source, context);
  assert.equal(root.children.filter((item) => item.hasAttribute('data-codex-obsidian-link-assistant-v1')).length, 2);
  const currentButtons = root.children.filter((item) => item.hasAttribute('data-codex-obsidian-link-assistant-v1'));
  const currentButton = currentButtons[0];
  const currentLegacyButton = currentButtons[1];
  valid.remove();
  observerCallback();
  flushAnimationFrames();
  assert.equal(currentButton.isConnected, false);
  assert.equal(currentButton.listeners.has('click'), false);
  assert.equal(currentLegacyButton.isConnected, true);

  pageWindow.__codexObsidianLinkAssistantV1.cleanup();
  assert.equal(observerDisconnected, true);
  assert.equal(root.children.some((item) => item.hasAttribute('data-codex-obsidian-link-assistant-v1')), false);
  assert.equal(root.children.some((item) => item.hasAttribute('data-codex-obsidian-link-assistant-style-v1')), false);
});
