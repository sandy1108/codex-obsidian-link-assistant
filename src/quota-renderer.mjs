/** Codex主frame的独立侧栏组件；离开页面或暂停增强时完整清理。 */
export function buildQuotaRendererSource() {
  return `(() => {
    if (window.top !== window || location.protocol !== 'app:') return;
    const key = '__codexQuotaRingsV1';
    try { window[key]?.cleanup?.(); } catch {}
    const host = document.createElement('div');
    host.setAttribute('data-codex-quota-rings', '');
    host.setAttribute('aria-label', 'Codex剩余额度');
    const style = document.createElement('style');
    style.setAttribute('data-codex-quota-rings-style', '');
    style.textContent = [
      '[data-codex-quota-rings] { flex: 0 0 auto; width: 36px; align-self: center; display: flex; flex-direction: column; align-items: center; gap: 10px; margin: 0 0 38px; }',
      '[data-codex-quota-ring] { position: relative; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; cursor: default; transition: transform 140ms ease; }',
      '[data-codex-quota-ring]:hover { transform: scale(1.08); }',
      '[data-codex-quota-ring]:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }',
      '[data-codex-quota-ring] svg { position: absolute; inset: 0; width: 36px; height: 36px; transform: rotate(-90deg); }',
      '[data-codex-quota-ring] .track { fill: none; stroke: rgba(127,127,127,.22); stroke-width: 3.5; }',
      '[data-codex-quota-ring] .fill { fill: none; stroke: var(--quota-color); stroke-width: 3.5; stroke-linecap: round; transition: stroke-dasharray 240ms ease; }',
      '[data-codex-quota-ring] .value { position: relative; font: 600 8.5px -apple-system, BlinkMacSystemFont, sans-serif; color: var(--color-text-primary, currentColor); letter-spacing: -.3px; }',
      '[data-codex-quota-ring] .badge { position: absolute; bottom: -5px; left: 50%; transform: translateX(-50%); padding: 0 2px; color: var(--quota-color); font: 700 7px -apple-system, BlinkMacSystemFont, sans-serif; }',
      '@media (prefers-color-scheme: dark) { [data-codex-quota-ring="fiveHour"] { --quota-color: #75b3ff !important; } [data-codex-quota-ring="weekly"] { --quota-color: #c39aff !important; } }',
      '@media (prefers-reduced-motion: reduce) { [data-codex-quota-ring], [data-codex-quota-ring] .fill { transition: none; } }',
    ].join('');
    (document.head ?? document.documentElement).append(style);
    const rings = {};
    for (const [keyName, badge, color] of [['fiveHour', '5h', '#4d91df'], ['weekly', '7d', '#986bd3']]) {
      const ring = document.createElement('div');
      ring.setAttribute('data-codex-quota-ring', keyName);
      ring.setAttribute('tabindex', '0');
      ring.style.setProperty('--quota-color', color);
      ring.innerHTML = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="14"/><circle class="fill" cx="18" cy="18" r="14" pathLength="100" stroke-dasharray="0 100"/></svg><span class="value">—</span><span class="badge"></span>';
      ring.querySelector('.badge').textContent = badge;
      host.append(ring);
      rings[keyName] = ring;
    }
    const attach = () => {
      const nav = document.querySelector('nav[aria-label="应用导航"]');
      if (!nav || host.parentElement === nav || nav.children.length < 2) return;
      nav.insertBefore(host, nav.lastElementChild);
    };
    const observer = new MutationObserver(attach);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const formatted = (seconds) => {
      if (!Number.isSafeInteger(seconds) || seconds <= 0) return '未知';
      return new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'long', timeStyle: 'medium', hour12: false,
      }).format(new Date(seconds * 1000));
    };
    const setQuota = (snapshot) => {
      for (const [keyName, name] of [['fiveHour', '5小时额度'], ['weekly', '周额度']]) {
        const ring = rings[keyName];
        const item = snapshot?.[keyName];
        const valid = item && Number.isInteger(item.remainingPercent)
          && item.remainingPercent >= 0 && item.remainingPercent <= 100
          && Number.isSafeInteger(item.resetsAt) && item.resetsAt > 0;
        const percent = valid ? item.remainingPercent : null;
        ring.querySelector('.value').textContent = percent === null ? '—' : percent + '%';
        ring.querySelector('.fill').setAttribute('stroke-dasharray', (percent ?? 0) + ' 100');
        const tip = percent === null ? name + '：暂不可用' : name + '：剩余 ' + percent + '%\\n重置时间：' + formatted(item.resetsAt);
        ring.title = tip;
        ring.setAttribute('aria-label', tip);
      }
    };
    const cleanup = () => {
      observer.disconnect();
      host.remove();
      style.remove();
      window.removeEventListener('pagehide', cleanup);
      if (window[key]?.cleanup === cleanup) delete window[key];
    };
    window.addEventListener('pagehide', cleanup, { once: true });
    window[key] = { cleanup, setQuota };
    attach();
    setQuota(null);
  })();`;
}
