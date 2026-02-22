    const editor = document.getElementById('editor'); const memoArea = document.getElementById('memo-area'); const hl = document.getElementById('line-highlight');
    const DB_NAME = 'kakudraft-db';
    const DB_VERSION = 1;
    const STATE_KEY = 'app-state';
    const LEGACY_STORAGE_KEY = 'kaku_v_pro_sync';
    const REPO_DATA_PATH = 'kakudraft_data.json';
    const toastEl = document.getElementById('toast');
    let syncTimer;
    let toastTimer;
    let persistTimer;

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js', { scope: './' });
        });
    }

    let state = { chapters: [{ title: "第一話", body: "", memos: [{name: "メモ", content: "", attachments: []}], currentMemoIdx: 0, snapshots: [] }], currentIdx: 0, globalMemos: [{name: "共通設定", content: "", attachments: []}], currentGlobalMemoIdx: 0, memoScope: 'local', replaceRules: [{from: "!!", to: "！！"}], insertButtons: [{label: "ルビ", value: "|《》"}, {label: "強調", value: "《》"}, {label: "「", value: "「"}], fontSize: 18, theme: "light", ghTokenEnc: "", ghTokenLegacy: "", ghRepo: "", deviceName: "", menuTab: 'favorites', favoriteActionKeys: ['sync-up','take-snapshot','toggle-theme'], fontFamily: "'Sawarabi Mincho', serif", writingSessions: [], folders:[{id:'root',name:'既定'}], currentFolderId:'all', folderMemos:{root:{memos:[{name:'フォルダーメモ',content:'',attachments:[]}], currentMemoIdx:0}}, favoriteEditMode:false, keepScreenOn:false, aiProvider:'openrouter', aiKeyEnc:'', aiModel:'', aiChat:[] };

    function showToast(message, type = 'info') {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.className = `${type ? type + ' ' : ''}show`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.className = '';
        }, 2800);
    }

    function closePanels() {
        document.querySelectorAll('.side-panel').forEach(el => el.classList.remove('open'));
    }

    function sanitizeFileName(name) {
        return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_');
    }

    function createUtf8TextBlob(text) {
        return new Blob(['﻿', text || ''], { type: 'text/plain;charset=utf-8' });
    }

    function createUtf8BytesWithBom(text) {
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const body = new TextEncoder().encode(text || '');
        const bytes = new Uint8Array(bom.length + body.length);
        bytes.set(bom, 0);
        bytes.set(body, bom.length);
        return bytes;
    }

    function triggerDownload(blob, filename) {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function getSelectedChapterIndexes() {
        return state.chapters.map((_, i) => i).filter((i) => {
            const checkbox = document.getElementById(`download-target-${i}`);
            return checkbox && checkbox.checked;
        });
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
                if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
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

    async function addLocalSnapshot(label, data) {
        const snapshot = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            date: new Date().toISOString(),
            label,
            data
        };
        await dbPut('snapshots', snapshot);
    }

    async function deriveTokenKey(deviceName) {
        const secret = `kakudraft-lite-secret::${location.origin}::${deviceName || 'default-device'}`;
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
        return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }

    async function encryptPatToken(token, deviceName) {
        if (!token || !window.crypto?.subtle) return '';
        const key = await deriveTokenKey(deviceName);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
        const payload = {
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted))
        };
        return btoa(JSON.stringify(payload));
    }

    async function decryptPatToken(payloadB64, deviceName) {
        if (!payloadB64 || !window.crypto?.subtle) return '';
        try {
            const payload = JSON.parse(atob(payloadB64));
            const key = await deriveTokenKey(deviceName);
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
                key,
                new Uint8Array(payload.data)
            );
            return new TextDecoder().decode(decrypted);
        } catch {
            return '';
        }
    }

    function parseRepoTarget(rawRepo, fallbackOwner) {
        const cleaned = (rawRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
        if (!cleaned) return null;
        if (cleaned.includes('/')) {
            const [owner, repo] = cleaned.split('/');
            return owner && repo ? { owner, repo } : null;
        }
        return fallbackOwner ? { owner: fallbackOwner, repo: cleaned } : null;
    }

    async function requestJson(url, options = {}) {
        const res = await fetch(url, options);
        let body;
        try { body = await res.json(); } catch { body = null; }
        return { res, body };
    }

    function normalizeStateShape(raw) {
        const next = Object.assign({}, state, raw || {});
        next.chapters = (next.chapters || []).map((ch, idx) => ({
            title: ch.title || `第${idx + 1}話`,
            body: ch.body || '',
            memos: (ch.memos && ch.memos.length ? ch.memos : [{name:'メモ', content:''}]).map((m)=>({name:m.name||'メモ', content:m.content||'', attachments:m.attachments||[]})),
            currentMemoIdx: Number.isInteger(ch.currentMemoIdx) ? ch.currentMemoIdx : 0,
            snapshots: ch.snapshots || [],
            folderId: ch.folderId || 'root'
        }));
        if (!next.chapters.length) next.chapters = [{title:'第一話', body:'', memos:[{name:'メモ', content:''}], currentMemoIdx:0, snapshots:[], folderId:'root'}];
        next.folders = next.folders && next.folders.length ? next.folders : [{id:'root',name:'既定'}];
        if (!next.folders.some((f) => f.id === 'root')) next.folders.unshift({id:'root',name:'既定'});
        next.currentFolderId = next.currentFolderId || 'all';
        next.globalMemos = (next.globalMemos && next.globalMemos.length ? next.globalMemos : [{name:'共通設定', content:'', attachments:[]}]).map((m)=>({name:m.name||'共通設定', content:m.content||'', attachments:m.attachments||[]}));
        Object.keys(next.folderMemos).forEach((k)=>{
            const bundle = next.folderMemos[k] || { memos:[{name:'フォルダーメモ',content:'',attachments:[]}], currentMemoIdx:0 };
            bundle.memos = (bundle.memos && bundle.memos.length ? bundle.memos : [{name:'フォルダーメモ',content:'',attachments:[]}]).map((m)=>({name:m.name||'フォルダーメモ', content:m.content||'', attachments:m.attachments||[]}));
            if (!Number.isInteger(bundle.currentMemoIdx)) bundle.currentMemoIdx = 0;
            next.folderMemos[k] = bundle;
        });
        next.chapters.forEach((ch) => {
            if (!next.folders.some((f) => f.id === ch.folderId)) ch.folderId = 'root';
        });
        return next;
    }

    async function persistNow() {
        const tokenPlain = document.getElementById('gh-token').value || '';
        state.ghTokenEnc = await encryptPatToken(tokenPlain, state.deviceName);
        state.ghTokenLegacy = '';
        const aiKeyPlain = document.getElementById('ai-api-key')?.value || '';
        state.aiKeyEnc = await encryptPatToken(aiKeyPlain, state.deviceName);
        await dbPut('kv', JSON.stringify(state), STATE_KEY);
    }

    function queuePersist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(async () => {
            try {
                await persistNow();
            } catch (e) {
                console.error(e);
                showToast('保存に失敗しました（再試行してください）', 'error');
            }
        }, 60);
    }

    async function loadPersistedState() {
        const saved = await dbGet('kv', STATE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            state = normalizeStateShape(parsed);
            return;
        }
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
            const parsed = JSON.parse(legacy);
            state = normalizeStateShape(parsed);
            await dbPut('kv', JSON.stringify(state), STATE_KEY);
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            showToast('旧データを新しい保存形式へ移行しました', 'success');
        }
    }

    window.onload = async () => {
        await loadPersistedState();
        let token = await decryptPatToken(state.ghTokenEnc, state.deviceName);
        if (!token && state.ghToken) {
            try { token = decodeURIComponent(escape(atob(state.ghToken))); } catch { token = ''; }
        }
        document.getElementById('gh-token').value = token;
        const aiKey = await decryptPatToken(state.aiKeyEnc, state.deviceName);
        document.getElementById('ai-api-key').value = aiKey || '';
        document.getElementById('ai-provider').value = state.aiProvider || 'openrouter';
        onAIProviderChange();
        if (state.aiModel) document.getElementById('ai-model').innerHTML = `<option value=\"${state.aiModel}\">${state.aiModel}</option>`;
        document.getElementById('gh-repo').value = state.ghRepo || "";
        document.getElementById('device-name').value = state.deviceName || "";
        document.body.setAttribute('data-theme', state.theme);
        document.documentElement.style.setProperty('--editor-size', state.fontSize + 'px');
        const fontSel = document.getElementById('font-family');
        if (fontSel) fontSel.value = state.fontFamily || "'Sawarabi Mincho', serif";
        document.documentElement.style.setProperty('--writing-font', state.fontFamily || "'Sawarabi Mincho', serif");
        const wl = document.getElementById('wakelock-toggle'); if (wl) wl.checked = !!state.keepScreenOn;
        updateOnlineFontUI();
        if (state.keepScreenOn) toggleWakeLock(true);
        refreshUI(); loadChapter(state.currentIdx);
    };

    function save() {
        state.chapters[state.currentIdx].body = editor.value;
        const targetMemos = state.memoScope === 'local' ? state.chapters[state.currentIdx].memos : state.memoScope === 'folder' ? getCurrentFolderMemoBundle().memos : state.globalMemos;
        const targetIdx = state.memoScope === 'local' ? state.chapters[state.currentIdx].currentMemoIdx : state.memoScope === 'folder' ? getCurrentFolderMemoBundle().currentMemoIdx : state.currentGlobalMemoIdx;
        if(targetMemos[targetIdx]) targetMemos[targetIdx].content = memoArea.value;
        state.ghRepo = document.getElementById('gh-repo').value.trim();
        state.deviceName = document.getElementById('device-name').value.trim();
        state.aiProvider = document.getElementById('ai-provider')?.value || state.aiProvider || 'openrouter';
        state.aiModel = document.getElementById('ai-model')?.value || state.aiModel || '';
        const ff = document.getElementById('folder-filter');
        if (ff) state.currentFolderId = ff.value || 'all';
        queuePersist();
        updateStats();
    }

    async function uploadRepoSnapshot(headers, owner, repo, currentState, reason) {
        const snapshotPath = `kakudraft_snapshots/${new Date().toISOString().replace(/[:.]/g, '-')}_${sanitizeFileName(state.deviceName || 'device')}_${reason}.json`;
        const bytes = new TextEncoder().encode(JSON.stringify(currentState));
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        const content = btoa(binary);
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${snapshotPath}`;
        await fetch(apiUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ message: `snapshot: ${reason}`, content })
        });
    }

    async function githubSync(mode) {
        save();

        const token = document.getElementById('gh-token').value.trim();
        const repoInput = state.ghRepo;

        if (!token || !repoInput) {
            showToast('GitHub設定（PAT / リポジトリ）を入力してください', 'error');
            return;
        }

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json"
        };

        try {
            const userRes = await requestJson("https://api.github.com/user", { headers });
            if (!userRes.res.ok && !repoInput.includes('/')) {
                throw new Error('ユーザー情報の取得に失敗しました。owner/repo形式で入力してください。');
            }

            const fallbackOwner = userRes.body?.login;
            const parsedRepo = parseRepoTarget(repoInput, fallbackOwner);
            if (!parsedRepo) throw new Error('リポジトリ形式が不正です（例: owner/repo または repo）。');

            const { owner, repo } = parsedRepo;
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${REPO_DATA_PATH}`;

            let sha = null;
            let remoteData = null;

            const getRes = await requestJson(apiUrl, { headers });
            if (getRes.res.status === 200) {
                sha = getRes.body.sha;
                const cleaned = getRes.body.content.replace(/\n/g, "");
                const binary = atob(cleaned);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
                remoteData = JSON.parse(new TextDecoder().decode(bytes));
            } else if (getRes.res.status !== 404) {
                throw new Error(getRes.body?.message || `取得失敗: ${getRes.res.status}`);
            }

            if (mode === "up") {
                const jsonStr = JSON.stringify(state);
                const bytes = new TextEncoder().encode(jsonStr);
                let binary = "";
                const chunkSize = 0x8000;
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    const chunk = bytes.subarray(i, i + chunkSize);
                    binary += String.fromCharCode(...chunk);
                }
                const content = btoa(binary);

                const body = { message: `Sync from ${state.deviceName || "Unknown"}`, content };
                if (sha) body.sha = sha;

                const putRes = await requestJson(apiUrl, { method: "PUT", headers, body: JSON.stringify(body) });
                if (!putRes.res.ok) throw new Error(putRes.body?.message || "アップロード失敗");

                showToast('アップロード成功', 'success');
            } else {
                if (!remoteData) {
                    showToast('リモートにデータがありません。先にUPしてください。', 'error');
                    return;
                }

                if (!confirm("リモートデータで復元しますか？")) return;

                await addLocalSnapshot('before-download-local', structuredClone(state));
                uploadRepoSnapshot(headers, owner, repo, structuredClone(state), 'before-download').catch(() => {});

                const oldTokenEnc = state.ghTokenEnc;
                const oldRepo = state.ghRepo;
                const oldDevice = state.deviceName;

                state = normalizeStateShape(remoteData);
                state.ghTokenEnc = oldTokenEnc;
                state.ghRepo = oldRepo;
                state.deviceName = oldDevice;

                await addLocalSnapshot('after-download-remote', structuredClone(state));
                await persistNow();
                showToast('復元完了（ローカル/リポジトリへスナップショット保存）', 'success');
                setTimeout(() => location.reload(), 500);
            }
        } catch (err) {
            console.error(err);
            showToast(`GitHub同期エラー: ${err.message}`, 'error');
        }
    }

    function execReplace() {
        const val = editor.value; const cursor = editor.selectionStart;
        state.replaceRules.forEach(rule => {
            if (val.slice(cursor - rule.from.length, cursor) === rule.from) {
                editor.value = val.slice(0, cursor - rule.from.length) + rule.to + val.slice(cursor);
                editor.selectionStart = editor.selectionEnd = cursor - rule.from.length + rule.to.length;
            }
        });
    }
    editor.addEventListener('input', (e) => { if (!e.isComposing) execReplace(); });
    let highlightMirror = null;
    let highlightMarker = null;

    function ensureHighlightMirror() {
        if (highlightMirror) return highlightMirror;
        highlightMirror = document.createElement('div');
        highlightMarker = document.createElement('span');
        highlightMirror.appendChild(highlightMarker);
        highlightMirror.setAttribute('aria-hidden', 'true');
        highlightMirror.style.position = 'absolute';
        highlightMirror.style.top = '0';
        highlightMirror.style.left = '-9999px';
        highlightMirror.style.visibility = 'hidden';
        highlightMirror.style.pointerEvents = 'none';
        highlightMirror.style.whiteSpace = 'pre-wrap';
        highlightMirror.style.wordBreak = 'break-word';
        highlightMirror.style.overflowWrap = 'anywhere';
        document.getElementById('editor-container').appendChild(highlightMirror);
        return highlightMirror;
    }

    function updateHighlight() {
        const style = getComputedStyle(editor);
        const mirror = ensureHighlightMirror();
        ['fontSize','fontFamily','fontWeight','fontStyle','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','boxSizing','textIndent'].forEach((prop) => {
            mirror.style[prop] = style[prop];
        });
        mirror.style.width = `${editor.clientWidth}px`;
        mirror.textContent = editor.value.substring(0, editor.selectionStart);
        highlightMarker.textContent = editor.value.substring(editor.selectionStart, editor.selectionStart + 1) || '　';
        mirror.appendChild(highlightMarker);

        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.7;
        const rawTop = highlightMarker.offsetTop - editor.scrollTop;
        const top = Math.max(0, Math.round(rawTop));
        hl.style.display = 'block';
        hl.style.height = `${lineHeight}px`;
        hl.style.top = `${top}px`;
    }

    ['scroll','click','keyup','focus','input'].forEach(ev => editor.addEventListener(ev, updateHighlight));
    function loadChapter(i) { editor.value = state.chapters[i].body; editor.scrollTop = 0; updateStats(); renderMemos(); updateHighlight(); }
    function switchChapter(i) { const idx = Number(i); if (Number.isNaN(idx) || idx < 0 || idx >= state.chapters.length) return; save(); state.currentIdx = idx; refreshUI(); loadChapter(idx); showToast(`「${state.chapters[idx].title}」へ切替`, 'success'); }
    function takeBodySnapshot(customName) {
        const name = customName || new Date().toLocaleTimeString();
        if(!state.chapters[state.currentIdx].snapshots) state.chapters[state.currentIdx].snapshots = [];
        state.chapters[state.currentIdx].snapshots.unshift({ date: name, body: editor.value });
        renderSnapshots(); save();
        showToast('スナップショットを保存しました', 'success');
    }
    function renderSnapshots() {
        const snaps = state.chapters[state.currentIdx].snapshots || [];
        document.getElementById('snapshot-list').innerHTML = snaps.map((s, i) => `<div class="config-item"><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s.date}</span><button onclick="restoreBody(${i})">復元</button></div>`).join('');
    }
    function restoreBody(i) { if(confirm("本文を復元しますか？")) { editor.value = state.chapters[state.currentIdx].snapshots[i].body; save(); updateHighlight(); } }
    function switchMemoScope(scope) { save(); state.memoScope = scope; renderMemos(); }
    function renameMemo(i) {
        const target = state.memoScope === 'local' ? state.chapters[state.currentIdx].memos : state.memoScope === 'folder' ? getCurrentFolderMemoBundle().memos : state.globalMemos;
        const name = prompt('メモタイトル', target[i].name);
        if (!name) return;
        target[i].name = name.trim();
        renderMemos(); save();
    }
    function moveMemo(i, delta) {
        const target = state.memoScope === 'local' ? state.chapters[state.currentIdx].memos : state.memoScope === 'folder' ? getCurrentFolderMemoBundle().memos : state.globalMemos;
        const ni = i + delta;
        if (ni < 0 || ni >= target.length) return;
        [target[i], target[ni]] = [target[ni], target[i]];
        if (state.memoScope === 'local') state.chapters[state.currentIdx].currentMemoIdx = ni;
        else state.currentGlobalMemoIdx = ni;
        renderMemos(); save();
    }
    function renderMemos() {
        const m = state.memoScope === 'local' ? (state.chapters[state.currentIdx].memos || []) : state.memoScope === 'folder' ? (getCurrentFolderMemoBundle().memos || []) : (state.globalMemos || []);
        const a = state.memoScope === 'local' ? state.chapters[state.currentIdx].currentMemoIdx : state.memoScope === 'folder' ? getCurrentFolderMemoBundle().currentMemoIdx : state.currentGlobalMemoIdx;
        document.getElementById('memo-tabs').innerHTML = m.map((x, i) => `
            <div class="tab ${i === a ? 'active' : ''}" style="display:flex; align-items:center; gap:5px;">
                <span style="flex:1; cursor:pointer;" onclick="switchMemo(${i})">${x.name}</span>
                <span class="material-icons" style="font-size:16px; cursor:pointer;" onclick="renameMemo(${i})">edit</span>
                <span class="material-icons" style="font-size:16px; cursor:pointer;" onclick="moveMemo(${i}, -1)">arrow_upward</span>
                <span class="material-icons" style="font-size:16px; cursor:pointer;" onclick="moveMemo(${i}, 1)">arrow_downward</span>
                <span class="material-icons" style="font-size:16px; cursor:pointer;" onclick="deleteMemo(${i})">close</span>
            </div>
        `).join('');

        memoArea.value = m[a] ? m[a].content : "";
        renderMemoAttachments();
        document.getElementById('scope-local').style.opacity = state.memoScope === 'local' ? '1' : '0.5';
        document.getElementById('scope-folder').style.opacity = state.memoScope === 'folder' ? '1' : '0.5';
        document.getElementById('scope-global').style.opacity = state.memoScope === 'global' ? '1' : '0.5';
    }
    function deleteMemo(i) {
        const target = state.memoScope === 'local'
            ? state.chapters[state.currentIdx].memos
            : state.memoScope === 'folder'
                ? getCurrentFolderMemoBundle().memos
                : state.globalMemos;
        if (target.length <= 1) {
            showToast("最低1つは必要です。", "error");
            return;
        }
        if (!confirm("このメモを削除しますか？")) return;
        target.splice(i, 1);
        if (state.memoScope === 'local') {
            if (state.chapters[state.currentIdx].currentMemoIdx >= target.length) state.chapters[state.currentIdx].currentMemoIdx = target.length - 1;
        } else if (state.memoScope === 'folder') {
            const bundle = getCurrentFolderMemoBundle();
            if (bundle.currentMemoIdx >= target.length) bundle.currentMemoIdx = target.length - 1;
        } else {
            if (state.currentGlobalMemoIdx >= target.length) state.currentGlobalMemoIdx = target.length - 1;
        }
        renderMemos();
        save();
    }
    function switchMemo(i) { save(); if(state.memoScope === 'local') state.chapters[state.currentIdx].currentMemoIdx = i; else if (state.memoScope === 'folder') getCurrentFolderMemoBundle().currentMemoIdx = i; else state.currentGlobalMemoIdx = i; renderMemos(); }
    function addMemoTab() {
        const name = document.getElementById('new-memo-name').value.trim() || "無題";
        const target = state.memoScope === 'local' ? state.chapters[state.currentIdx].memos : state.memoScope === 'folder' ? getCurrentFolderMemoBundle().memos : state.globalMemos;
        target.push({name, content: "", attachments: []}); document.getElementById('new-memo-name').value = ""; renderMemos(); save();
    }
    function moveChapter(i, delta) {
        const ni = i + delta;
        if (ni < 0 || ni >= state.chapters.length) return;
        [state.chapters[i], state.chapters[ni]] = [state.chapters[ni], state.chapters[i]];
        if (state.currentIdx === i) state.currentIdx = ni;
        else if (state.currentIdx === ni) state.currentIdx = i;
        refreshUI(); save();
    }
    function cycleChapterFolder(i) {
        const idx = state.folders.findIndex((f) => f.id === (state.chapters[i].folderId || 'root'));
        const next = state.folders[(idx + 1) % state.folders.length];
        state.chapters[i].folderId = next.id;
        refreshUI(); save();
    }
    function renameChapter(i) {
        const next = prompt('話タイトル', state.chapters[i].title);
        if (!next) return;
        state.chapters[i].title = next.trim();
        refreshUI(); save();
    }
    var favoriteActionDefs = {
        'sync-up': { label: 'GitHub UP', run: () => githubSync('up') },
        'sync-down': { label: 'GitHub DOWN', run: () => githubSync('down') },
        'take-snapshot': { label: '本文スナップショット', run: () => takeBodySnapshot() },
        'toggle-theme': { label: 'テーマ切替', run: () => toggleTheme() },
        'split': { label: '話を分割', run: () => splitChapter() },
        'merge': { label: '話を統合', run: () => mergeChapter() },
        'show-search': { label: '検索&置換を開く', run: () => toggleSearchPanel(true) },
        'export-json': { label: 'JSON出力', run: () => exportFullData() },
        'open-chapter-tab': { label: '話管理タブを開く', run: () => switchMenuTab('chapters') },
        'open-analytics-tab': { label: '統計タブを開く', run: () => switchMenuTab('analytics') },
        'next-chapter': { label: '次の話へ', run: () => switchChapter(Math.min(state.currentIdx + 1, state.chapters.length - 1)) },
        'prev-chapter': { label: '前の話へ', run: () => switchChapter(Math.max(state.currentIdx - 1, 0)) },
        'refresh-analytics': { label: '統計更新', run: () => renderAnalytics() },
        'widget-chapter-list': { label: 'お気に入りに話一覧を表示', run: () => switchMenuTab('favorites') },
        'widget-analytics': { label: 'お気に入りに統計表示', run: () => switchMenuTab('favorites') },
        'open-settings-tab': { label: '設定タブを開く', run: () => switchMenuTab('settings') },
        'open-backup-tab': { label: 'バックアップタブを開く', run: () => switchMenuTab('backup') },
        'open-ai-tab': { label: 'AIタブを開く', run: () => togglePanel('ai-panel') }
    };
    function switchMenuTab(tab) {
        state.menuTab = tab;
        document.querySelectorAll('#menu-tabs .tab').forEach((el) => {
            el.classList.toggle('active', el.dataset.tab === tab);
        });
        ['favorites','chapters','settings','backup','analytics'].forEach((name) => {
            document.getElementById(`menu-tab-${name}`).style.display = name === tab ? 'block' : 'none';
        });
        queuePersist();
    }
    function renderFavorites() {
        const selected = new Set(state.favoriteActionKeys || []);
        document.getElementById('favorite-selector').innerHTML = Object.entries(favoriteActionDefs).map(([key, def]) => `
            <label class="config-item"><input type="checkbox" ${selected.has(key) ? 'checked' : ''} onchange="toggleFavoriteAction('${key}', this.checked)"><span>${def.label}</span></label>
        `).join('');
        const actions = (state.favoriteActionKeys || []).filter((k) => favoriteActionDefs[k]);
        let actionsHtml = actions.filter((k)=>!k.startsWith('widget-')).map((k) => `<button class=\"sys-btn\" onclick=\"favoriteActionDefs['${k}'].run()\">${favoriteActionDefs[k].label}</button>`).join('');
        if (actions.includes('widget-chapter-list')) {
            const visible = getVisibleChapterIndexes();
            actionsHtml += `<div class=\"config-list\">${visible.map((i)=>`<div class=\"config-item\"><button style=\"flex:1;text-align:left;background:transparent;border:none;color:var(--text);cursor:pointer;\" onclick=\"switchChapter(${i})\">${state.chapters[i].title}</button></div>`).join('')}</div>`;
        }
        if (actions.includes('widget-analytics')) {
            const stat = document.getElementById('session-stats')?.innerHTML || '';
            const top = document.getElementById('top-words')?.innerHTML || '';
            actionsHtml += `<div class=\"config-list\">${stat}${top}</div>`;
        }
        document.getElementById('favorite-actions').innerHTML = actionsHtml || '<div class="config-item">機能を選んでください</div>';
        document.getElementById('favorite-order-list').innerHTML = actions.map((k, i) => `<div class="config-item"><span style="flex:1">${favoriteActionDefs[k].label}</span><button onclick="moveFavoriteAction(${i},-1)"><span class='material-icons' style='font-size:16px;'>arrow_upward</span></button><button onclick="moveFavoriteAction(${i},1)"><span class='material-icons' style='font-size:16px;'>arrow_downward</span></button></div>`).join('') || '<div class="config-item">順序設定対象なし</div>';
    }
    function toggleFavoriteAction(key, checked) {
        const list = state.favoriteActionKeys || [];
        if (checked) {
            if (!list.includes(key)) list.push(key);
        } else {
            state.favoriteActionKeys = list.filter((x) => x !== key);
        }
        if (checked) state.favoriteActionKeys = list;
        renderFavorites(); save();
    }
    function moveFavoriteAction(i, delta) {
        const list = state.favoriteActionKeys || [];
        const ni = i + delta;
        if (ni < 0 || ni >= list.length) return;
        [list[i], list[ni]] = [list[ni], list[i]];
        state.favoriteActionKeys = list;
        renderFavorites(); save();
    }
    function toggleFavoriteEditMode() { state.favoriteEditMode = !state.favoriteEditMode; refreshUI(); save(); }
    async function changeFontFamily(fontValue) {
        if (!navigator.onLine) {
            showToast('フォント変更はオンライン時のみ利用できます。', 'error');
            return;
        }
        state.fontFamily = fontValue;
        document.documentElement.style.setProperty('--writing-font', fontValue);
        save();
        await cacheFontAssets(fontValue);
        showToast('フォントを変更しました（オフライン用キャッシュを試行）', 'success');
    }
    async function cacheFontAssets(fontValue) {
        const map = {
            "'Noto Serif JP', serif": 'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&display=swap',
            "'Noto Sans JP', sans-serif": 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap',
            "'M PLUS 1p', sans-serif": 'https://fonts.googleapis.com/css2?family=M+PLUS+1p:wght@400;700&display=swap',
            "'Sawarabi Mincho', serif": 'https://fonts.googleapis.com/css2?family=Sawarabi+Mincho&display=swap'
        };
        const cssUrl = map[fontValue];
        if (!cssUrl || !('caches' in window)) return;
        const cache = await caches.open('kakudraft-font-cache-v1');
        const cssRes = await fetch(cssUrl);
        await cache.put(cssUrl, cssRes.clone());
        const cssText = await cssRes.text();
        const fontUrls = [...cssText.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
        for (const url of fontUrls) {
            try {
                const res = await fetch(url, { mode: 'cors' });
                await cache.put(url, res);
            } catch {}
        }
    }
    function updateOnlineFontUI() {
        const sel = document.getElementById('font-family');
        const label = document.getElementById('font-online-label');
        if (!sel || !label) return;
        const on = navigator.onLine;
        sel.disabled = !on;
        label.textContent = on ? 'フォント（オンライン時のみ）' : 'フォント（オフライン中: 変更不可）';
    }
    window.addEventListener('online', updateOnlineFontUI);
    window.addEventListener('offline', updateOnlineFontUI);

    let wakeLockHandle = null;
    async function toggleWakeLock(on) {
        state.keepScreenOn = !!on;
        try {
            if (!('wakeLock' in navigator)) throw new Error('未対応ブラウザ');
            if (on) {
                wakeLockHandle = await navigator.wakeLock.request('screen');
                wakeLockHandle.addEventListener('release', () => { if (state.keepScreenOn) showToast('画面消灯阻止が解除されました', 'error'); });
                showToast('画面消灯阻止をONにしました', 'success');
            } else if (wakeLockHandle) {
                await wakeLockHandle.release();
                wakeLockHandle = null;
                showToast('画面消灯阻止をOFFにしました', 'success');
            }
        } catch (e) {
            state.keepScreenOn = false;
            const wl = document.getElementById('wakelock-toggle'); if (wl) wl.checked = false;
            showToast(`画面消灯阻止を有効化できません: ${e.message}`, 'error');
        }
        queuePersist();
    }

    function getVisibleChapterIndexes() {
        const fid = state.currentFolderId || 'all';
        return state.chapters.map((_,i)=>i).filter((i)=> fid === 'all' || state.chapters[i].folderId === fid);
    }
    function renderFolderFilter() {
        const sel = document.getElementById('folder-filter');
        if (!sel) return;
        const options = [`<option value="all">すべてのフォルダー</option>`].concat((state.folders || []).map((f)=>`<option value="${f.id}">${f.name}</option>`));
        sel.innerHTML = options.join('');
        sel.value = state.currentFolderId || 'all';
    }
    function addFolder() {
        const name = (document.getElementById('new-folder-name').value || '').trim();
        if (!name) return;
        const id = `f_${Date.now().toString(36)}`;
        state.folders.push({id, name});
        state.folderMemos[id] = { memos:[{name:'フォルダーメモ', content:'', attachments:[]}], currentMemoIdx:0 };
        document.getElementById('new-folder-name').value = '';
        state.currentFolderId = id;
        refreshUI(); save();
    }
    function changeFolderFilter(folderId) { state.currentFolderId = folderId || 'all'; refreshUI(); save(); }
    function renameCurrentFolder() {
        if (!state.currentFolderId || state.currentFolderId === 'all') return showToast('特定フォルダーを選択してください', 'error');
        const target = state.folders.find((f)=>f.id===state.currentFolderId);
        if (!target) return;
        const name = prompt('フォルダー名', target.name);
        if (!name) return;
        target.name = name.trim();
        refreshUI(); save();
    }
    function getCurrentFolderMemoBundle() {
        const fid = state.currentFolderId && state.currentFolderId !== 'all' ? state.currentFolderId : 'root';
        if (!state.folderMemos[fid]) state.folderMemos[fid] = { memos:[{name:'フォルダーメモ', content:'', attachments:[]}], currentMemoIdx:0 };
        return state.folderMemos[fid];
    }

    function getCurrentMemoContext() {
        if (state.memoScope === 'local') {
            const bundle = state.chapters[state.currentIdx];
            return { memos: bundle.memos, idxKey: 'currentMemoIdx', owner: bundle };
        }
        if (state.memoScope === 'folder') {
            const bundle = getCurrentFolderMemoBundle();
            return { memos: bundle.memos, idxKey: 'currentMemoIdx', owner: bundle };
        }
        return { memos: state.globalMemos, idxKey: 'currentGlobalMemoIdx', owner: state };
    }
    function renderMemoAttachments() {
        const box = document.getElementById('memo-attachments');
        if (!box) return;
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        const files = memo?.attachments || [];
        box.innerHTML = files.map((f, i) => `<div class="config-item"><span class="material-icons" style="font-size:16px;">${f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audiotrack' : 'description'}</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis;">${f.name}</span><button onclick="openMemoAttachment(${i})"><span class="material-icons" style="font-size:16px;">open_in_new</span></button><button onclick="removeMemoAttachment(${i})"><span class="material-icons" style="font-size:16px;">delete</span></button></div>`).join('') || '<div class="config-item">添付なし</div>';
    }
    async function attachMemoFile(file) {
        if (!file) return;
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        if (!memo.attachments) memo.attachments = [];
        let data;
        if (file.type.startsWith('text/') || file.name.endsWith('.txt')) data = await file.text();
        else data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(file); });
        memo.attachments.push({ name:file.name, type:file.type || 'text/plain', data, createdAt:Date.now() });
        document.getElementById('memo-attach-input').value = '';
        renderMemoAttachments();
        save();
    }
    function openMemoAttachment(i) {
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        const f = memo?.attachments?.[i];
        if (!f) return;
        if (typeof f.data === 'string' && f.data.startsWith('data:')) {
            const a = document.createElement('a'); a.href = f.data; a.download = f.name; a.click();
        } else {
            showPreview();
            document.getElementById('preview-overlay').innerHTML = `<pre style="white-space:pre-wrap;">${(f.data || '').replace(/[&<>]/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]))}</pre>`;
        }
    }
    function removeMemoAttachment(i) {
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        if (!memo?.attachments) return;
        memo.attachments.splice(i, 1);
        renderMemoAttachments(); save();
    }

    function refreshUI() {
        renderFolderFilter();
        const visible = getVisibleChapterIndexes();
        document.getElementById('chapter-list').innerHTML = visible.map((i) => { const ch = state.chapters[i]; return `<div class="chapter-item ${i === state.currentIdx ? 'active' : ''}"><button style="flex:1; text-align:left; background:transparent; border:none; color:var(--text); cursor:pointer;" onclick="switchChapter(${i})">${ch.title}<small style=\"opacity:.6; margin-left:6px;\">[${(state.folders.find(f=>f.id===ch.folderId)||{name:'既定'}).name}]</small></button><button onclick="renameChapter(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>edit</span></button><button onclick="moveChapter(${i},-1)" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>arrow_upward</span></button><button onclick="moveChapter(${i},1)" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>arrow_downward</span></button><button onclick="cycleChapterFolder(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>folder</span></button><button onclick="deleteChapter(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>close</span></button></div>`; }).join('');
        renderDownloadTargets();
        renderList('replace-list', state.replaceRules || [], 'replace');
        renderList('insert-list', state.insertButtons || [], 'insert');
        renderSnapshots(); updateButtons(); renderFavorites();
        const feb = document.getElementById('favorite-edit-block'); if (feb) feb.style.display = state.favoriteEditMode ? 'block' : 'none';
        switchMenuTab(state.menuTab || 'favorites');
        updateStats();
    }
    function renderDownloadTargets() {
        const selectedIndexes = new Set(getSelectedChapterIndexes());
        const container = document.getElementById('download-target-list');
        if (!container) return;
        const visible = getVisibleChapterIndexes();
        container.innerHTML = visible.map((i) => {
            const ch = state.chapters[i];
            const checked = selectedIndexes.size === 0 || selectedIndexes.has(i) ? 'checked' : '';
            return `<label class="config-item" style="cursor:pointer;"><input id="download-target-${i}" type="checkbox" ${checked}><span style="flex:1;">${ch.title}</span></label>`;
        }).join('');
    }
    function toggleSelectAllDownloadTargets() {
        const checkboxes = Array.from(document.querySelectorAll('[id^="download-target-"]'));
        if (checkboxes.length === 0) return;
        const shouldCheck = checkboxes.some((box) => !box.checked);
        checkboxes.forEach((box) => {
            box.checked = shouldCheck;
        });
    }
    function renderList(id, data, type) {
        document.getElementById(id).innerHTML = data.map((item, i) => `
            <div class="config-item"><span style="flex:1">${item.from || item.label} → ${item.to || item.value}</span>
            <span class="material-icons" style="font-size:16px; cursor:pointer;" onclick="removeItem('${type}', ${i})">delete_outline</span></div>
        `).join('');
    }
    function addListItem(type) {
        if (type === 'replace') {
            const f = document.getElementById('rep-from').value, t = document.getElementById('rep-to').value;
            if(f && t) { state.replaceRules.push({from:f, to:t}); document.getElementById('rep-from').value = ""; document.getElementById('rep-to').value = ""; }
        } else {
            const l = document.getElementById('ins-label').value, v = document.getElementById('ins-value').value;
            if(l && v) { state.insertButtons.push({label:l, value:v}); document.getElementById('ins-label').value = ""; document.getElementById('ins-value').value = ""; }
        }
        refreshUI(); save();
    }
    function removeItem(type, i) { if (type === 'replace') state.replaceRules.splice(i, 1); else state.insertButtons.splice(i, 1); refreshUI(); save(); }
    function updateButtons() {
        const container = document.getElementById('quick-buttons'); container.innerHTML = '';
        (state.insertButtons || []).forEach(b => {
            const btn = document.createElement('button'); btn.innerText = b.label;
            btn.onclick = () => { editor.setRangeText(b.value, editor.selectionStart, editor.selectionEnd, 'end'); editor.focus(); save(); updateHighlight(); };
            container.appendChild(btn);
        });
    }
    function updateStats() {
        const rawText = editor.value;
        const totalChars = rawText.length;
        const readableText = rawText.replace(/[\s　]/g, "");
        const readableChars = readableText.length;
        const charsPerMinute = 600;
        const minutes = readableChars / charsPerMinute;
        let readingText;
        if (minutes < 1) {
            const seconds = Math.max(1, Math.round(minutes * 60));
            readingText = `約 ${seconds} 秒`;
        } else {
            const min = Math.floor(minutes);
            const sec = Math.round((minutes - min) * 60);
            readingText = sec > 0 ? `約 ${min} 分 ${sec} 秒` : `約 ${min} 分`;
        }
        document.getElementById('stats-display').innerText = `${totalChars} 文字（実質 ${readableChars}）｜ 読了 ${readingText}`;
        const now = Date.now();
        state.writingSessions = (state.writingSessions || []).filter((x) => now - x.t < 1000*60*60*24*14);
        if (!state.writingSessions.length || now - state.writingSessions[state.writingSessions.length - 1].t > 45000) {
            state.writingSessions.push({ t: now, c: totalChars });
        } else {
            state.writingSessions[state.writingSessions.length - 1].c = totalChars;
        }
        renderAnalytics();
    }
    function renderAnalytics() {
        const sessions = state.writingSessions || [];
        const recent = sessions.slice(-14);
        const points = recent.map((s) => `${new Date(s.t).toLocaleDateString().slice(5)}:${s.c}`).join(' / ');
        document.getElementById('session-stats').innerHTML = `<div class="config-item" style="white-space:normal;">最近の文字数推移: ${points || 'データなし'}</div>`;

        const cvs = document.getElementById('writing-graph');
        if (cvs) {
            const ctx = cvs.getContext('2d');
            const w = cvs.width, h = cvs.height;
            ctx.clearRect(0, 0, w, h);
            ctx.strokeStyle = '#999';
            ctx.strokeRect(0, 0, w, h);
            const vals = recent.map((x) => x.c);
            const max = Math.max(1, ...vals);
            const bw = vals.length ? w / vals.length : w;
            ctx.fillStyle = '#607d8b';
            vals.forEach((v, i) => {
                const bh = Math.max(2, (v / max) * (h - 20));
                ctx.fillRect(i * bw + 2, h - bh - 2, Math.max(2, bw - 4), bh);
            });
        }

        const words = extractJapaneseTerms(editor.value);
        const topEntries = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const top = topEntries.map(([w, c]) => `${w}(${c})`).join(' / ');
        document.getElementById('top-words').innerHTML = `<div class="config-item" style="white-space:normal;">頻出語（日本語分かち書き）: ${top || 'データなし'}</div>`;

        const paragraphCount = editor.value.split(/\n{2,}/).filter(Boolean).length;
        const sentenceCount = (editor.value.match(/[。！？!?]/g) || []).length;
        const avgSentence = sentenceCount ? Math.round(editor.value.replace(/\s/g, '').length / sentenceCount) : 0;
        document.getElementById('other-stats').innerHTML = `<div class="config-item" style="white-space:normal;">段落数: ${paragraphCount} / 文数: ${sentenceCount} / 1文平均: ${avgSentence}文字</div>`;
    }
    function extractJapaneseTerms(text) {
        const freq = {};
        const add = (token) => {
            const t = token.trim();
            if (!t || t.length < 2) return;
            freq[t] = (freq[t] || 0) + 1;
        };
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const seg = new Intl.Segmenter('ja', { granularity: 'word' });
            for (const part of seg.segment(text || '')) {
                if (!part.isWordLike) continue;
                add(part.segment);
            }
            return freq;
        }
        const fallback = (text || '').replace(/[　\s]+/g, ' ').split(' ');
        fallback.forEach(add);
        return freq;
    }

    function getSearchRegex() {
        const q = document.getElementById('search-query').value;
        const regexMode = !!document.getElementById('search-regex')?.checked;
        if (!q) return null;
        try {
            return regexMode ? new RegExp(q, 'gu') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
        } catch {
            showToast('正規表現が不正です', 'error');
            return null;
        }
    }
    function collectSearchResults() {
        const re = getSearchRegex();
        if (!re) return [];
        const all = !!document.getElementById('search-all-chapters')?.checked;
        const targets = all ? state.chapters.map((ch,i)=>({i,text:ch.body,title:ch.title})) : [{i:state.currentIdx,text:editor.value,title:state.chapters[state.currentIdx].title}];
        const hits = [];
        targets.forEach((t)=>{
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(t.text)) !== null) {
                hits.push({ chapterIndex:t.i, title:t.title, index:m.index, length:m[0].length, text:m[0] });
                if (m.index === re.lastIndex) re.lastIndex++;
            }
        });
        document.getElementById('search-summary').innerHTML = `<div class="config-item">検索ヒット: ${hits.length} 件${all ? '（全話）' : '（現在話）'}</div>`;
        return hits;
    }
    function toggleSearchPanel(forceOpen = false) {
        const p = document.getElementById('search-panel');
        p.style.display = (forceOpen || p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
        if (p.style.display === 'block') {
            if (!document.getElementById('search-regex')) {
                const row = document.createElement('div');
                row.style.display = 'flex'; row.style.gap='8px'; row.style.marginTop='6px';
                row.innerHTML = `<label style="font-size:11px;"><input id="search-regex" type="checkbox"> 正規表現</label><label style="font-size:11px;"><input id="search-all-chapters" type="checkbox"> 全話横断</label><button class="sys-btn" style="margin:0;height:28px;" onclick="collectSearchResults()">件数更新</button>`;
                p.appendChild(row);
            }
            document.getElementById('search-query').focus();
            collectSearchResults();
        }
    }
    function findNext() {
        const hits = collectSearchResults();
        if (!hits.length) return showToast('見つかりませんでした', 'error');
        const all = !!document.getElementById('search-all-chapters')?.checked;
        let cursorChapter = state.currentIdx;
        let cursorPos = editor.selectionEnd;
        let hit = hits.find((h) => h.chapterIndex === cursorChapter && h.index >= cursorPos);
        if (!hit) hit = hits[0];
        if (all && hit.chapterIndex !== state.currentIdx) switchChapter(hit.chapterIndex);
        editor.focus();
        editor.setSelectionRange(hit.index, hit.index + hit.length);
        updateHighlight();
    }
    function replaceCurrent() {
        const r = document.getElementById('replace-query').value;
        const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
        if (!selected) return findNext();
        editor.setRangeText(r, editor.selectionStart, editor.selectionEnd, 'select');
        save();
        findNext();
    }
    function replaceAllMatches() {
        const re = getSearchRegex();
        const r = document.getElementById('replace-query').value;
        if (!re) return;
        const all = !!document.getElementById('search-all-chapters')?.checked;
        let count = 0;
        if (all) {
            state.chapters.forEach((ch) => {
                const before = ch.body;
                ch.body = ch.body.replace(re, () => { count++; return r; });
                re.lastIndex = 0;
                if (state.currentIdx === state.chapters.indexOf(ch)) editor.value = ch.body;
            });
        } else {
            const before = editor.value;
            editor.value = editor.value.replace(re, () => { count++; return r; });
        }
        save(); updateHighlight(); showToast(`${count}件置換しました`, 'success'); collectSearchResults();
    }


    function onAIProviderChange() {
        const provider = document.getElementById('ai-provider')?.value || 'openrouter';
        state.aiProvider = provider;
        const offline = !navigator.onLine;
        const note = document.getElementById('ai-offline-note');
        if (note) note.style.display = offline ? 'flex' : 'none';
        ['ai-api-key', 'ai-model', 'ai-prompt'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = offline;
        });
        queuePersist();
    }
    function getAIScopeText() {
        const scope = document.getElementById('ai-scope')?.value || 'chapter';
        if (scope === 'folder') {
            const visible = getVisibleChapterIndexes();
            return visible.map((i) => `### ${state.chapters[i].title}\n${state.chapters[i].body || ''}`).join('\n\n');
        }
        if (scope === 'all') return state.chapters.map((ch) => `### ${ch.title}\n${ch.body || ''}`).join('\n\n');
        return state.chapters[state.currentIdx]?.body || '';
    }
    async function fetchAIModels() {
        if (!navigator.onLine) return showToast('オフライン中は利用できません', 'error');
        const provider = document.getElementById('ai-provider').value;
        const key = document.getElementById('ai-api-key').value.trim();
        if (!key) return showToast('AI API Keyを入力してください', 'error');
        try {
            let models = [];
            if (provider === 'openrouter') {
                const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${key}` } });
                const j = await r.json();
                models = (j.data || []).map((m) => m.id);
            } else if (provider === 'groq') {
                const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
                const j = await r.json();
                models = (j.data || []).map((m) => m.id);
            } else {
                const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
                const j = await r.json();
                models = (j.models || []).map((m) => m.name.replace('models/', ''));
            }
            const sel = document.getElementById('ai-model');
            sel.innerHTML = models.slice(0, 100).map((m) => `<option value="${m}">${m}</option>`).join('');
            if (state.aiModel && models.includes(state.aiModel)) sel.value = state.aiModel;
            showToast('モデル一覧を取得しました', 'success');
            save();
        } catch (e) {
            showToast(`モデル取得失敗: ${e.message}`, 'error');
        }
    }
    async function callAI(messages, jsonMode = false) {
        if (!navigator.onLine) throw new Error('オフライン中です');
        const provider = document.getElementById('ai-provider').value;
        const key = document.getElementById('ai-api-key').value.trim();
        const model = document.getElementById('ai-model').value.trim();
        if (!key || !model) throw new Error('APIキーとモデルを設定してください');

        if (provider === 'google') {
            const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
            const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            const j = await r.json();
            return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        const base = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
        const body = { model, messages, temperature: 0.4 };
        if (jsonMode) body.response_format = { type: 'json_object' };
        const r = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body)
        });
        const j = await r.json();
        return j.choices?.[0]?.message?.content || '';
    }
    async function sendAIChat() {
        try {
            const prompt = document.getElementById('ai-prompt').value.trim();
            if (!prompt) return showToast('AIへの指示を入力してください', 'error');
            const scopeText = getAIScopeText();
            const ans = await callAI([
                { role: 'system', content: 'あなたは日本語小説執筆を支援するアシスタントです。簡潔で実用的に答えてください。' },
                { role: 'user', content: `対象テキスト:\n${scopeText.slice(0, 12000)}\n\n指示:\n${prompt}` }
            ], false);
            state.aiChat = state.aiChat || [];
            state.aiChat.push({ q: prompt, a: ans, at: Date.now() });
            state.aiChat = state.aiChat.slice(-12);
            document.getElementById('ai-chat-log').innerHTML = state.aiChat.map((x) => `<div class="config-item" style="white-space:normal;display:block;"><div><strong>Q:</strong> ${x.q}</div><div><strong>A:</strong> ${x.a.replace(/\n/g, '<br>')}</div></div>`).reverse().join('');
            showToast('AIチャット応答を取得しました', 'success');
            save();
        } catch (e) { showToast(`AIチャット失敗: ${e.message}`, 'error'); }
    }
    async function runAIProofread() {
        try {
            const scopeText = getAIScopeText();
            const userPrompt = document.getElementById('ai-prompt').value.trim() || '誤字脱字・不自然表現・表記揺れを校閲してください';
            const text = await callAI([
                { role: 'system', content: '出力はJSONのみ。{replacements:[{from,to,reason}]} 形式で返してください。' },
                { role: 'user', content: `対象:\n${scopeText.slice(0, 12000)}\n\n要件:${userPrompt}` }
            ], true);
            let data;
            try { data = JSON.parse(text); } catch { data = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"replacements":[]}'); }
            const reps = data.replacements || [];
            state.lastAISuggestions = reps;
            document.getElementById('ai-suggestions').innerHTML = reps.map((r, i) => `<div class="config-item" style="align-items:flex-start;"><div style="flex:1;"><div><strong>${r.from}</strong> → <strong>${r.to}</strong></div><div style="font-size:11px;opacity:.8;">${r.reason || ''}</div></div><button onclick="applyAISuggestion(${i})"><span class="material-icons" style="font-size:16px;">published_with_changes</span></button></div>`).join('') || '<div class="config-item">候補なし</div>';
            showToast(`校閲候補 ${reps.length} 件`, 'success');
        } catch (e) { showToast(`AI校閲失敗: ${e.message}`, 'error'); }
    }
    function applyAISuggestion(i) {
        const r = (state.lastAISuggestions || [])[i];
        if (!r) return;
        editor.value = editor.value.split(r.from).join(r.to);
        save(); updateHighlight(); updateStats();
        showToast(`置換適用: ${r.from} → ${r.to}`, 'success');
    }
    window.addEventListener('online', onAIProviderChange);
    window.addEventListener('offline', onAIProviderChange);


    async function downloadSelectedZip() {
        save();
        const selected = getSelectedChapterIndexes();
        if (selected.length === 0) {
            showToast('ダウンロード対象の話を選択してください。', 'error');
            return;
        }

        if (selected.length === 1) {
            const chapter = state.chapters[selected[0]];
            const filename = `${sanitizeFileName(chapter.title)}.txt`;
            triggerDownload(createUtf8TextBlob(chapter.body || ''), filename);
            return;
        }

        if (typeof JSZip === 'undefined') {
            showToast('ZIPライブラリの読み込みに失敗しました。通信状態を確認してください。', 'error');
            return;
        }

        const zip = new JSZip();
        const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
        selected.forEach((idx, order) => {
            const chapter = state.chapters[idx];
            const folderName = (state.folders.find((f)=>f.id===chapter.folderId)||{name:'既定'}).name;
            const filename = `${stamp}_${String(order + 1).padStart(2, '0')}_${sanitizeFileName(folderName)}_${sanitizeFileName(chapter.title)}.txt`;
            zip.file(filename, createUtf8BytesWithBom(chapter.body || ''));
        });

        const blob = await zip.generateAsync({ type: 'blob' });
        triggerDownload(blob, 'kakudraft_selected.zip');
    }
    function downloadSelectedMergedTxt() {
        save();
        const selected = getSelectedChapterIndexes();
        if (selected.length === 0) {
            showToast('ダウンロード対象の話を選択してください。', 'error');
            return;
        }
        const merged = selected.map((idx) => {
            const chapter = state.chapters[idx];
            return `===== ${chapter.title} =====\n${chapter.body || ''}`;
        }).join('\n\n');
        const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
        triggerDownload(createUtf8TextBlob(merged), `kakudraft_merged_${stamp}.txt`);
    }
    function togglePanel(id) { const p = document.getElementById(id); const isOpen = p.classList.contains('open'); closePanels(); if(!isOpen) p.classList.add('open'); }
    function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; document.body.setAttribute('data-theme', state.theme); save(); }
    function changeFontSize(d) { state.fontSize += d; document.documentElement.style.setProperty('--editor-size', state.fontSize + 'px'); updateHighlight(); save(); }
    function exportFullData() { save(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], {type: 'application/json'})); a.download = `kaku_draft_full.json`; a.click(); }
    function importFullData(input) {
        const file = input.files[0]; if(!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                if(confirm("JSONファイルから全データを復元しますか？現在のデータは上書きされます。")) {
                    state = normalizeStateShape(imported);
                    await persistNow();
                    location.reload();
                }
            } catch(err) { showToast("JSONの解析に失敗しました。", "error"); }
        };
        reader.readAsText(file);
    }
    function showPreview() { document.getElementById('preview-overlay').innerHTML = editor.value.replace(/\n/g, '<br>'); document.getElementById('preview-overlay').style.display = 'block'; }
    function addChapter() { const t = prompt("タイトル:"); if(!t) return; save(); state.chapters.push({title: t, body: "", snapshots: [], memos: [{name:"メモ", content:"", attachments: []}], currentMemoIdx: 0, folderId: state.currentFolderId && state.currentFolderId !== 'all' ? state.currentFolderId : 'root'}); state.currentIdx = state.chapters.length - 1; refreshUI(); loadChapter(state.currentIdx); }
    function deleteChapter(i) { if(state.chapters.length <= 1 || !confirm("削除？")) return; state.chapters.splice(i, 1); state.currentIdx = 0; refreshUI(); loadChapter(0); }
    function splitChapter() {
        const pos = editor.selectionStart; const bodyBefore = editor.value.slice(0, pos); const bodyAfter = editor.value.slice(pos);
        const newTitle = prompt("続話のタイトル:", state.chapters[state.currentIdx].title + " (続)"); if (!newTitle) return;
        save(); state.chapters[state.currentIdx].body = bodyBefore;
        state.chapters.splice(state.currentIdx + 1, 0, { title: newTitle, body: bodyAfter, memos: [{name:"メモ", content:"", attachments: []}], currentMemoIdx: 0, snapshots: [] });
        state.currentIdx++; refreshUI(); loadChapter(state.currentIdx);
    }
    function mergeChapter() { if (state.currentIdx === 0 || !confirm("前の話と統合しますか？")) return; save(); state.chapters[state.currentIdx - 1].body += "\n" + editor.value; state.chapters.splice(state.currentIdx, 1); state.currentIdx--; refreshUI(); loadChapter(state.currentIdx); }
    memoArea.oninput = save;
    memoArea.addEventListener('dragover', (e)=>e.preventDefault());
    memoArea.addEventListener('drop', async (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) await attachMemoFile(f); });
    editor.addEventListener('pointerdown', closePanels);
    editor.addEventListener('dragover', (e) => { e.preventDefault(); });
    editor.addEventListener('drop', async (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('text/')) {
            const text = await file.text();
            editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
        } else {
            const text = e.dataTransfer?.getData('text/plain');
            if (text) editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
        }
        save(); updateHighlight(); showToast('ドラッグ&ドロップで貼り付けました', 'success');
    });

    document.addEventListener("keydown", async (e) => {
        const isMac = navigator.platform.toUpperCase().includes("MAC");
        const ctrl = isMac ? e.metaKey : e.ctrlKey;
        if (!ctrl) return;
        const key = e.key.toLowerCase();
        switch (key) {
            case "s":
                e.preventDefault();
                save();
                if (document.getElementById('gh-token').value && state.ghRepo) {
                    clearTimeout(syncTimer);
                    syncTimer = setTimeout(() => githubSync("up"), 1200);
                }
                break;
            case "m": e.preventDefault(); togglePanel("memo-panel"); break;
            case "b": e.preventDefault(); togglePanel("menu-panel"); break;
            case "p": e.preventDefault(); showPreview(); break;
            case "e": e.preventDefault(); document.activeElement === editor ? memoArea.focus() : editor.focus(); break;
            case "f": e.preventDefault(); toggleSearchPanel(true); break;
            case "g": e.preventDefault(); findNext(); break;
            case "h": e.preventDefault(); location.href = 'help.html'; break;
            case "j": e.preventDefault(); changeFontSize(-1); break;
            case "k": e.preventDefault(); changeFontSize(1); break;
            case "u": e.preventDefault(); takeBodySnapshot(); break;
            case "arrowup": if (e.shiftKey) { e.preventDefault(); moveChapter(state.currentIdx, -1); } break;
            case "arrowdown": if (e.shiftKey) { e.preventDefault(); moveChapter(state.currentIdx, 1); } break;
        }
    });
