/* ===================================================================
 *  KakuDraft - app-ui.js
 *  Main UI, favorites, download, export, initialization
 * =================================================================== */

// === UI Menu Tab ===
function applyMenuTab(tab) {
    const activeTab = tab || 'favorites';
    document.querySelectorAll('#menu-tabs .tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === activeTab);
    });
    document.querySelectorAll('.menu-tab-panel').forEach(el => {
        el.style.display = el.id === `menu-tab-${activeTab}` ? 'block' : 'none';
    });
}

function switchMenuTab(tab) {
    state.menuTab = tab || 'favorites';
    applyMenuTab(state.menuTab);
    save();
}

function renderFavorites() {
    const box = document.getElementById('favorite-actions');
    if (!box) return;
    const orderList = document.getElementById('favorite-order-list');
    const selector = document.getElementById('favorite-selector');
    const actions = {
        'sync-up': { label: 'UP', icon: 'cloud_upload', run: "githubSync('up')" },
        'sync-down': { label: 'DOWN', icon: 'cloud_download', run: "githubSync('down')" },
        'take-snapshot': { label: 'スナップショット', icon: 'save', run: 'takeBodySnapshot()' },
        'toggle-theme': { label: 'テーマ切替', icon: 'dark_mode', run: 'toggleTheme()' },
        'fetch-snapshots': { label: 'スナップショット一覧', icon: 'history', run: 'fetchGithubSnapshots()' },
        'install-pwa': { label: 'PWAをインストール', icon: 'download_for_offline', run: 'promptPWAInstall()' },
        'apply-pwa-update': { label: 'PWA更新適用', icon: 'system_update_alt', run: 'applyPWAUpdate()' },
    };
    box.innerHTML = (state.favoriteActionKeys || []).map((key, i) => {
        const action = actions[key];
        if (!action) return '';
        return `<div class="favorite-action-item"><button class="fav-btn" onclick="${action.run}" title="${escapeHtml(action.label)}"><span class="material-icons">${action.icon}</span><span class="fav-label">${escapeHtml(action.label)}</span></button>${state.favoriteEditMode ? `<button style="position:absolute;top:-6px;right:-6px;padding:0;width:20px;height:20px;background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="state.favoriteActionKeys.splice(${i},1);renderFavorites();save();">✕</button>` : ''}</div>`;
    }).join('');

    if (orderList) {
        orderList.innerHTML = (state.favoriteActionKeys || []).map((key, i) => {
            const action = actions[key];
            if (!action) return '';
            return `<div class="config-item"><span style="flex:1;">${escapeHtml(action.label)}</span><button onclick="moveFavoriteAction(${i},-1)" title="上"><span class="material-icons" style="font-size:18px;">arrow_upward</span></button><button onclick="moveFavoriteAction(${i},1)" title="下"><span class="material-icons" style="font-size:18px;">arrow_downward</span></button></div>`;
        }).join('') || '<div class="config-item">お気に入り未登録</div>';
    }

    if (selector) {
        selector.innerHTML = Object.entries(actions).map(([key, action]) => {
            const checked = (state.favoriteActionKeys || []).includes(key) ? 'checked' : '';
            return `<label class="config-item" style="cursor:pointer;"><input type="checkbox" ${checked} onchange="toggleFavoriteAction('${key}', this.checked)"><span style="flex:1;">${escapeHtml(action.label)}</span><span class="material-icons" style="font-size:18px;">${action.icon}</span></label>`;
        }).join('');
    }
}

function toggleFavoriteAction(key, checked) {
    if (checked) {
        if (!state.favoriteActionKeys.includes(key)) state.favoriteActionKeys.push(key);
    } else {
        const idx = state.favoriteActionKeys.indexOf(key);
        if (idx >= 0) state.favoriteActionKeys.splice(idx, 1);
    }
    renderFavorites(); save();
}

function moveFavoriteAction(i, delta) {
    if (i + delta < 0 || i + delta >= state.favoriteActionKeys.length) return;
    [state.favoriteActionKeys[i], state.favoriteActionKeys[i + delta]] = [state.favoriteActionKeys[i + delta], state.favoriteActionKeys[i]];
    renderFavorites(); save();
}

