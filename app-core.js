/* ===================================================================
 *  KakuDraft - app-core.js
 *  Global state, constants, DOM refs, crypto, state management
 * =================================================================== */

// === DOM References & Constants ===
const editor = document.getElementById('editor');
const memoArea = document.getElementById('memo-area');
const hl = document.getElementById('line-highlight');
const toastEl = document.getElementById('toast');

const DB_NAME = 'kakudraft-db';
const DB_VERSION = 2;
const STATE_KEY = 'app-state';
const LEGACY_STORAGE_KEY = 'kaku_v_pro_sync';
const AI_CHAT_KEY = 'ai-chat';

const CLOUD_PATHS = {
    settings: '設定/settings.json',
    keys: 'キー類/keys.json',
    stories: '話/chapter_index.json',
    memos: 'メモ/memos.json',
    aiChat: '話/ai_chat.json',
    metadata: '設定/sync_metadata.json',
    assetsIndex: '設定/assets_index.json'
};
const LEGACY_CLOUD_PATHS = { data: 'kakudraft_data.json', aiChat: 'kakudraft_ai_chat.json' };

// === Global State ===
let state = {
    chapters: [{ title: "第一話", body: "", memos: [{name: "メモ", content: "", attachments: []}], currentMemoIdx: 0, snapshots: [], tags: ['root'] }],
    currentIdx: 0,
    globalMemos: [{name: "共通設定", content: "", attachments: []}],
    currentGlobalMemoIdx: 0,
    memoScope: 'local',
    replaceRules: [{from: "!!", to: "！！"}],
    insertButtons: [{label: "ルビ", value: "|《》"}, {label: "強調", value: "《》"}, {label: "「", value: "「"}],
    fontSize: 18, theme: "light",
    ghTokenEnc: "", ghTokenLegacy: "", ghRepo: "", deviceName: "",
    menuTab: 'favorites',
    favoriteActionKeys: ['sync-up','take-snapshot','toggle-theme'],
    fontFamily: "'Sawarabi Mincho', serif",
    writingSessions: [],
    folders: [{id:'root',name:'既定タグ'}],
    currentFolderId: 'all',
    folderMemos: {root:{memos:[{name:'タグメモ',content:'',attachments:[]}], currentMemoIdx:0}},
    favoriteEditMode: false,
    keepScreenOn: false,
    aiProvider: 'openrouter', aiKeyEnc: '', aiKeysEnc: {}, aiModel: '', aiTab: 'chat', aiFreeOnly: false, aiUsage: {},
    syncMeta: {}, assetsIndex: {items:[]}
};

let aiChatState = [];
let aiBusy = false;
let aiThinkingDots = 1;
let aiThinkingTimer = null;
let wakeLockHandle = null;
let deferredInstallPrompt = null;

// Timers
let syncTimer, toastTimer, persistTimer;

// === Google Fonts Config (only cache used fonts) ===
const GOOGLE_FONTS_MAP = {
    "'Noto Serif JP', serif": { url: 'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&display=swap', name: 'Noto Serif JP' },
    "'Noto Sans JP', sans-serif": { url: 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap', name: 'Noto Sans JP' },
    "'M PLUS 1p', sans-serif": { url: 'https://fonts.googleapis.com/css2?family=M+PLUS+1p:wght@400;700&display=swap', name: 'M PLUS 1p' },
    "'Sawarabi Mincho', serif": { url: 'https://fonts.googleapis.com/css2?family=Sawarabi+Mincho&display=swap', name: 'Sawarabi Mincho' },
    "'Haptic', serif": { url: 'https://fonts.googleapis.com/css2?family=Haptic:wght@400;700&display=swap', name: 'Haptic' },
    "'Kaisei Opti', serif": { url: 'https://fonts.googleapis.com/css2?family=Kaisei+Opti:wght@400;700&display=swap', name: 'Kaisei Opti' },
    "'Kokoro', serif": { url: 'https://fonts.googleapis.com/css2?family=Kokoro:wght@400;700&display=swap', name: 'Kokoro' },
    "'Shippori Mincho', serif": { url: 'https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;700&display=swap', name: 'Shippori Mincho' },
    "'Zen Maru Gothic', sans-serif": { url: 'https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@400;700&display=swap', name: 'Zen Maru Gothic' }
};

// === Service Worker registration ===
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).then((registration) => {
            if (registration.waiting) showToast('アプリ更新があります。設定から「PWA更新適用」を実行してください。', 'success');
            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        showToast('新しいバージョンを取得しました。設定から「PWA更新適用」を実行できます。', 'success');
                    }
                });
            });
        }).catch(() => {
            showToast('Service Worker 登録に失敗しました。', 'error');
        });
    });
}

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    showToast('インストール可能です。お気に入りから「PWAをインストール」を選択してください。', 'success');
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    showToast('アプリをインストールしました。', 'success');
});

