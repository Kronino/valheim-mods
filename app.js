(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { cfg: null, manifest: null, dir: null };
  const supported = typeof window.showDirectoryPicker === 'function';

  const setStatus = (text, cls) => {
    const el = $('status');
    el.textContent = text;
    el.className = 'status' + (cls ? ' ' + cls : '');
  };
  const setProgress = (done, total) => {
    $('bar').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  };
  const base = () => state.cfg.proxyBase.replace(/\/+$/, '');

  async function sha256Hex(buf) {
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(url + ' -> ' + res.status);
    return res.json();
  }

  // --- remembered folder handle ---------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('valheim-installer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveHandle(handle) {
    try {
      const db = await openDb();
      db.transaction('kv', 'readwrite').objectStore('kv').put(handle, 'dir');
    } catch { /* ignore */ }
  }
  async function loadHandle() {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const req = db.transaction('kv').objectStore('kv').get('dir');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }

  // --- folder validation -----------------------------------------------------
  async function hasEntry(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch { /* no */ }
    try { await dir.getDirectoryHandle(name); return true; } catch { /* no */ }
    return false;
  }
  async function looksLikeValheim(dir) {
    for (const n of ['valheim.exe', 'valheim_Data', 'BepInEx', 'steam_appid.txt']) {
      if (await hasEntry(dir, n)) return true;
    }
    return false;
  }
  async function pickFolder() {
    const dir = await window.showDirectoryPicker({ id: 'valheim', mode: 'readwrite' });
    if (!(await looksLikeValheim(dir))) {
      const ok = confirm(
        'That folder does not look like the Valheim install folder.\n\n' +
        'Expected to find valheim.exe or the valheim_Data folder\n' +
        '(usually ...\\steamapps\\common\\Valheim).\n\nUse it anyway?'
      );
      if (!ok) return null;
    }
    return dir;
  }
  async function ensurePermission(dir) {
    const opts = { mode: 'readwrite' };
    if ((await dir.queryPermission(opts)) === 'granted') return true;
    return (await dir.requestPermission(opts)) === 'granted';
  }

  // --- install ---------------------------------------------------------------
  async function install() {
    const btn = $('install');
    btn.disabled = true;
    try {
      if (!state.dir) {
        state.dir = await pickFolder();
        if (!state.dir) { setStatus('Cancelled.'); return; }
        await saveHandle(state.dir);
      }
      if (!(await ensurePermission(state.dir))) { setStatus('Write permission denied.', 'error'); return; }

      setStatus('Downloading mods...', 'busy');
      const res = await fetch(base() + '/valheim_mods.zip', { cache: 'no-store' });
      if (!res.ok) throw new Error('download failed (' + res.status + ')');
      const zip = new Uint8Array(await res.arrayBuffer());

      if (state.manifest && state.manifest.sha256) {
        setStatus('Verifying checksum...', 'busy');
        if ((await sha256Hex(zip)) !== state.manifest.sha256) throw new Error('checksum mismatch - download may be corrupted');
      }

      setStatus('Unpacking...', 'busy');
      const files = fflate.unzipSync(zip);
      const entries = Object.entries(files).filter(([p]) => !p.endsWith('/'));

      let done = 0;
      for (const [path, data] of entries) {
        const parts = path.split('/');
        const name = parts.pop();
        let dir = state.dir;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
        const fh = await dir.getFileHandle(name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(data);
        await writable.close();
        done++;
        setStatus('Installing ' + done + '/' + entries.length + ' - ' + name, 'busy');
        setProgress(done, entries.length);
      }

      setProgress(1, 1);
      setStatus('All done! Installed v' + (state.manifest ? state.manifest.version : ''), 'ok');
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const hint = /lock|permission|denied|NoModificationAllowed/i.test(msg)
        ? ' - make sure Valheim is closed and you picked the install folder'
        : '';
      setStatus('Error: ' + msg + hint, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // --- boot ------------------------------------------------------------------
  async function init() {
    try {
      state.cfg = await loadJson('config.json');
      $('releases').href = 'https://github.com/' + state.cfg.repo + '/releases';
    } catch {
      setStatus('config.json is missing or invalid.', 'error');
      return;
    }

    if (!supported) {
      setStatus('This browser cannot write to a folder. Use Chrome or Edge.', 'error');
      return;
    }

    try {
      state.manifest = await loadJson(base() + '/manifest.json');
      $('version').textContent = 'v' + state.manifest.version;
      if (state.manifest.builtAt) {
        $('built').textContent = '(' + new Date(state.manifest.builtAt).toLocaleDateString() + ')';
      }
    } catch {
      setStatus('Could not reach the download service. Is the Worker deployed?', 'error');
      return;
    }

    state.dir = await loadHandle();
    const btn = $('install');
    btn.disabled = false;
    btn.addEventListener('click', install);
    setStatus(state.dir ? 'Ready - folder remembered.' : 'Ready.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
