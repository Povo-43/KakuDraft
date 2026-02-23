/* ===================================================================
 *  KakuDraft - app-storage.js
 *  IndexedDB operations, persistence, attachments
 * =================================================================== */

// === IndexedDB Operations ===
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function dbGet(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function dbPut(storeName, value, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = key === undefined ? store.put(value) : store.put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function dbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// === State Persistence ===
async function persistAIChatNow() {
    await dbPut('kv', JSON.stringify(aiChatState || []), AI_CHAT_KEY);
}

async function loadPersistedAIChat() {
    const saved = await dbGet('kv', AI_CHAT_KEY);
    if (!saved) {
        aiChatState = Array.isArray(state.aiChat) ? state.aiChat.slice(-100) : [];
        return;
    }
    try {
        aiChatState = JSON.parse(saved);
        if (!Array.isArray(aiChatState)) aiChatState = [];
        aiChatState = aiChatState.slice(-100);
    } catch { aiChatState = []; }
}

async function persistNow() {
    const tokenPlain = document.getElementById('gh-token')?.value || '';
    state.ghTokenEnc = await encryptPatToken(tokenPlain, state.deviceName);
    state.ghTokenLegacy = '';
    await stashAllProviderKeys();
    await dbPut('kv', JSON.stringify(getStateWithoutAIChat()), STATE_KEY);
    await persistAIChatNow();
}

function queuePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        try { await persistNow(); }
        catch (e) { console.error(e); showToast('保存に失敗しました（再試行してください）', 'error'); }
    }, 60);
}

async function loadPersistedState() {
    const saved = await dbGet('kv', STATE_KEY);
    if (saved) {
        state = normalizeStateShape(JSON.parse(saved));
        return;
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
        state = normalizeStateShape(JSON.parse(legacy));
        await dbPut('kv', JSON.stringify(getStateWithoutAIChat()), STATE_KEY);
        await persistAIChatNow();
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        showToast('旧データを新しい保存形式へ移行しました', 'success');
    }
}

// === Auto-save on browser close ===
function setupAutoSave() {
    document.addEventListener('visibilitychange', autoSaveSync);
    window.addEventListener('pagehide', autoSaveSync);
    window.addEventListener('beforeunload', autoSaveSync);
}

function autoSaveSync() {
    save();
}

async function autoSaveAsync() {
    try {
        const tokenPlain = document.getElementById('gh-token')?.value?.trim();
        if (!tokenPlain || !state.ghRepo) return;
        if (!navigator.onLine) return;
        
        const headers = { Authorization: `Bearer ${tokenPlain}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
        try {
            const userRes = await requestJson('https://api.github.com/user', { headers });
            const parsedRepo = parseRepoTarget(state.ghRepo, userRes.body?.login);
            if (!parsedRepo) return;
            
            // Save snapshot before auto-sync
            const { owner, repo } = parsedRepo;
            await uploadRepoSnapshot(headers, owner, repo, getStateWithoutAIChat(), 'auto-save');
        } catch { }
    } catch { }
}

// === Attachment Storage ===
async function storeAttachmentBlob(file, data) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const attachment = { id, name: file.name, type: file.type, size: file.size, createdAt: Date.now(), data };
    await dbPut('attachments', attachment);
    return id;
}

async function getAttachmentData(ref) {
    if (typeof ref === 'object' && ref.data) return ref.data;
    if (typeof ref === 'string') {
        try { return await dbGet('attachments', ref); } catch { return null; }
    }
    return null;
}

// === Text Backup Files ===
function buildTextBackupFiles() {
    const files = {};
    (state.chapters || []).forEach((ch, idx) => {
        const fileName = `テキスト/${String(idx + 1).padStart(3, '0')}_${sanitizeFileName(ch.title)}.txt`;
        files[fileName] = ch.body || '';
    });
    return files;
}

// === Attachment Index ===
function buildAttachmentIndex() {
    const items = [];
    const processAttachments = (attachments = []) => {
        attachments.forEach(att => {
            items.push({ id: att.id, name: att.name, size: att.size, type: att.type });
        });
    };
    state.chapters.forEach(ch => {
        ch.memos?.forEach(m => processAttachments(m.attachments));
    });
    state.globalMemos?.forEach(m => processAttachments(m.attachments));
    Object.values(state.folderMemos || {}).forEach(bundle => {
        bundle.memos?.forEach(m => processAttachments(m.attachments));
    });
    return { items };
}

// === Snapshots (Local) ===
async function addLocalSnapshot(label, data) {
    const snapshot = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        date: new Date().toISOString(), label, data
    };
    await dbPut('snapshots', snapshot);
}

function takeBodySnapshot(customName) {
    save();
    const chapter = state.chapters[state.currentIdx];
    const label = customName || new Date().toLocaleString('ja-JP');
    chapter.snapshots = chapter.snapshots || [];
    chapter.snapshots.unshift({ label, body: editor.value, timestamp: Date.now() });
    chapter.snapshots = chapter.snapshots.slice(0, 30);
    save();
    showToast('スナップショットを保存しました', 'success');
}

function renderSnapshots() {
    const ch = state.chapters[state.currentIdx];
    const snapshots = ch.snapshots || [];
    const container = document.getElementById('snapshots-container');
    if (!container) return;
    container.innerHTML = snapshots.map((s, i) => `
        <div class="config-item" style="align-items:center;">
            <span style="flex:1; font-size:12px;">${escapeHtml(s.label)} (${s.body?.length || 0}字)</span>
            <button onclick="restoreBody(${i})" style="font-size:14px; padding:4px 8px;">復元</button>
            <button onclick="deleteBodySnapshot(${i})" style="font-size:14px; padding:4px 8px;">削除</button>
        </div>
    `).join('') || '<div class="config-item">スナップショットなし</div>';
}

function restoreBody(i) {
    const ch = state.chapters[state.currentIdx];
    const snapshots = ch.snapshots || [];
    if (!confirm(`「${escapeHtml(snapshots[i].label)}」に戻しますか？`)) return;
    editor.value = snapshots[i].body || '';
    save(); updateStats(); renderMemos(); updateHighlight();
    showToast('スナップショットから復元しました', 'success');
}

function deleteBodySnapshot(i) {
    const ch = state.chapters[state.currentIdx];
    if (!ch.snapshots) return;
    ch.snapshots.splice(i, 1);
    renderSnapshots(); save();
    showToast('スナップショットを削除しました', 'success');
}

// === Font Caching (only used fonts) ===
async function cacheFontAssets(fontValue) {
    const fontConfig = GOOGLE_FONTS_MAP[fontValue];
    if (!fontConfig || !('caches' in window)) return;
    
    try {
        const cache = await caches.open('kakudraft-font-cache-v5');
        const cssUrl = fontConfig.url;
        const cssRes = await fetch(cssUrl);
        await cache.put(cssUrl, cssRes.clone());
        
        const cssText = await cssRes.text();
        const fontUrls = [...cssText.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]);
        for (const url of fontUrls) {
            try { const res = await fetch(url, { mode: 'cors' }); await cache.put(url, res); } catch {}
        }
    } catch { }
}

function updateOnlineFontUI() {
    const sel = document.getElementById('font-family');
    const label = document.getElementById('font-online-label');
    if (!sel || !label) return;
    const on = navigator.onLine;
    sel.disabled = !on;
    label.textContent = on ? 'フォント（オンライン時のみ）' : 'フォント（オフライン中: 変更不可）';
}