function toggleFavoriteEditMode() { state.favoriteEditMode = !state.favoriteEditMode; refreshUI(); save(); }

// === Font Management ===
async function changeFontFamily(fontValue) {
    if (!navigator.onLine) return showToast('フォント変更はオンライン時のみ利用できます。', 'error');
    state.fontFamily = fontValue;
    document.documentElement.style.setProperty('--writing-font', fontValue);
    save();
    await cacheFontAssets(fontValue);
    showToast('フォントを変更しました（オフライン用キャッシュを試行）', 'success');
}

window.addEventListener('online', updateOnlineFontUI);
window.addEventListener('offline', updateOnlineFontUI);

// === Wake Lock ===
async function toggleWakeLock(on) {
    state.keepScreenOn = !!on;
    try {
        if (!('wakeLock' in navigator)) throw new Error('未対応ブラウザ');
        if (on) {
            wakeLockHandle = await navigator.wakeLock.request('screen');
            wakeLockHandle.addEventListener('release', () => { if (state.keepScreenOn) showToast('画面消灯阻止が解除されました', 'error'); });
            showToast('画面消灯阻止をONにしました', 'success');
        } else if (wakeLockHandle) {
            await wakeLockHandle.release(); wakeLockHandle = null;
            showToast('画面消灯阻止をOFFにしました', 'success');
        }
    } catch (e) {
        state.keepScreenOn = false;
        const wl = document.getElementById('wakelock-toggle'); if (wl) wl.checked = false;
        showToast(`画面消灯阻止を有効化できません: ${e.message}`, 'error');
    }
    queuePersist();
}

// === Main refreshUI ===
async function hydrateSecretInputsFromState() {
    const ghTokenInput = document.getElementById('gh-token');
    if (ghTokenInput && !ghTokenInput.value && state.ghTokenEnc) {
        ghTokenInput.value = await decryptPatToken(state.ghTokenEnc, state.deviceName);
    }

    const providers = ['openrouter', 'groq', 'google'];
    for (const provider of providers) {
        const input = document.getElementById(getAIKeyInputId(provider));
        if (!input || input.value || !state.aiKeysEnc?.[provider]) continue;
        input.value = await decryptPatToken(state.aiKeysEnc[provider], state.deviceName);
    }
}

function refreshUI() {
    const ghRepoInput = document.getElementById('gh-repo');
    if (ghRepoInput && ghRepoInput.value !== (state.ghRepo || '')) ghRepoInput.value = state.ghRepo || '';
    const deviceNameInput = document.getElementById('device-name');
    if (deviceNameInput && deviceNameInput.value !== (state.deviceName || '')) deviceNameInput.value = state.deviceName || '';

    const fontSel = document.getElementById('font-family');
    if (fontSel && state.fontFamily) fontSel.value = state.fontFamily;
    const aiProviderSel = document.getElementById('ai-provider');
    if (aiProviderSel && state.aiProvider) aiProviderSel.value = state.aiProvider;
    const aiModelSel = document.getElementById('ai-model');
    if (aiModelSel && state.aiModel) aiModelSel.value = state.aiModel;
    const aiFreeOnly = document.getElementById('ai-free-only');
    if (aiFreeOnly) aiFreeOnly.checked = !!state.aiFreeOnly;

    renderFolderFilter();
    if (typeof renderMemoScopeSwitch === 'function') renderMemoScopeSwitch();
    const visible = getVisibleChapterIndexes();
    document.getElementById('chapter-list').innerHTML = visible.map(i => {
        const ch = state.chapters[i];
        const tagBadges = (ch.tags || ['root']).map(tagId => {
            const folder = state.folders.find(f => f.id === tagId);
            return `<span class="chapter-tag-badge">${escapeHtml(folder ? folder.name : tagId)}</span>`;
        }).join('');
        return `<div class="chapter-item ${i === state.currentIdx ? 'active' : ''}"><div style="flex:1;"><button style="flex:1; text-align:left; background:transparent; border:none; color:var(--text); cursor:pointer;" onclick="switchChapter(${i})">${escapeHtml(ch.title)}</button><div class="chapter-tag-list">${tagBadges}</div></div><button onclick="renameChapter(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:19px;'>edit</span></button><button onclick="moveChapter(${i},-1)" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:19px;'>arrow_upward</span></button><button onclick="moveChapter(${i},1)" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:19px;'>arrow_downward</span></button><button onclick="openChapterTagEditor(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);" title="タグ編集"><span class='material-icons' style='font-size:19px;'>folder</span></button><button onclick="deleteChapter(${i})" style="background:transparent;border:none;cursor:pointer;color:var(--text);"><span class='material-icons' style='font-size:19px;'>close</span></button></div>`;
    }).join('');
    renderDownloadTargets();
    renderList('replace-list', state.replaceRules || [], 'replace');
    renderList('insert-list', state.insertButtons || [], 'insert');
    renderSnapshots(); updateButtons(); renderFavorites();
    const feb = document.getElementById('favorite-edit-block'); if (feb) feb.style.display = state.favoriteEditMode ? 'block' : 'none';
    applyMenuTab(state.menuTab || 'favorites');
    updateStats();
}