async function promptPWAInstall() {
    if (!deferredInstallPrompt) {
        showToast('この環境ではインストールプロンプトを表示できません。', 'error');
        return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choice?.outcome === 'accepted') showToast('インストールを開始しました。', 'success');
    else showToast('インストールをキャンセルしました。', 'error');
}

async function applyPWAUpdate() {
    if (!('serviceWorker' in navigator)) {
        showToast('このブラウザはPWA更新に未対応です。', 'error');
        return;
    }
    const registration = await navigator.serviceWorker.getRegistration('./');
    if (!registration) {
        showToast('Service Worker が未登録です。', 'error');
        return;
    }
    await registration.update();
    if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        showToast('更新を適用して再読み込みします。', 'success');
        setTimeout(() => location.reload(), 300);
        return;
    }
    showToast('更新はありません。', 'success');
}

// === Crypto functions ===
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
    return btoa(JSON.stringify({ iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) }));
}

async function decryptPatToken(payloadB64, deviceName) {
    if (!payloadB64 || !window.crypto?.subtle) return '';
    try {
        const payload = JSON.parse(atob(payloadB64));
        const key = await deriveTokenKey(deviceName);
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(payload.iv) }, key, new Uint8Array(payload.data)
        );
        return new TextDecoder().decode(decrypted);
    } catch { return ''; }
}

// === Normalization functions ===
function normalizeAttachment(a) {
    return {
        id: a.id || '', name: a.name || 'file', type: a.type || 'application/octet-stream',
        size: a.size || 0, createdAt: a.createdAt || Date.now(),
        storage: a.storage || 'inline', githubPath: a.githubPath || null,
        data: typeof a.data === 'string' ? a.data : undefined
    };
}

function normalizeMemo(m, fallbackName) {
    return {
        name: m.name || fallbackName || 'メモ',
        content: m.content || '',
        attachments: (m.attachments || []).map(normalizeAttachment)
    };
}

