    const editor = document.getElementById('editor'); const memoArea = document.getElementById('memo-area'); const hl = document.getElementById('line-highlight');
    const DB_NAME = 'kakudraft-db';
    const DB_VERSION = 2;
    const STATE_KEY = 'app-state';
    const LEGACY_STORAGE_KEY = 'kaku_v_pro_sync';
    const CLOUD_PATHS = { settings: '設定/settings.json', keys: 'キー類/keys.json', stories: '話/stories.json', memos: 'メモ/memos.json', aiChat: '話/ai_chat.json', metadata: '設定/sync_metadata.json', assetsIndex: '設定/assets_index.json' };
    const LEGACY_CLOUD_PATHS = { data: 'kakudraft_data.json', aiChat: 'kakudraft_ai_chat.json' };
    const AI_CHAT_KEY = 'ai-chat';
    const toastEl = document.getElementById('toast');
    let syncTimer;
    let toastTimer;
    let persistTimer;
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js', { scope: './' });
        });
    }
    let state = { chapters: [{ title: "第一話", body: "", memos: [{name: "メモ", content: "", attachments: []}], currentMemoIdx: 0, snapshots: [] }], currentIdx: 0, globalMemos: [{name: "共通設定", content: "", attachments: []}], currentGlobalMemoIdx: 0, memoScope: 'local', replaceRules: [{from: "!!", to: "！！"}], insertButtons: [{label: "ルビ", value: "|《》"}, {label: "強調", value: "《》"}, {label: "「", value: "「"}], fontSize: 18, theme: "light", ghTokenEnc: "", ghTokenLegacy: "", ghRepo: "", deviceName: "", menuTab: 'favorites', favoriteActionKeys: ['sync-up','take-snapshot','toggle-theme'], fontFamily: "'Sawarabi Mincho', serif", writingSessions: [], folders:[{id:'root',name:'既定タグ'}], currentFolderId:'all', folderMemos:{root:{memos:[{name:'タグメモ',content:'',attachments:[]}], currentMemoIdx:0}}, favoriteEditMode:false, keepScreenOn:false, aiProvider:'openrouter', aiKeyEnc:'', aiKeysEnc:{}, aiModel:'', aiTab:'chat', aiFreeOnly:false, aiUsage:{}, syncMeta:{}, assetsIndex:{items:[]} };
    let aiChatState = [];
    let aiBusy = false;
    let aiThinkingDots = 1;
    let aiThinkingTimer = null;
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
    async function storeAttachmentBlob(file, data) {
        const id = `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
        await dbPut('attachments', { id, name: file.name, type: file.type || 'application/octet-stream', data, size: file.size || 0, createdAt: Date.now() });
        return { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size || 0, createdAt: Date.now(), storage: 'idb', githubPath: null };
    }
    async function getAttachmentData(ref) {
        if (!ref) return null;
        if (!ref.id && typeof ref.data !== 'undefined') return { id: '', name: ref.name, type: ref.type, data: ref.data, size: ref.size || 0 };
        if (!ref?.id) return null;
        const local = await dbGet('attachments', ref.id);
        if (local?.data) return local;
        if (ref.githubPath) {
            const token = document.getElementById('gh-token')?.value?.trim();
            const repoInput = state.ghRepo;
            const parsedRepo = parseRepoTarget(repoInput || '', undefined);
            if (!token || !parsedRepo) return null;
            const url = `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/contents/${ref.githubPath}`;
            const res = await requestJson(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
            if (res.res.ok && res.body?.content) {
                const b64 = res.body.content.replace(/\n/g, '');
                const binary = atob(b64);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
                const blob = new Blob([bytes], { type: ref.type || 'application/octet-stream' });
                await dbPut('attachments', { id: ref.id, name: ref.name, type: ref.type, data: blob, size: ref.size || bytes.length, createdAt: ref.createdAt || Date.now() });
                return { id: ref.id, name: ref.name, type: ref.type, data: blob, size: ref.size || bytes.length };
            }
        }
        return null;
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
            memos: (ch.memos && ch.memos.length ? ch.memos : [{name:'メモ', content:''}]).map((m)=>({name:m.name||'メモ', content:m.content||'', attachments:(m.attachments||[]).map((a)=>({id:a.id||'',name:a.name||'file',type:a.type||'application/octet-stream',size:a.size||0,createdAt:a.createdAt||Date.now(),storage:a.storage||'inline',githubPath:a.githubPath||null,data:typeof a.data==='string'?a.data:undefined}))})),
            currentMemoIdx: Number.isInteger(ch.currentMemoIdx) ? ch.currentMemoIdx : 0,
            snapshots: ch.snapshots || [],
            folderId: ch.folderId || 'root'
        }));
        if (!next.chapters.length) next.chapters = [{title:'第一話', body:'', memos:[{name:'メモ', content:''}], currentMemoIdx:0, snapshots:[], folderId:'root'}];
        next.folders = next.folders && next.folders.length ? next.folders : [{id:'root',name:'既定タグ'}];
        if (!next.folders.some((f) => f.id === 'root')) next.folders.unshift({id:'root',name:'既定タグ'});
        next.currentFolderId = next.currentFolderId || 'all';
        next.globalMemos = (next.globalMemos && next.globalMemos.length ? next.globalMemos : [{name:'共通設定', content:'', attachments:[]}]).map((m)=>({name:m.name||'共通設定', content:m.content||'', attachments:(m.attachments||[]).map((a)=>({id:a.id||'',name:a.name||'file',type:a.type||'application/octet-stream',size:a.size||0,createdAt:a.createdAt||Date.now(),storage:a.storage||'inline',githubPath:a.githubPath||null,data:typeof a.data==='string'?a.data:undefined}))}));
        Object.keys(next.folderMemos).forEach((k)=>{
            const bundle = next.folderMemos[k] || { memos:[{name:'タグメモ',content:'',attachments:[]}], currentMemoIdx:0 };
            bundle.memos = (bundle.memos && bundle.memos.length ? bundle.memos : [{name:'タグメモ',content:'',attachments:[]}]).map((m)=>({name:m.name||'タグメモ', content:m.content||'', attachments:(m.attachments||[]).map((a)=>({id:a.id||'',name:a.name||'file',type:a.type||'application/octet-stream',size:a.size||0,createdAt:a.createdAt||Date.now(),storage:a.storage||'inline',githubPath:a.githubPath||null,data:typeof a.data==='string'?a.data:undefined}))}));
            if (!Number.isInteger(bundle.currentMemoIdx)) bundle.currentMemoIdx = 0;
            next.folderMemos[k] = bundle;
        });
        next.chapters.forEach((ch) => {
            if (!next.folders.some((f) => f.id === ch.folderId)) ch.folderId = 'root';
        });
        next.aiKeysEnc = (next.aiKeysEnc && typeof next.aiKeysEnc === 'object') ? next.aiKeysEnc : {};
        if (next.aiKeyEnc && !next.aiKeysEnc[next.aiProvider || 'openrouter']) next.aiKeysEnc[next.aiProvider || 'openrouter'] = next.aiKeyEnc;
        next.aiTab = next.aiTab === 'proofread' ? 'proofread' : 'chat';
        next.aiFreeOnly = !!next.aiFreeOnly;
        next.aiUsage = (next.aiUsage && typeof next.aiUsage === 'object') ? next.aiUsage : {};
        next.syncMeta = (next.syncMeta && typeof next.syncMeta === 'object') ? next.syncMeta : {};
        next.assetsIndex = (next.assetsIndex && Array.isArray(next.assetsIndex.items)) ? next.assetsIndex : {items:[]};
        return next;
    }
    function getAIKeyInputId(provider) {
        return `ai-api-key-${provider}`;
    }
    function getStateWithoutAIChat() {
        const clone = structuredClone(state);
        delete clone.aiChat;
        return clone;
    }
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
            const parsed = JSON.parse(saved);
            aiChatState = Array.isArray(parsed) ? parsed.slice(-100) : [];
        } catch {
            aiChatState = [];
        }
    }
    function setAIBusy(nextBusy) {
        aiBusy = !!nextBusy;
        const note = document.getElementById('ai-busy-note');
        if (note) note.style.display = aiBusy ? 'flex' : 'none';
        if (aiBusy) {
            aiThinkingDots = 1;
            clearInterval(aiThinkingTimer);
            aiThinkingTimer = setInterval(() => {
                aiThinkingDots = aiThinkingDots >= 3 ? 1 : aiThinkingDots + 1;
                renderAIChatLog();
        renderAIUsage();
            }, 420);
        } else {
            clearInterval(aiThinkingTimer);
            aiThinkingTimer = null;
            aiThinkingDots = 1;
        }
        ['ai-prompt', 'ai-proofread-prompt', 'ai-scope', 'ai-scope-proofread', 'ai-send-chat', 'ai-send-proofread', 'ai-chat-clear-btn'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.disabled = aiBusy || !navigator.onLine;
        });
        renderAIChatLog();
        renderAIUsage();
    }
    async function stashAllProviderKeys() {
        state.aiKeysEnc = state.aiKeysEnc || {};
        for (const provider of ['openrouter', 'groq', 'google']) {
            const aiKeyPlain = document.getElementById(getAIKeyInputId(provider))?.value || '';
            state.aiKeysEnc[provider] = await encryptPatToken(aiKeyPlain, state.deviceName);
        }
        const activeProvider = state.aiProvider || document.getElementById('ai-provider')?.value || 'openrouter';
        state.aiKeyEnc = state.aiKeysEnc[activeProvider] || '';
    }
    async function getProviderKey(provider) {
        const enc = (state.aiKeysEnc || {})[provider] || '';
        if (enc) return await decryptPatToken(enc, state.deviceName);
        if (provider === (state.aiProvider || 'openrouter') && state.aiKeyEnc) return await decryptPatToken(state.aiKeyEnc, state.deviceName);
        return '';
    }
    async function persistNow() {
        const tokenPlain = document.getElementById('gh-token').value || '';
        state.ghTokenEnc = await encryptPatToken(tokenPlain, state.deviceName);
        state.ghTokenLegacy = '';
        await stashAllProviderKeys();
        await dbPut('kv', JSON.stringify(getStateWithoutAIChat()), STATE_KEY);
        await persistAIChatNow();
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
            await dbPut('kv', JSON.stringify(getStateWithoutAIChat()), STATE_KEY);
        await persistAIChatNow();
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            showToast('旧データを新しい保存形式へ移行しました', 'success');
        }
    }
    window.onload = async () => {
        await loadPersistedState();
        await loadPersistedAIChat();
        let token = await decryptPatToken(state.ghTokenEnc, state.deviceName);
        if (!token && state.ghToken) {
            try { token = decodeURIComponent(escape(atob(state.ghToken))); } catch { token = ''; }
        }
        document.getElementById('gh-token').value = token;
        document.getElementById('ai-provider').value = state.aiProvider || 'openrouter';
        for (const provider of ['openrouter', 'groq', 'google']) {
            const aiKey = await getProviderKey(provider);
            const el = document.getElementById(getAIKeyInputId(provider));
            if (el) el.value = aiKey || '';
        }
        await onAIProviderChange();
        const freeOnly = document.getElementById('ai-free-only');
        if (freeOnly) freeOnly.checked = !!state.aiFreeOnly;
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
        renderAIChatLog();
        renderAIUsage();
        setAIBusy(false);
        switchAITab(state.aiTab || 'chat');
        refreshUI(); loadChapter(state.currentIdx);
        if (navigator.onLine && token && state.ghRepo) {
            setTimeout(async () => {
                try {
                    const parsedRepo = parseRepoTarget(state.ghRepo, undefined);
                    if (!parsedRepo) return;
                    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
                    const metaUrl = `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/contents/${CLOUD_PATHS.metadata}`;
                    const res = await requestJson(metaUrl, { headers });
                    if (!res.res.ok || !res.body?.content) return;
                    const remoteMeta = fromBase64ToJson(res.body.content);
                    const remoteTs = Number(remoteMeta?.updatedAt || 0);
                    const localTs = Number(state.syncMeta?.updatedAt || 0);
                    if (remoteTs > localTs && confirm('GitHubにローカルより新しいバックアップがあります。取得しますか？')) await githubSync('down');
                } catch {}
            }, 400);
        }
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
        state.aiFreeOnly = !!document.getElementById('ai-free-only')?.checked;
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
    async function syncAttachmentsToGithub(headers, owner, repo) {
        const refs = [];
        const collect = (memos) => (memos || []).forEach((m) => (m.attachments || []).forEach((a) => refs.push(a)));
        state.chapters.forEach((c) => collect(c.memos));
        collect(state.globalMemos);
        Object.values(state.folderMemos || {}).forEach((b) => collect(b.memos));
        for (const ref of refs) {
            if (!ref.id || ref.githubPath) continue;
            const stored = await dbGet('attachments', ref.id);
            if (!stored?.data) continue;
            const bytes = new Uint8Array(await (stored.data instanceof Blob ? stored.data.arrayBuffer() : new Blob([stored.data]).arrayBuffer()));
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            const content = btoa(binary);
            const ext = (ref.name.includes('.') ? ref.name.slice(ref.name.lastIndexOf('.')) : '');
            const path = `kakudraft_assets/${ref.id}${ext}`;
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify({ message: `asset: ${ref.name}`, content }) });
            ref.githubPath = path;
        }
    }

    function toBase64FromText(text) {
        const bytes = new TextEncoder().encode(text || '');
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
    }
    function fromBase64ToJson(content) {
        const cleaned = (content || '').replace(/\n/g, '');
        const binary = atob(cleaned);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    function buildCloudPieces() {
        return {
            settings: {
                replaceRules: state.replaceRules, insertButtons: state.insertButtons, fontSize: state.fontSize, theme: state.theme,
                deviceName: state.deviceName, menuTab: state.menuTab, favoriteActionKeys: state.favoriteActionKeys, fontFamily: state.fontFamily,
                folders: state.folders, currentFolderId: state.currentFolderId, favoriteEditMode: state.favoriteEditMode, keepScreenOn: state.keepScreenOn,
                aiProvider: state.aiProvider, aiModel: state.aiModel, aiTab: state.aiTab, aiFreeOnly: state.aiFreeOnly, aiUsage: state.aiUsage
            },
            keys: { ghTokenEnc: state.ghTokenEnc, ghRepo: state.ghRepo, deviceName: state.deviceName, aiKeyEnc: state.aiKeyEnc, aiKeysEnc: state.aiKeysEnc },
            stories: { chapters: state.chapters, currentIdx: state.currentIdx, writingSessions: state.writingSessions },
            memos: { globalMemos: state.globalMemos, currentGlobalMemoIdx: state.currentGlobalMemoIdx, memoScope: state.memoScope, folderMemos: state.folderMemos },
            aiChat: { list: aiChatState || [] },
            assetsIndex: state.assetsIndex || {items:[]}
        };
    }
    function applyCloudPieces(remote) {
        const merged = structuredClone(state);
        if (remote.settings) Object.assign(merged, remote.settings);
        if (remote.keys) { merged.ghTokenEnc = remote.keys.ghTokenEnc || merged.ghTokenEnc; merged.ghRepo = remote.keys.ghRepo || merged.ghRepo; merged.deviceName = remote.keys.deviceName || merged.deviceName; merged.aiKeyEnc = remote.keys.aiKeyEnc || merged.aiKeyEnc; merged.aiKeysEnc = remote.keys.aiKeysEnc || merged.aiKeysEnc; }
        if (remote.stories) { merged.chapters = remote.stories.chapters || merged.chapters; merged.currentIdx = Number.isInteger(remote.stories.currentIdx) ? remote.stories.currentIdx : merged.currentIdx; merged.writingSessions = remote.stories.writingSessions || merged.writingSessions; }
        if (remote.memos) { merged.globalMemos = remote.memos.globalMemos || merged.globalMemos; merged.currentGlobalMemoIdx = Number.isInteger(remote.memos.currentGlobalMemoIdx) ? remote.memos.currentGlobalMemoIdx : merged.currentGlobalMemoIdx; merged.memoScope = remote.memos.memoScope || merged.memoScope; merged.folderMemos = remote.memos.folderMemos || merged.folderMemos; }
        if (remote.aiChat?.list) aiChatState = Array.isArray(remote.aiChat.list) ? remote.aiChat.list.slice(-100) : [];
        if (remote.assetsIndex) merged.assetsIndex = remote.assetsIndex;
        state = normalizeStateShape(merged);
    }
    function convertLegacyRemoteToPieces(legacyData, legacyAiChat) {
        const normalized = normalizeStateShape(legacyData || {});
        const pieces = {
            settings: {
                replaceRules: normalized.replaceRules,
                insertButtons: normalized.insertButtons,
                fontSize: normalized.fontSize,
                theme: normalized.theme,
                deviceName: normalized.deviceName,
                menuTab: normalized.menuTab,
                favoriteActionKeys: normalized.favoriteActionKeys,
                fontFamily: normalized.fontFamily,
                folders: normalized.folders,
                currentFolderId: normalized.currentFolderId,
                favoriteEditMode: normalized.favoriteEditMode,
                keepScreenOn: normalized.keepScreenOn,
                aiProvider: normalized.aiProvider,
                aiModel: normalized.aiModel,
                aiTab: normalized.aiTab,
                aiFreeOnly: normalized.aiFreeOnly,
                aiUsage: normalized.aiUsage || {}
            },
            keys: {
                ghTokenEnc: normalized.ghTokenEnc || '',
                ghRepo: normalized.ghRepo || '',
                deviceName: normalized.deviceName || '',
                aiKeyEnc: normalized.aiKeyEnc || '',
                aiKeysEnc: normalized.aiKeysEnc || {}
            },
            stories: {
                chapters: normalized.chapters,
                currentIdx: normalized.currentIdx,
                writingSessions: normalized.writingSessions || []
            },
            memos: {
                globalMemos: normalized.globalMemos,
                currentGlobalMemoIdx: normalized.currentGlobalMemoIdx,
                memoScope: normalized.memoScope,
                folderMemos: normalized.folderMemos || {}
            },
            aiChat: { list: Array.isArray(legacyAiChat) ? legacyAiChat.slice(-100) : [] },
            assetsIndex: { items: [] },
            metadata: { updatedAt: Date.now(), migratedFrom: 'legacy-cloud-format' }
        };
        return pieces;
    }
    async function putCloudPiece(headers, owner, repo, key, data, sha = '') {
        const path = CLOUD_PATHS[key];
        if (!path) return;
        const body = { message: `sync ${key}`, content: toBase64FromText(JSON.stringify(data || {})) };
        if (sha) body.sha = sha;
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
        const res = await requestJson(url, { method: 'PUT', headers, body: JSON.stringify(body) });
        if (!res.res.ok) throw new Error(res.body?.message || `${key}の保存に失敗`);
    }
    async function migrateLegacyCloudIfNeeded(headers, owner, repo, remote, remoteMeta) {
        const hasCurrent = ['settings','keys','stories','memos','aiChat'].some((k) => !!remote[k]);
        if (hasCurrent) return false;
        let legacyData = null;
        let legacyAiChat = null;
        for (const [legacyKey, path] of Object.entries(LEGACY_CLOUD_PATHS)) {
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            const got = await requestJson(url, { headers });
            if (got.res.status !== 200 || !got.body?.content) continue;
            if (legacyKey === 'data') legacyData = fromBase64ToJson(got.body.content);
            if (legacyKey === 'aiChat') legacyAiChat = fromBase64ToJson(got.body.content);
        }
        if (!legacyData && !legacyAiChat) return false;
        const migrated = convertLegacyRemoteToPieces(legacyData || {}, legacyAiChat || []);
        for (const key of ['settings','keys','stories','memos','aiChat','assetsIndex']) {
            remote[key] = migrated[key];
            await putCloudPiece(headers, owner, repo, key, migrated[key]);
        }
        remote.metadata = migrated.metadata;
        await putCloudPiece(headers, owner, repo, 'metadata', migrated.metadata, remoteMeta.metadata?.sha || '');
        showToast('旧形式クラウドデータを新形式へ移行しました', 'success');
        return true;
    }

    function buildAttachmentIndex() {
        const items = [];
        const pick = (scope, ownerId, memoId, memo) => {
            (memo.attachments || []).forEach((a) => {
                items.push({ scope, ownerId, memoId, id: a.id, name: a.name, type: a.type, size: a.size || 0, createdAt: a.createdAt || Date.now(), githubPath: a.githubPath || null });
            });
        };
        state.chapters.forEach((ch, ci) => (ch.memos || []).forEach((m, mi) => pick('chapter', String(ci), String(mi), m)));
        (state.globalMemos || []).forEach((m, i) => pick('global', 'global', String(i), m));
        Object.entries(state.folderMemos || {}).forEach(([fid, bundle]) => (bundle.memos || []).forEach((m, i) => pick('folder', fid, String(i), m)));
        return { items, updatedAt: Date.now() };
    }
    function getCurrentMemoCloudKey() {
        if (state.memoScope === 'local') return { scope:'chapter', ownerId:String(state.currentIdx), memoId:String(state.chapters[state.currentIdx]?.currentMemoIdx || 0) };
        if (state.memoScope === 'folder') { const b = getCurrentFolderMemoBundle(); return { scope:'folder', ownerId: (state.currentFolderId && state.currentFolderId !== 'all') ? state.currentFolderId : 'root', memoId:String(b.currentMemoIdx || 0) }; }
        return { scope:'global', ownerId:'global', memoId:String(state.currentGlobalMemoIdx || 0) };
    }
    async function syncCurrentMemoAttachmentsFromCloud() {
        if (!navigator.onLine) return;
        const token = document.getElementById('gh-token')?.value?.trim();
        const parsedRepo = parseRepoTarget(state.ghRepo || '', undefined);
        if (!token || !parsedRepo) return;
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
        const url = `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/contents/${CLOUD_PATHS.assetsIndex}`;
        const res = await requestJson(url, { headers });
        if (!res.res.ok || !res.body?.content) return;
        const remote = fromBase64ToJson(res.body.content);
        if (!Array.isArray(remote?.items)) return;
        state.assetsIndex = { items: remote.items, updatedAt: remote.updatedAt || Date.now() };
        const key = getCurrentMemoCloudKey();
        const refs = remote.items.filter((x) => x.scope===key.scope && x.ownerId===key.ownerId && x.memoId===key.memoId);
        if (!refs.length) return;
        const memo = getCurrentMemo();
        memo.attachments = memo.attachments || [];
        const ids = new Set(memo.attachments.map((x)=>x.id));
        refs.forEach((r) => { if (!ids.has(r.id)) memo.attachments.push({ id:r.id, name:r.name, type:r.type, size:r.size, createdAt:r.createdAt, storage:'idb', githubPath:r.githubPath }); });
    }
    async function uploadAttachmentNow(ref) {
        if (!ref?.id) return;
        const token = document.getElementById('gh-token')?.value?.trim();
        const parsedRepo = parseRepoTarget(state.ghRepo || '', undefined);
        if (!token || !parsedRepo) return;
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
        const stored = await dbGet('attachments', ref.id);
        if (!stored?.data) return;
        const bytes = new Uint8Array(await (stored.data instanceof Blob ? stored.data.arrayBuffer() : new Blob([stored.data]).arrayBuffer()));
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const ext = (ref.name.includes('.') ? ref.name.slice(ref.name.lastIndexOf('.')) : '');
        const path = ref.githubPath || `kakudraft_assets/${ref.id}${ext}`;
        const apiUrl = `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/contents/${path}`;
        const oldRes = await requestJson(apiUrl, { headers });
        const body = { message: `asset: ${ref.name}`, content: btoa(binary) };
        if (oldRes.res.status === 200 && oldRes.body?.sha) body.sha = oldRes.body.sha;
        const putRes = await requestJson(apiUrl, { method:'PUT', headers, body: JSON.stringify(body) });
        if (!putRes.res.ok) throw new Error(putRes.body?.message || '添付アップロード失敗');
        ref.githubPath = path;
        state.assetsIndex = buildAttachmentIndex();
        await putCloudPiece(headers, parsedRepo.owner, parsedRepo.repo, 'assetsIndex', state.assetsIndex);
    }
    function buildTextBackupFiles() {
        const files = {};
        (state.chapters || []).forEach((ch, i) => {
            const cid = ch.id || `chapter_${i + 1}`;
            files[`話/${cid}/body.txt`] = ch.body || '';
            (ch.memos || []).forEach((m, mi) => { files[`話/${cid}/memo_${mi + 1}.txt`] = m.content || ''; });
        });
        (state.globalMemos || []).forEach((m, i) => { files[`メモ/global_${i + 1}.txt`] = m.content || ''; });
        Object.entries(state.folderMemos || {}).forEach(([fid, bundle]) => (bundle.memos || []).forEach((m, i) => { files[`メモ/folder_${fid}_${i + 1}.txt`] = m.content || ''; }));
        files['話/ai_chat.txt'] = (aiChatState || []).map((x) => `Q:${x.q || ''}\nA:${x.a || ''}`).join('\n\n----\n\n');
        return files;
    }
    function updateAIUsage(provider, responseJson) {
        const usage = responseJson?.usage || responseJson?.usageMetadata || null;
        if (!usage) return;
        state.aiUsage = state.aiUsage || {};
        state.aiUsage[provider] = Object.assign({ updatedAt: Date.now() }, usage);
        renderAIUsage();
    }
    function renderAIUsage() {
        const box = document.getElementById('ai-usage');
        if (!box) return;
        const items = Object.entries(state.aiUsage || {});
        box.innerHTML = items.map(([k,v]) => `<div class="config-item" style="display:block;"><div><strong>${escapeHtml(k)}</strong></div><div style="font-size:11px;opacity:.85;">${escapeHtml(JSON.stringify(v))}</div></div>`).join('') || '<div class="config-item">使用量情報なし</div>';
    }

    async function githubSync(mode) {
        save();
        const token = document.getElementById('gh-token').value.trim();
        const repoInput = state.ghRepo;
        if (!token || !repoInput) return showToast('GitHub設定（PAT / リポジトリ）を入力してください', 'error');
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
        try {
            const userRes = await requestJson('https://api.github.com/user', { headers });
            const parsedRepo = parseRepoTarget(repoInput, userRes.body?.login);
            if (!parsedRepo) throw new Error('リポジトリ形式が不正です');
            const { owner, repo } = parsedRepo;
            const pieces = buildCloudPieces();
            const remote = {};
            const remoteMeta = {};
            for (const [key, path] of Object.entries(CLOUD_PATHS)) {
                const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
                const got = await requestJson(url, { headers });
                if (got.res.status === 200 && got.body?.content) {
                    remoteMeta[key] = { sha: got.body.sha };
                    remote[key] = fromBase64ToJson(got.body.content);
                }
            }
            await migrateLegacyCloudIfNeeded(headers, owner, repo, remote, remoteMeta);
            if (mode === 'up') {
                let changed = 0;
                for (const [key, path] of Object.entries(CLOUD_PATHS)) {
                    if (key === 'metadata') continue;
                    const contentJson = JSON.stringify(pieces[key]);
                    if (JSON.stringify(remote[key] || null) === contentJson) continue;
                    const putBody = { message: `sync ${key}`, content: toBase64FromText(contentJson) };
                    if (remoteMeta[key]?.sha) putBody.sha = remoteMeta[key].sha;
                    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
                    const putRes = await requestJson(url, { method:'PUT', headers, body: JSON.stringify(putBody) });
                    if (!putRes.res.ok) throw new Error(putRes.body?.message || `${key}のアップロード失敗`);
                    changed++;
                }
                const meta = { updatedAt: Date.now(), files: Object.keys(pieces) };
                state.syncMeta = meta;
                const metaBody = { message: 'sync metadata', content: toBase64FromText(JSON.stringify(meta)) };
                if (remoteMeta.metadata?.sha) metaBody.sha = remoteMeta.metadata.sha;
                const metaUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_PATHS.metadata}`;
                await requestJson(metaUrl, { method:'PUT', headers, body: JSON.stringify(metaBody) });
                const txtFiles = buildTextBackupFiles();
                for (const [path, text] of Object.entries(txtFiles)) {
                    const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
                    const oldTxt = await requestJson(fileUrl, { headers });
                    const txtBody = { message: `txt backup ${path}`, content: toBase64FromText(text) };
                    if (oldTxt.res.status === 200 && oldTxt.body?.sha) txtBody.sha = oldTxt.body.sha;
                    await requestJson(fileUrl, { method:'PUT', headers, body: JSON.stringify(txtBody) });
                }
                await syncAttachmentsToGithub(headers, owner, repo);
                showToast(`アップロード成功（変更 ${changed} ファイル）`, 'success');
            } else {
                const hasRemote = ['settings','keys','stories','memos','aiChat','assetsIndex'].some((k)=>remote[k]);
                if (!hasRemote) return showToast('リモートにデータがありません。先にUPしてください。', 'error');
                if (!confirm('リモートデータで復元しますか？')) return;
                await addLocalSnapshot('before-download-local', structuredClone(state));
                applyCloudPieces(remote);
                state.syncMeta = remote.metadata || state.syncMeta;
                await persistNow();
                showToast('復元完了（更新のあるファイルのみ取得）', 'success');
                setTimeout(() => location.reload(), 400);
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
        const pane = document.getElementById('memo-attachment-preview'); if (pane) pane.style.display = 'none';
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
        ['favorites','chapters','settings','ai','backup','analytics'].forEach((name) => {
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
        const options = [`<option value="all">すべてのタグ</option>`].concat((state.folders || []).map((f)=>`<option value="${f.id}">${f.name}</option>`));
        sel.innerHTML = options.join('');
        sel.value = state.currentFolderId || 'all';
    }
    function addFolder() {
        const name = (document.getElementById('new-folder-name').value || '').trim();
        if (!name) return;
        const id = `f_${Date.now().toString(36)}`;
        state.folders.push({id, name});
        state.folderMemos[id] = { memos:[{name:'タグメモ', content:'', attachments:[]}], currentMemoIdx:0 };
        document.getElementById('new-folder-name').value = '';
        state.currentFolderId = id;
        refreshUI(); save();
    }
    function changeFolderFilter(folderId) { state.currentFolderId = folderId || 'all'; refreshUI(); save(); }
    function renameCurrentFolder() {
        if (!state.currentFolderId || state.currentFolderId === 'all') return showToast('特定タグを選択してください', 'error');
        const target = state.folders.find((f)=>f.id===state.currentFolderId);
        if (!target) return;
        const name = prompt('タグ名', target.name);
        if (!name) return;
        target.name = name.trim();
        refreshUI(); save();
    }
    function getCurrentFolderMemoBundle() {
        const fid = state.currentFolderId && state.currentFolderId !== 'all' ? state.currentFolderId : 'root';
        if (!state.folderMemos[fid]) state.folderMemos[fid] = { memos:[{name:'タグメモ', content:'', attachments:[]}], currentMemoIdx:0 };
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
    async function renderMemoAttachments() {
        const box = document.getElementById('memo-attachments');
        if (!box) return;
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        await syncCurrentMemoAttachmentsFromCloud();
        const files = memo?.attachments || [];
        box.innerHTML = files.map((f, i) => `<div class="config-item"><span class="material-icons" style="font-size:16px;">${f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audiotrack' : f.type.startsWith('video/') ? 'movie' : 'description'}</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis;">${f.name}</span><button onclick="previewMemoAttachment(${i})"><span class="material-icons" style="font-size:16px;">preview</span></button><button onclick="downloadMemoAttachment(${i})"><span class="material-icons" style="font-size:16px;">download</span></button><button onclick="removeMemoAttachment(${i})"><span class="material-icons" style="font-size:16px;">delete</span></button></div>`).join('') || '<div class="config-item">添付なし</div>';
    }
    async function attachMemoFile(file) {
        if (!file) return;
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        if (!memo.attachments) memo.attachments = [];
        const data = file.type.startsWith('text/') || file.name.endsWith('.txt') ? await file.text() : file;
        const ref = await storeAttachmentBlob(file, data);
        memo.attachments.push(ref);
        state.assetsIndex = buildAttachmentIndex();
        try { await uploadAttachmentNow(ref); } catch (e) { console.warn(e); }
        document.getElementById('memo-attach-input').value = '';
        renderMemoAttachments();
        await previewMemoAttachment(memo.attachments.length - 1);
        save();
    }
    async function previewMemoAttachment(i) {
        const pane = document.getElementById('memo-attachment-preview');
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        const ref = memo?.attachments?.[i];
        if (!ref || !pane) return;
        const stored = await getAttachmentData(ref);
        if (!stored) return showToast('添付データを取得できませんでした', 'error');
        pane.style.display = 'block';
        if ((ref.type || '').startsWith('image/')) {
            const url = URL.createObjectURL(stored.data);
            pane.innerHTML = `<div class="config-item" style="display:block;"><div style="display:flex;justify-content:space-between;align-items:center;"><strong>${ref.name}</strong><button onclick="closeMemoAttachmentPreview()"><span class="material-icons" style="font-size:16px;">close</span></button></div><img class="attachment-preview-media" src="${url}"></div>`;
        } else if ((ref.type || '').startsWith('audio/')) {
            const url = URL.createObjectURL(stored.data);
            pane.innerHTML = `<div class="config-item" style="display:block;"><div style="display:flex;justify-content:space-between;align-items:center;"><strong>${ref.name}</strong><button onclick="closeMemoAttachmentPreview()"><span class="material-icons" style="font-size:16px;">close</span></button></div><audio class="attachment-preview-media" controls src="${url}"></audio></div>`;
        } else if ((ref.type || '').startsWith('video/')) {
            const url = URL.createObjectURL(stored.data);
            pane.innerHTML = `<div class="config-item" style="display:block;"><div style="display:flex;justify-content:space-between;align-items:center;"><strong>${ref.name}</strong><button onclick="closeMemoAttachmentPreview()"><span class="material-icons" style="font-size:16px;">close</span></button></div><video class="attachment-preview-media" controls src="${url}"></video></div>`;
        } else {
            const text = typeof stored.data === 'string' ? stored.data : await stored.data.text();
            pane.innerHTML = `<div class="config-item" style="display:block;"><div style="display:flex;justify-content:space-between;align-items:center;"><strong>${ref.name}</strong><button onclick="closeMemoAttachmentPreview()"><span class="material-icons" style="font-size:16px;">close</span></button></div><pre class="preview-text">${(text || '').replace(/[&<>]/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]))}</pre></div>`;
        }
    }
    function closeMemoAttachmentPreview() {
        const pane = document.getElementById('memo-attachment-preview');
        if (!pane) return;
        pane.style.display = 'none';
        pane.innerHTML = '';
    }
    async function downloadMemoAttachment(i) {
        const memo = getCurrentMemo();
        const ref = memo?.attachments?.[i];
        if (!ref) return;
        const blobData = await getAttachmentData(ref);
        if (!blobData?.data) return showToast('添付の取得に失敗しました', 'error');
        const blob = blobData.data instanceof Blob ? blobData.data : new Blob([blobData.data], { type: ref.type || 'application/octet-stream' });
        triggerDownload(blob, ref.name || 'attachment.bin');
    }
    async function removeMemoAttachment(i) {
        const ctx = getCurrentMemoContext();
        const memo = ctx.memos[ctx.owner[ctx.idxKey]];
        const ref = memo?.attachments?.[i];
        if (!memo?.attachments) return;
        memo.attachments.splice(i, 1);
        if (ref?.id) await dbDelete('attachments', ref.id);
        state.assetsIndex = buildAttachmentIndex();
        const pane = document.getElementById('memo-attachment-preview');
        if (pane) pane.style.display = 'none';
        renderMemoAttachments(); save();
    }
    function refreshUI() {
        renderFolderFilter();
        const visible = getVisibleChapterIndexes();
        document.getElementById('chapter-list').innerHTML = visible.map((i) => { const ch = state.chapters[i]; return `<div class="chapter-item ${i === state.currentIdx ? 'active' : ''}"><button style="flex:1; text-align:left; background:transparent; border:none; color:var(--text); cursor:pointer;" onclick="switchChapter(${i})">${ch.title}<small style=\"opacity:.6; margin-left:6px;\">[${(state.folders.find(f=>f.id===ch.folderId)||{name:'既定タグ'}).name}]</small></button><button onclick="renameChapter(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>edit</span></button><button onclick="moveChapter(${i},-1)" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>arrow_upward</span></button><button onclick="moveChapter(${i},1)" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>arrow_downward</span></button><button onclick="cycleChapterFolder(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>folder</span></button><button onclick="deleteChapter(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:16px;'>close</span></button></div>`; }).join('');
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
    function toggleSearchPanel(forceOpen = false, forceClose = false) {
        const p = document.getElementById('search-panel');
        if (forceClose) p.style.display = 'none';
        else p.style.display = (forceOpen || p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
        if (p.style.display === 'block') {
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
    function switchAITab(tab) {
        const mode = tab === 'proofread' ? 'proofread' : 'chat';
        state.aiTab = mode;
        const chatTab = document.getElementById('ai-tab-chat');
        const proofTab = document.getElementById('ai-tab-proofread');
        const chatPanel = document.getElementById('ai-panel-chat');
        const proofPanel = document.getElementById('ai-panel-proofread');
        if (chatTab) chatTab.classList.toggle('active', mode === 'chat');
        if (proofTab) proofTab.classList.toggle('active', mode === 'proofread');
        if (chatPanel) chatPanel.style.display = mode === 'chat' ? 'flex' : 'none';
        if (proofPanel) proofPanel.style.display = mode === 'proofread' ? 'flex' : 'none';
        const scope = document.getElementById('ai-scope')?.value || 'chapter';
        const proofScope = document.getElementById('ai-scope-proofread');
        if (proofScope) proofScope.value = scope;
        queuePersist();
    }
    function openAISettings() {
        togglePanel('menu-panel');
        switchMenuTab('ai');
    }
    async function onAIProviderChange() {
        const nextProvider = document.getElementById('ai-provider')?.value || 'openrouter';
        state.aiProvider = nextProvider;
        const offline = !navigator.onLine;
        const note = document.getElementById('ai-offline-note');
        if (note) note.style.display = offline ? 'flex' : 'none';
        ['openrouter', 'groq', 'google'].forEach((provider) => {
            const el = document.getElementById(getAIKeyInputId(provider));
            if (!el) return;
            el.disabled = offline;
            el.parentElement.style.display = provider === nextProvider ? 'flex' : 'none';
        });
        const freeOnly = document.getElementById('ai-free-only');
        if (freeOnly) freeOnly.disabled = offline || nextProvider !== 'openrouter';
        const freeOnlyRow = document.getElementById('ai-free-only-row');
        if (freeOnlyRow) freeOnlyRow.style.display = nextProvider === 'openrouter' ? 'flex' : 'none';
        ['ai-model', 'ai-prompt', 'ai-proofread-prompt', 'ai-scope', 'ai-scope-proofread', 'ai-send-chat', 'ai-send-proofread', 'ai-chat-clear-btn'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = offline || aiBusy;
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
    function getValidAppOrigin() {
        const o = location.origin;
        if (!o || o === 'null' || o === 'file://') return 'https://kakudraft.local';
        return o;
    }
    function buildProviderHeaders(provider, key, withJson = true) {
        const headers = {};
        if (withJson) headers['Content-Type'] = 'application/json';
        if (provider === 'google') {
            headers['x-goog-api-key'] = key;
            return headers;
        }
        headers.Authorization = `Bearer ${key}`;
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = getValidAppOrigin();
            headers['X-Title'] = 'KakuDraft';
        }
        return headers;
    }
    async function fetchAIModels() {
        if (!navigator.onLine) return showToast('オフライン中は利用できません', 'error');
        const provider = document.getElementById('ai-provider').value;
        const key = document.getElementById(getAIKeyInputId(provider))?.value.trim() || '';
        const freeOnly = !!document.getElementById('ai-free-only')?.checked;
        if (!key) return showToast('AI API Keyを入力してください', 'error');
        try {
            let models = [];
            if (provider === 'openrouter') {
                const r = await fetch('https://openrouter.ai/api/v1/models', {
                    headers: buildProviderHeaders('openrouter', key, false)
                });
                const j = await r.json();
                const openrouterModels = (j.data || []);
                models = (freeOnly ? openrouterModels.filter((m) => Number(m?.pricing?.prompt || 0) === 0 && Number(m?.pricing?.completion || 0) === 0) : openrouterModels).map((m) => m.id);
            } else if (provider === 'groq') {
                const r = await fetch('https://api.groq.com/openai/v1/models', { headers: buildProviderHeaders('groq', key, false) });
                const j = await r.json();
                models = (j.data || []).map((m) => m.id);
            } else {
                const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
                    headers: buildProviderHeaders('google', key, false)
                });
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
        const key = document.getElementById(getAIKeyInputId(provider))?.value.trim() || '';
        const model = document.getElementById('ai-model').value.trim();
        if (!key || !model) throw new Error('APIキーとモデルを設定してください');
        let r;
        let j;
        if (provider === 'google') {
            const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
            const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
            r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
                method: 'POST', headers: buildProviderHeaders('google', key), body: JSON.stringify(body)
            });
            j = await r.json();
            if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
            const text = j.candidates?.[0]?.content?.parts?.map((p)=>p.text || '').join('') || '';
            if (!text.trim()) throw new Error('AI応答が空でした。モデル設定や利用制限を確認してください。');
            updateAIUsage('google', j);
            return text;
        }
        const base = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
        const body = { model, messages, temperature: 0.4 };
        if (jsonMode) body.response_format = { type: 'json_object' };
        const headers = buildProviderHeaders(provider, key);
        r = await fetch(base, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        const content = j.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p)=>p.text || '').join('') : '';
        if (!text.trim()) throw new Error('AI応答が空でした。モデル設定や利用制限を確認してください。');
        updateAIUsage(provider, j);
        return text;
    }
    async function sendAIChat() {
        if (aiBusy) return;
        const promptEl = document.getElementById('ai-prompt');
        try {
            const prompt = promptEl.value.trim();
            if (!prompt) return showToast('AIへの指示を入力してください', 'error');
            promptEl.value = '';
            setAIBusy(true);
            const scopeText = getAIScopeText();
            const ans = await callAI([
                { role: 'system', content: 'あなたは日本語小説執筆を支援するアシスタントです。簡潔で実用的に答えてください。' },
                { role: 'user', content: `対象テキスト:
${scopeText.slice(0, 12000)}

指示:
${prompt}` }
            ], false);
            aiChatState = aiChatState || [];
            aiChatState.push({ q: prompt, a: ans, at: Date.now() });
            aiChatState = aiChatState.slice(-100);
            renderAIChatLog();
        renderAIUsage();
            showToast('AIチャット応答を取得しました', 'success');
            save();
        } catch (e) {
            showToast(`AIチャット失敗: ${e.message}`, 'error');
        } finally {
            setAIBusy(false);
            queuePersist();
        }
    }

    async function runAIProofread() {
        if (aiBusy) return;
        try {
            setAIBusy(true);
            const scopeText = getAIScopeText();
            const userPrompt = document.getElementById('ai-proofread-prompt').value.trim() || '誤字脱字・不自然表現・表記揺れを校閲してください';
            const text = await callAI([
                { role: 'system', content: '出力はJSONのみ。{replacements:[{from,to,reason}]} 形式で返してください。' },
                { role: 'user', content: `対象:
${scopeText.slice(0, 12000)}

要件:${userPrompt}` }
            ], true);
            let data;
            try { data = JSON.parse(text); } catch { data = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"replacements":[]}'); }
            const reps = data.replacements || [];
            state.lastAISuggestions = reps;
            renderAISuggestions();
            showToast(`校閲候補 ${reps.length} 件`, 'success');
        } catch (e) {
            showToast(`AI校閲失敗: ${e.message}`, 'error');
        } finally {
            setAIBusy(false);
        }
    }

    function applyAISuggestion(i) {
        const r = (state.lastAISuggestions || [])[i];
        if (!r) return;
        editor.value = editor.value.split(r.from).join(r.to);
        state.lastAISuggestions.splice(i, 1);
        renderAISuggestions();
        save(); updateHighlight(); updateStats();
        showToast(`置換適用: ${r.from} → ${r.to}`, 'success');
    }
    function ignoreAISuggestion(i) {
        if (!state.lastAISuggestions) return;
        state.lastAISuggestions.splice(i, 1);
        renderAISuggestions();
        showToast('この置き換えを無視しました', 'success');
    }
    function renderAISuggestions() {
        const reps = state.lastAISuggestions || [];
        document.getElementById('ai-suggestions').innerHTML = reps.map((r, i) => `<div class="config-item" style="align-items:flex-start;"><div style="flex:1;"><div><strong>${escapeHtml(r.from || '')}</strong> → <strong>${escapeHtml(r.to || '')}</strong></div><div style="font-size:11px;opacity:.8;">${escapeHtml(r.reason || '')}</div></div><button onclick="applyAISuggestion(${i})" title="適用"><span class="material-icons" style="font-size:16px;">published_with_changes</span></button><button onclick="ignoreAISuggestion(${i})" title="この置き換えは無視"><span class="material-icons" style="font-size:16px;">block</span></button></div>`).join('') || '<div class="config-item">候補なし</div>';
    }
    function escapeHtml(text) {
        return (text || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }
    function renderMarkdown(text) {
        const src = String(text || '').replace(/\r\n/g, '\n');
        const lines = src.split('\n');
        const out = [];
        let inUl = false; let inOl = false; let inCode = false; let tableRows = [];
        const inline = (v) => escapeHtml(v)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        const flush = () => {
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (tableRows.length) {
                const head = tableRows[0] || [];
                const body = tableRows.slice(1);
                out.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
                tableRows = [];
            }
        };
        for (const line of lines) {
            if (line.trim().startsWith('```')) { flush(); out.push(inCode ? '</code></pre>' : '<pre><code>'); inCode = !inCode; continue; }
            if (inCode) { out.push(escapeHtml(line) + '\n'); continue; }
            if (line.includes('|')) {
                const cols = line.split('|').map((x) => x.trim()).filter((_, i, arr) => !(i === 0 && arr[0] === '') && !(i === arr.length - 1 && arr[arr.length - 1] === '')).map(inline);
                if (cols.length >= 2 && !/^[-:|\s]+$/.test(line.trim())) { tableRows.push(cols); continue; }
                if (/^[-:|\s]+$/.test(line.trim()) && tableRows.length) continue;
            }
            let m;
            if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (!inUl) { flush(); out.push('<ul>'); inUl = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
            if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (!inOl) { flush(); out.push('<ol>'); inOl = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
            flush();
            if ((m = line.match(/^\s*#+\s+(.*)$/))) { out.push(`<h3>${inline(m[1])}</h3>`); continue; }
            if (line.trim()) out.push(`<p>${inline(line)}</p>`);
        }
        flush();
        if (inCode) out.push('</code></pre>');
        return out.join('');
    }
    function clearAIChatHistory() {
        aiChatState = [];
        renderAIChatLog();
        renderAIUsage();
        queuePersist();
        showToast('AIチャット履歴を削除しました', 'success');
    }
    function renderAIChatLog() {
        const log = document.getElementById('ai-chat-log');
        if (!log) return;
        const rows = (aiChatState || []).map((x) => `<div class="config-item" style="display:block;"><div><strong>あなた:</strong></div><div class="md-content">${renderMarkdown(x.q || '')}</div><div><strong>AI:</strong></div><div class="md-content">${renderMarkdown(x.a || '')}</div></div>`);
        if (aiBusy) rows.push(`<div class="config-item" style="display:block;"><div><strong>AI:</strong></div><div class="md-content">AIが思考中${'.'.repeat(aiThinkingDots)}</div></div>`);
        log.innerHTML = rows.join('') || '<div class="config-item">会話履歴はありません</div>';
        log.scrollTop = log.scrollHeight;
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
            const folderName = (state.folders.find((f)=>f.id===chapter.folderId)||{name:'既定タグ'}).name;
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
    function bindEnterShortcut(el, action) {
        if (!el) return;
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            action();
        });
    }
    bindEnterShortcut(document.getElementById('ai-prompt'), sendAIChat);
    bindEnterShortcut(document.getElementById('ai-proofread-prompt'), runAIProofread);
    bindEnterShortcut(document.getElementById('search-query'), findNext);
    bindEnterShortcut(document.getElementById('replace-query'), findNext);
    document.getElementById('ai-scope')?.addEventListener('change', (e) => {
        const proofScope = document.getElementById('ai-scope-proofread');
        if (proofScope) proofScope.value = e.target.value;
        save();
    });
    document.getElementById('ai-scope-proofread')?.addEventListener('change', (e) => {
        const scope = document.getElementById('ai-scope');
        if (scope) scope.value = e.target.value;
        save();
    });
    ['openrouter', 'groq', 'google'].forEach((provider) => {
        document.getElementById(getAIKeyInputId(provider))?.addEventListener('input', queuePersist);
    });
    document.getElementById('ai-free-only')?.addEventListener('change', () => {
        state.aiFreeOnly = !!document.getElementById('ai-free-only')?.checked;
        queuePersist();
    });
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