// === Download ===
function renderDownloadTargets() {
    const selectedIndexes = new Set(getSelectedChapterIndexes());
    const container = document.getElementById('download-target-list');
    if (!container) return;
    const visible = getVisibleChapterIndexes();
    container.innerHTML = visible.map(i => {
        const ch = state.chapters[i];
        const checked = selectedIndexes.size === 0 || selectedIndexes.has(i) ? 'checked' : '';
        return `<label class="config-item" style="cursor:pointer;"><input id="download-target-${i}" type="checkbox" ${checked}><span style="flex:1;">${ch.title}</span></label>`;
    }).join('');
}

function getSelectedChapterIndexes() {
    return state.chapters.map((_, i) => i).filter(i => {
        const checkbox = document.getElementById(`download-target-${i}`);
        return checkbox && checkbox.checked;
    });
}

function toggleSelectAllDownloadTargets() {
    const checkboxes = Array.from(document.querySelectorAll('[id^="download-target-"]'));
    if (!checkboxes.length) return;
    const shouldCheck = checkboxes.some(box => !box.checked);
    checkboxes.forEach(box => { box.checked = shouldCheck; });
}

function renderList(id, data, type) {
    document.getElementById(id).innerHTML = data.map((item, i) => `
        <div class="config-item"><span style="flex:1">${item.from || item.label} → ${item.to || item.value}</span>
        <span class="material-icons" style="font-size:19px; cursor:pointer;" onclick="removeItem('${type}', ${i})">delete_outline</span></div>
    `).join('');
}

function addListItem(type) {
    if (type === 'replace') {
        const f = document.getElementById('rep-from').value, t = document.getElementById('rep-to').value;
        if (f && t) { state.replaceRules.push({from:f, to:t}); document.getElementById('rep-from').value = ""; document.getElementById('rep-to').value = ""; }
    } else {
        const l = document.getElementById('ins-label').value, v = document.getElementById('ins-value').value;
        if (l && v) { state.insertButtons.push({label:l, value:v}); document.getElementById('ins-label').value = ""; document.getElementById('ins-value').value = ""; }
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

async function downloadSelectedZip() {
    save();
    const selected = getSelectedChapterIndexes();
    if (!selected.length) return showToast('ダウンロード対象の話を選択してください。', 'error');
    if (selected.length === 1) {
        const chapter = state.chapters[selected[0]];
        return triggerDownload(createUtf8TextBlob(chapter.body || ''), `${sanitizeFileName(chapter.title)}.txt`);
    }
    if (typeof JSZip === 'undefined') return showToast('ZIPライブラリの読み込みに失敗しました。通信状態を確認してください。', 'error');
    const zip = new JSZip();
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
    selected.forEach((idx, order) => {
        const chapter = state.chapters[idx];
        const primaryTagId = (chapter.tags && chapter.tags[0]) || 'root';
        const folderName = (state.folders.find(f => f.id === primaryTagId) || {name:'既定タグ'}).name;
        zip.file(`${stamp}_${String(order + 1).padStart(2, '0')}_${sanitizeFileName(folderName)}_${sanitizeFileName(chapter.title)}.txt`, createUtf8BytesWithBom(chapter.body || ''));
    });
    triggerDownload(await zip.generateAsync({ type: 'blob' }), 'kakudraft_selected.zip');
}

function downloadSelectedMergedTxt() {
    save();
    const selected = getSelectedChapterIndexes();
    if (!selected.length) return showToast('ダウンロード対象の話を選択してください。', 'error');
    const merged = selected.map(idx => `===== ${state.chapters[idx].title} =====\n${state.chapters[idx].body || ''}`).join('\n\n');
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
    triggerDownload(createUtf8TextBlob(merged), `kakudraft_merged_${stamp}.txt`);
}

function exportFullData() { save(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], {type:'application/json'})); a.download = 'kaku_draft_full.json'; a.click(); }