function normalizeStateShape(raw) {
    const next = Object.assign({}, state, raw || {});

    next.chapters = (next.chapters || []).map((ch, idx) => {
        let tags = ch.tags;
        if (!Array.isArray(tags)) {
            tags = (ch.folderId && ch.folderId !== 'root' && ch.folderId !== 'all') ? [ch.folderId] : ['root'];
        }
        if (!tags.length) tags = ['root'];
        const validTags = tags.filter(tagId => tagId === 'root' || (next.folders && next.folders.some(f => f.id === tagId)));
        if (!validTags.length) validTags.push('root');
        return {
            title: ch.title || `第${idx + 1}話`, body: ch.body || '',
            memos: (ch.memos?.length ? ch.memos : [{name:'メモ', content:''}]).map(m => normalizeMemo(m, 'メモ')),
            currentMemoIdx: Number.isInteger(ch.currentMemoIdx) ? ch.currentMemoIdx : 0,
            snapshots: ch.snapshots || [], tags: validTags
        };
    });
    if (!next.chapters.length) next.chapters = [{title:'第一話', body:'', memos:[{name:'メモ', content:''}], currentMemoIdx:0, snapshots:[], tags:['root']}];

    next.folders = next.folders?.length ? next.folders : [{id:'root',name:'既定タグ'}];
    if (!next.folders.some(f => f.id === 'root')) next.folders.unshift({id:'root',name:'既定タグ'});
    next.currentFolderId = next.currentFolderId || 'all';

    if (!['local', 'folder', 'global'].includes(next.memoScope)) next.memoScope = 'local';

    next.globalMemos = (next.globalMemos?.length ? next.globalMemos : [{name:'共通設定', content:'', attachments:[]}]).map(m => normalizeMemo(m, '共通設定'));
    next.folderMemos = (next.folderMemos && typeof next.folderMemos === 'object') ? next.folderMemos : {};
    (next.folders || []).forEach(folder => {
        if (!next.folderMemos[folder.id]) next.folderMemos[folder.id] = { memos:[{name:'タグメモ',content:'',attachments:[]}], currentMemoIdx:0 };
    });
    Object.keys(next.folderMemos).forEach(k => {
        const bundle = next.folderMemos[k] || { memos:[{name:'タグメモ',content:'',attachments:[]}], currentMemoIdx:0 };
        bundle.memos = (bundle.memos?.length ? bundle.memos : [{name:'タグメモ',content:'',attachments:[]}]).map(m => normalizeMemo(m, 'タグメモ'));
        bundle.currentMemoIdx = Math.min(Math.max(Number.isInteger(bundle.currentMemoIdx) ? bundle.currentMemoIdx : 0, 0), bundle.memos.length - 1);
        next.folderMemos[k] = bundle;
    });

    next.aiKeysEnc = (next.aiKeysEnc && typeof next.aiKeysEnc === 'object') ? next.aiKeysEnc : {};
    if (next.aiKeyEnc && !next.aiKeysEnc[next.aiProvider || 'openrouter']) next.aiKeysEnc[next.aiProvider || 'openrouter'] = next.aiKeyEnc;
    next.aiTab = next.aiTab === 'proofread' ? 'proofread' : 'chat';
    next.aiFreeOnly = !!next.aiFreeOnly;
    next.aiUsage = (next.aiUsage && typeof next.aiUsage === 'object') ? next.aiUsage : {};
    next.syncMeta = (next.syncMeta && typeof next.syncMeta === 'object') ? next.syncMeta : {};
    next.assetsIndex = (next.assetsIndex && Array.isArray(next.assetsIndex.items)) ? next.assetsIndex : {items:[]};

    next.currentIdx = Math.min(Math.max(Number.isInteger(next.currentIdx) ? next.currentIdx : 0, 0), next.chapters.length - 1);
    next.currentGlobalMemoIdx = Math.min(Math.max(Number.isInteger(next.currentGlobalMemoIdx) ? next.currentGlobalMemoIdx : 0, 0), next.globalMemos.length - 1);
    next.chapters = next.chapters.map(ch => ({
        ...ch,
        currentMemoIdx: Math.min(Math.max(Number.isInteger(ch.currentMemoIdx) ? ch.currentMemoIdx : 0, 0), Math.max((ch.memos?.length || 1) - 1, 0))
    }));
    return next;
}

// === UI Toast ===
function showToast(message, type = 'info') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `${type ? type + ' ' : ''}show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ''; }, 2800);
}

function showProgressToast(label, current, total) {
    if (!toastEl) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    toastEl.innerHTML = `<div>${escapeHtml(label)}</div>` +
        `<div class="toast-progress-wrap"><div class="toast-progress-bar"><div class="toast-progress-fill" style="width:${pct}%"></div></div>` +
        `<div class="toast-progress-label">${current} / ${total}</div></div>`;
    toastEl.className = 'progress show';
    clearTimeout(toastTimer);
}

function hideProgressToast() {
    if (!toastEl) return;
    toastEl.className = '';
    toastEl.innerHTML = '';
}

// === Utility functions ===
function closePanels() {
    document.querySelectorAll('.side-panel').forEach(el => el.classList.remove('open'));
}

function sanitizeFileName(name) {
    return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_');
}

function escapeHtml(text) {
    return (text || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function createUtf8TextBlob(text) {
    return new Blob(['\uFEFF', text || ''], { type: 'text/plain;charset=utf-8' });
}

function createUtf8BytesWithBom(text) {
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const body = new TextEncoder().encode(text || '');
    const bytes = new Uint8Array(bom.length + body.length);
    bytes.set(bom, 0); bytes.set(body, bom.length);
    return bytes;
}

function triggerDownload(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

async function requestJson(url, options = {}) {
    const res = await fetch(url, options);
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { res, body };
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

function getStateWithoutAIChat() {
    const clone = structuredClone(state);
    delete clone.aiChat;
    return clone;
}

function setAIBusy(nextBusy) {
    aiBusy = nextBusy;
    aiThinkingDots = 1;
    clearInterval(aiThinkingTimer);
    if (aiBusy) {
        aiThinkingTimer = setInterval(() => { aiThinkingDots = (aiThinkingDots % 3) + 1; renderAIChatLog(); }, 300);
    }
    document.getElementById('ai-chat-area').classList.toggle('thinking', aiBusy);
}
