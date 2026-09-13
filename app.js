(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(url + ' -> ' + res.status);
    return res.json();
  }

  async function init() {
    try {
      const cfg = await loadJson('config.json');
      const base = cfg.proxyBase.replace(/\/+$/, '');
      const manifest = await loadJson(base + '/manifest.json');

      if (manifest.version) $('version').textContent = 'v' + manifest.version;
      if (manifest.builtAt) {
        $('built').textContent = '(' + new Date(manifest.builtAt).toLocaleDateString('hu-HU') + ')';
      }
    } catch {
      const v = $('version');
      if (v) v.textContent = 'nem elérhető';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
