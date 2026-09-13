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

  // --- megjegyzett mappahivatkozás (folder handle) ---------------------------
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

  // --- mappa ellenőrzése ------------------------------------------------------
  async function hasEntry(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch { /* nincs */ }
    try { await dir.getDirectoryHandle(name); return true; } catch { /* nincs */ }
    return false;
  }
  async function looksLikeValheim(dir) {
    for (const n of ['valheim.exe', 'valheim_Data', 'BepInEx', 'steam_appid.txt']) {
      if (await hasEntry(dir, n)) return true;
    }
    return false;
  }
  const VERSION_FILE = '.valheim-mods.version';
  async function readInstalledVersion(dir) {
    try {
      const bep = await dir.getDirectoryHandle('BepInEx');
      const fh = await bep.getFileHandle(VERSION_FILE);
      const file = await fh.getFile();
      return (await file.text()).trim();
    } catch { return null; }
  }
  async function writeInstalledVersion(dir, version) {
    if (!version) return;
    try {
      const bep = await dir.getDirectoryHandle('BepInEx', { create: true });
      const fh = await bep.getFileHandle(VERSION_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(version);
      await w.close();
    } catch { /* ignore */ }
  }

  async function pickFolder() {
    setStatus('Válaszd ki a Valheim mappát (ahol a Valheim.exe van)');
    const dir = await window.showDirectoryPicker({ id: 'valheim', mode: 'readwrite' });
    if (!(await looksLikeValheim(dir))) {
      const ok = confirm(
        'Ez a mappa nem úgy tűnik, mint a Valheim telepítési mappája.\n\n' +
        'Itt a valheim.exe fájlnak vagy a valheim_Data mappának kellene lennie\n' +
        '(általában ...\\steamapps\\common\\Valheim).\n\nMégis ezt használod?'
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

  // --- telepítés --------------------------------------------------------------
  async function install() {
    const btn = $('install');
    btn.disabled = true;
    try {
      if (!state.dir) {
        state.dir = await pickFolder();
        if (!state.dir) { setStatus('Megszakítva.'); return; }
        await saveHandle(state.dir);
      }
      if (!(await ensurePermission(state.dir))) { setStatus('Nincs írási engedély.', 'error'); return; }

      const installedVersion = await readInstalledVersion(state.dir);

      setStatus('Modok letöltése...', 'busy');
      const res = await fetch(base() + '/valheim_mods.zip', { cache: 'no-store' });
      if (!res.ok) throw new Error('a letöltés sikertelen (' + res.status + ')');
      const zip = new Uint8Array(await res.arrayBuffer());

      if (state.manifest && state.manifest.sha256) {
        setStatus('Ellenőrzés folyamatban...', 'busy');
        if ((await sha256Hex(zip)) !== state.manifest.sha256) throw new Error('az ellenőrzőösszeg nem egyezik – a letöltés sérült lehet');
      }

      setStatus('Kicsomagolás...', 'busy');
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
        setStatus('Telepítés: ' + done + '/' + entries.length + ' – ' + name, 'busy');
        setProgress(done, entries.length);
      }

      setProgress(1, 1);
      const version = state.manifest ? state.manifest.version : '';
      await writeInstalledVersion(state.dir, version);
      if (installedVersion && version && installedVersion === version) {
        setStatus('Nincs új verzió – már a legújabb (v' + version + ') van telepítve.', 'ok');
      } else if (installedVersion && version) {
        setStatus('Frissítve: v' + installedVersion + ' → v' + version, 'ok');
      } else {
        setStatus('Kész! Telepítve: v' + version, 'ok');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') { setStatus('Megszakítva.'); return; }
      const msg = String(err && err.message ? err.message : err);
      const hint = /lock|permission|denied|NoModificationAllowed/i.test(msg)
        ? ' – ellenőrizd, hogy a Valheim be van-e zárva, és a megfelelő mappát választottad-e ki'
        : '';
      setStatus('Hiba: ' + msg + hint, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // --- indítás ----------------------------------------------------------------
  async function init() {
    try {
      state.cfg = await loadJson('config.json');
      $('releases').href = 'https://github.com/' + state.cfg.repo + '/releases';
    } catch {
      setStatus('A config.json hiányzik vagy hibás.', 'error');
      return;
    }

    if (!supported) {
      setStatus('Ez a böngésző nem tud mappába írni. Használj Chrome-ot vagy Edge-et.', 'error');
      return;
    }

    try {
      state.manifest = await loadJson(base() + '/manifest.json');
      $('version').textContent = 'v' + state.manifest.version;
      if (state.manifest.builtAt) {
        $('built').textContent = '(' + new Date(state.manifest.builtAt).toLocaleDateString('hu-HU') + ')';
      }
    } catch {
      setStatus('A letöltési szolgáltatás nem érhető el. Fut a Worker?', 'error');
      return;
    }

    state.dir = await loadHandle();
    const btn = $('install');
    btn.disabled = false;
    btn.addEventListener('click', install);
    setStatus(state.dir ? 'Kész – a mappa megjegyezve.' : 'Kész.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
