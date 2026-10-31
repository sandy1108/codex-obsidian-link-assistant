import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isVaultMarkdownHref(href, vaultFileUrlPrefix) {
  if (typeof href !== 'string' || typeof vaultFileUrlPrefix !== 'string') return false;
  try {
    const url = new URL(href);
    const prefix = new URL(vaultFileUrlPrefix);
    if (url.protocol !== 'file:' || url.host !== '' || url.username || url.password || url.search
      || prefix.protocol !== 'file:' || prefix.host !== '') return false;
    const absolutePath = fileURLToPath(url);
    const vaultRoot = fileURLToPath(prefix);
    const relative = path.relative(vaultRoot, absolutePath);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return false;
    return path.extname(absolutePath).toLowerCase() === '.md';
  } catch {
    return false;
  }
}

export function buildRendererSource({ bindingName, vaultFileUrlPrefix, vaultRoot: configuredVaultRoot }) {
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(bindingName)) {
    throw new TypeError('CDP binding名称不合法');
  }
  let vaultRoot = configuredVaultRoot;
  if (typeof vaultRoot !== 'string' && typeof vaultFileUrlPrefix === 'string') {
    try { vaultRoot = fileURLToPath(new URL(vaultFileUrlPrefix)); } catch { vaultRoot = null; }
  }
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) {
    throw new TypeError('Vault绝对路径不合法');
  }
  const root = JSON.stringify(vaultRoot.replace(/\/+$/u, ''));
  const binding = JSON.stringify(bindingName);
  return `(() => {
    // 仅在Codex主frame注入，子frame及非Codex页面不安装处理器。
    if (window.top !== window || location.protocol !== 'app:') return;
    const stateKey = '__codexObsidianLinkAssistantV1';
    const existing = window[stateKey];
    // CDP会话重连时先撤销旧注入，避免旧binding失效后仍留下按钮。
    if (existing?.active) {
      try { existing.cleanup?.(); } catch {}
    }
    const vaultRoot = ${root};
    const vaultPathBoundary = vaultRoot.endsWith('/') ? vaultRoot : vaultRoot + '/';
    const binding = ${binding};
    // 当前Codex将本地文件引用渲染为带data-prompt-link-href的role=button节点；保留旧版anchor兼容。
    const selector = '[data-local-conversation-final-assistant] [data-prompt-link-href], [data-local-conversation-final-assistant] a[href^="file:"], [data-local-conversation-final-assistant] a[href^="/"]';
    const buttonAttribute = 'data-codex-obsidian-link-assistant-v1';
    const copyButtonAttribute = 'data-codex-obsidian-link-assistant-copy-v1';
    const actionAttribute = 'data-codex-obsidian-link-action-v1';
    const openButtonSelector = '[' + buttonAttribute + ']';
    const copyButtonSelector = '[' + copyButtonAttribute + ']';
    const buttonSelector = openButtonSelector + ', ' + copyButtonSelector;
    // 伪类逐项拼接；直接给逗号分隔的选择器整体追加伪类会漏掉第一个控件。
    const hoverButtonSelector = openButtonSelector + ':hover, ' + copyButtonSelector + ':hover';
    const focusVisibleButtonSelector = openButtonSelector + ':focus-visible, '
      + copyButtonSelector + ':focus-visible';
    const activeButtonSelector = openButtonSelector + ':active, ' + copyButtonSelector + ':active';
    const stylesheetAttribute = 'data-codex-obsidian-link-assistant-style-v1';
    const buttons = new Map();
    const tooltipButtonSets = new Map();
    const tooltipByTarget = new WeakMap();
    let nextTooltipId = 0;
    let observer = null;
    let frame = 0;
    const targetHref = (target) => target.getAttribute('data-prompt-link-href') ?? target.getAttribute('href');
    // 样式只作用于本工具按钮，并随隔离世界清理，避免污染Codex其它控件。
    const stylesheet = document.createElement('style');
    stylesheet.setAttribute(stylesheetAttribute, '');
    stylesheet.textContent = [
      buttonSelector + ' {',
      'display: inline-flex; align-items: center; vertical-align: middle;',
      'margin-inline-start: 0.45em; padding: 0.16em 0.62em;',
      'border: 1px solid rgba(127,127,127,0.34); border-radius: 999px;',
      'color: inherit; background-color: rgba(127,127,127,0.10);',
      'font: inherit; font-size: 0.78em; font-weight: 500; line-height: 1.5;',
      'white-space: nowrap; cursor: pointer; user-select: none;',
      'transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;',
      '}',
      copyButtonSelector + ' {',
      'width: 1.8em; height: 1.8em; padding: 0;',
      'justify-content: center; border-radius: 0.35em; line-height: 1;',
      '}',
      hoverButtonSelector + ' {',
      'background-color: rgba(127,127,127,0.18); border-color: rgba(127,127,127,0.52);',
      '}',
      focusVisibleButtonSelector + ' {',
      'outline: none; border-color: rgba(127,127,127,0.72); background-color: rgba(127,127,127,0.22);',
      '}',
      activeButtonSelector + ' { transform: translateY(1px); }',
      '@media (prefers-reduced-motion: reduce) { ' + buttonSelector + ' { transition: none; } }',
    ].join('');
    (document.head ?? document.documentElement).insertBefore(stylesheet, null);
    const referencePath = (href) => {
      try {
        if (typeof href !== 'string' || /[\\u0000-\\u001f\\u007f]/u.test(href)) return '';
        if (href.startsWith('/')) return href;
        const url = new URL(href, location.href);
        if (url.protocol !== 'file:' || url.host !== '' || url.search) return '';
        return decodeURIComponent(url.pathname);
      } catch {
        return '';
      }
    };
    const eligible = (href) => {
      const absolutePath = referencePath(href);
      const isAbsolutePosixPath = absolutePath.startsWith('/');
      if (!isAbsolutePosixPath || absolutePath === vaultRoot
        || !absolutePath.startsWith(vaultPathBoundary)) return false;
      const relativePath = absolutePath.slice(vaultPathBoundary.length);
      if (!relativePath || relativePath.split('/').some((part) => ['.obsidian', '.git', '.trash'].includes(part))) return false;
      return true;
    };
    const removeButton = (button) => {
      const record = buttons.get(button);
      if (record) button.removeEventListener('click', record.listener);
      const tooltipSet = record?.tooltipToken ? tooltipButtonSets.get(record.tooltipToken) : null;
      tooltipSet?.delete(button);
      if (tooltipSet?.size === 0) tooltipButtonSets.delete(record.tooltipToken);
      buttons.delete(button);
      button.remove();
    };
    // 主进程只把通过真实路径校验的规范URI写入title；回复正文不会包含该URI。
    const setTooltip = (token, uri) => {
      if (typeof token !== 'string' || typeof uri !== 'string' || uri.length > 8192) return false;
      const tooltipSet = tooltipButtonSets.get(token);
      if (!tooltipSet) return false;
      const title = uri.startsWith('obsidian://open?') ? uri : '';
      if (!title) {
        const firstButton = [...tooltipSet][0];
        const targetRecord = firstButton ? buttons.get(firstButton) : null;
        const targetState = targetRecord ? tooltipByTarget.get(targetRecord.target) : null;
        if (targetState?.token === token) targetState.status = 'rejected';
        for (const button of [...tooltipSet]) removeButton(button);
        tooltipButtonSets.delete(token);
        return true;
      }
      const firstButton = [...tooltipSet][0];
      const targetRecord = firstButton ? buttons.get(firstButton) : null;
      const targetState = targetRecord ? tooltipByTarget.get(targetRecord.target) : null;
      if (targetState?.token === token) targetState.status = 'accepted';
      for (const button of tooltipSet) {
        if (button.isConnected) {
          button.title = title;
          button.hidden = false;
          button.disabled = false;
        }
      }
      return true;
    };
    const requestTooltip = (target, controls, href) => {
      const previous = tooltipByTarget.get(target);
      if (previous?.href === href && previous.status === 'rejected') return;
      if (previous?.href === href && previous.controls.length === controls.length
        && previous.controls.every((button, index) => button === controls[index])) return;
      if (previous) tooltipButtonSets.delete(previous.token);
      const token = 'tooltip-' + (++nextTooltipId);
      const tooltipSet = new Set(controls);
      tooltipButtonSets.set(token, tooltipSet);
      tooltipByTarget.set(target, { href, token, controls, status: 'pending' });
      for (const button of tooltipSet) {
        const record = buttons.get(button);
        if (record) record.tooltipToken = token;
        button.title = '';
        button.hidden = true;
        button.disabled = true;
      }
      try { window[binding](JSON.stringify({ action: 'tooltip', href, token })); } catch {}
    };
    const decorate = () => {
      frame = 0;
      // SPA替换回答内容后同步移除孤立按钮和监听器，避免累计旧页面节点。
      for (const [button, record] of buttons) {
        if (!button.isConnected || !record.target.isConnected || !eligible(targetHref(record.target))) {
          removeButton(button);
        }
      }
      for (const target of document.querySelectorAll(selector)) {
        const href = targetHref(target);
        if (!target.isConnected || !eligible(href)) continue;
        const previous = tooltipByTarget.get(target);
        if (previous?.href === href && previous.status === 'rejected') continue;
        const next = target.nextElementSibling;
        if (next?.getAttribute(actionAttribute) === 'open' && next.hasAttribute(buttonAttribute)) {
          let copyButton;
          const copy = next.nextElementSibling;
          if (copy?.getAttribute(actionAttribute) === 'copy' && copy.hasAttribute(copyButtonAttribute)) {
            copyButton = copy;
          } else {
            copyButton = createActionButton(target, 'copy');
            next.parentElement?.insertBefore(copyButton, next.nextSibling);
          }
          requestTooltip(target, [next, copyButton], href);
          continue;
        }
        const openButton = createActionButton(target, 'open');
        const copyButton = createActionButton(target, 'copy');
        const parent = target.parentElement;
        if (!parent) {
          removeButton(openButton);
          removeButton(copyButton);
          continue;
        }
        parent.insertBefore(openButton, target.nextSibling);
        parent.insertBefore(copyButton, openButton.nextSibling);
        requestTooltip(target, [openButton, copyButton], href);
      }
    };
    const createActionButton = (target, action) => {
      const button = document.createElement('button');
      button.type = 'button';
      // worker核实文件存在且位于Vault后，才显示按钮；未确认前保持不可见。
      button.hidden = true;
      button.disabled = true;
      button.textContent = action === 'open' ? '↗ 在 Obsidian 打开' : '⧉';
      button.title = '';
      button.setAttribute('aria-label', action === 'open' ? '在 Obsidian 中打开此笔记' : '复制 Obsidian URI');
      button.setAttribute(actionAttribute, action);
      button.setAttribute(action === 'open' ? buttonAttribute : copyButtonAttribute, '');
      const listener = (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const request = action === 'copy'
            ? { action, href: targetHref(target) }
            : { href: targetHref(target) };
          window[binding](JSON.stringify(request));
        } catch {}
      };
      button.addEventListener('click', listener);
      buttons.set(button, { listener, target, tooltipToken: '' });
      return button;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(decorate);
    };
    const cleanup = () => {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const button of [...buttons.keys()]) removeButton(button);
      stylesheet.remove();
      window.removeEventListener('pagehide', cleanup);
      if (window[stateKey]?.cleanup === cleanup) delete window[stateKey];
    };
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-prompt-link-href'],
    });
    window.addEventListener('pagehide', cleanup, { once: true });
    window[stateKey] = { active: true, cleanup, setTooltip };
    decorate();
  })();`;
}