function importFullData(input) {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (confirm("JSONファイルから全データを復元しますか？現在のデータは上書きされます。")) {
                state = normalizeStateShape(imported);
                await persistNow(); location.reload();
            }
        } catch { showToast("JSONの解析に失敗しました。", "error"); }
    };
    reader.readAsText(file);
}

// === UI Toggles ===
function showPreview() { document.getElementById('preview-overlay').innerHTML = editor.value.replace(/\n/g, '<br>'); document.getElementById('preview-overlay').style.display = 'block'; }
function togglePanel(id) { const p = document.getElementById(id); const isOpen = p.classList.contains('open'); closePanels(); if (!isOpen) p.classList.add('open'); }
function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; document.body.setAttribute('data-theme', state.theme); save(); }
function changeFontSize(d) { state.fontSize += d; document.documentElement.style.setProperty('--editor-size', state.fontSize + 'px'); updateHighlight(); save(); }

// === Keyboard Shortcuts ===
function bindEnterShortcut(el, action) {
    if (!el) return;
    el.addEventListener('keydown', e => { if (e.key !== 'Enter' || e.shiftKey) return; e.preventDefault(); action(); });
}

editor.addEventListener('input', () => { save(); updateHighlight(); updateStats(); });
editor.addEventListener('scroll', ensureHighlightMirror);
memoArea.oninput = save;
memoArea.addEventListener('dragover', e => e.preventDefault());
memoArea.addEventListener('drop', async e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) await attachMemoFile(f); });

// Editor shortcuts
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 's') { e.preventDefault(); save(); showToast('保存しました', 'success'); }
        if (e.key === 'f') { e.preventDefault(); toggleSearchPanel(true); }
        if (e.key === 'h') { e.preventDefault(); togglePanel('menu-panel'); }
    }
});

// === Initialization ===
async function initializeApp() {
    try {
        // Load persisted state
        await loadPersistedState();
        await loadPersistedAIChat();
        
        // Set up theme and fonts
        document.body.setAttribute('data-theme', state.theme);
        document.documentElement.style.setProperty('--writing-font', state.fontFamily);
        document.documentElement.style.setProperty('--editor-size', state.fontSize + 'px');
        updateOnlineFontUI();
        
        // Set up device name
        if (!state.deviceName) {
            state.deviceName = prompt('デバイス名（初回のみ、同期用）:', 'my-device') || 'device-1';
            save();
        }
        
        // Set up auto-save
        setupAutoSave();
        
        // Check for remote diff on startup
        const tokenPlain = document.getElementById('gh-token')?.value?.trim();
        if (tokenPlain && state.ghRepo) {
            try {
                await checkRemoteDiffOnStartup(tokenPlain);
            } catch { }
        }
        
        // Load current chapter
        await hydrateSecretInputsFromState();
        refreshUI();
        loadChapter(state.currentIdx);
        
        // Set up AI
        onAIProviderChange();

        const ghRepoInput = document.getElementById('gh-repo');
        if (ghRepoInput) ghRepoInput.addEventListener('input', () => { state.ghRepo = ghRepoInput.value.trim(); queuePersist(); });
        const deviceNameInput = document.getElementById('device-name');
        if (deviceNameInput) deviceNameInput.addEventListener('input', () => { state.deviceName = deviceNameInput.value.trim(); queuePersist(); });
        
        // Render
        renderMemos();
        updateStats();
    } catch (e) {
        console.error('Initialization error:', e);
        showToast('初期化エラーが発生しました。ページをリロードしてください。', 'error');
    }
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
