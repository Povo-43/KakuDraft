/* ===================================================================
 *  KakuDraft - app-github.js
 *  GitHub API (with Tree API optimization), sync, snapshots, diff
 * =================================================================== */

// === Cloud Pieces (build / apply / migrate) ===
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
    if (remote.keys) {
        merged.ghTokenEnc = remote.keys.ghTokenEnc || merged.ghTokenEnc;
        merged.ghRepo = remote.keys.ghRepo || merged.ghRepo;
        merged.deviceName = remote.keys.deviceName || merged.deviceName;
        merged.aiKeyEnc = remote.keys.aiKeyEnc || merged.aiKeyEnc;
        merged.aiKeysEnc = remote.keys.aiKeysEnc || merged.aiKeysEnc;
    }
    if (remote.stories) {
        merged.chapters = remote.stories.chapters || merged.chapters;
        merged.currentIdx = Number.isInteger(remote.stories.currentIdx) ? remote.stories.currentIdx : merged.currentIdx;
        merged.writingSessions = remote.stories.writingSessions || merged.writingSessions;
    }
    if (remote.memos) {
        merged.globalMemos = remote.memos.globalMemos || merged.globalMemos;
        merged.currentGlobalMemoIdx = Number.isInteger(remote.memos.currentGlobalMemoIdx) ? remote.memos.currentGlobalMemoIdx : merged.currentGlobalMemoIdx;
        merged.memoScope = remote.memos.memoScope || merged.memoScope;
        merged.folderMemos = remote.memos.folderMemos || merged.folderMemos;
    }
    if (remote.aiChat?.list) aiChatState = Array.isArray(remote.aiChat.list) ? remote.aiChat.list.slice(-100) : [];
    if (remote.assetsIndex) merged.assetsIndex = remote.assetsIndex;
    state = normalizeStateShape(merged);
}

function convertLegacyRemoteToPieces(legacyData, legacyAiChat) {
    const normalized = normalizeStateShape(legacyData || {});
    return {
        settings: {
            replaceRules: normalized.replaceRules, insertButtons: normalized.insertButtons, fontSize: normalized.fontSize, theme: normalized.theme,
            deviceName: normalized.deviceName, menuTab: normalized.menuTab, favoriteActionKeys: normalized.favoriteActionKeys, fontFamily: normalized.fontFamily,
            folders: normalized.folders, currentFolderId: normalized.currentFolderId, favoriteEditMode: normalized.favoriteEditMode, keepScreenOn: normalized.keepScreenOn,
            aiProvider: normalized.aiProvider, aiModel: normalized.aiModel, aiTab: normalized.aiTab, aiFreeOnly: normalized.aiFreeOnly, aiUsage: normalized.aiUsage || {}
        },
        keys: { ghTokenEnc: normalized.ghTokenEnc || '', ghRepo: normalized.ghRepo || '', deviceName: normalized.deviceName || '', aiKeyEnc: normalized.aiKeyEnc || '', aiKeysEnc: normalized.aiKeysEnc || {} },
        stories: { chapters: normalized.chapters, currentIdx: normalized.currentIdx, writingSessions: normalized.writingSessions || [] },
        memos: { globalMemos: normalized.globalMemos, currentGlobalMemoIdx: normalized.currentGlobalMemoIdx, memoScope: normalized.memoScope, folderMemos: normalized.folderMemos || {} },
        aiChat: { list: Array.isArray(legacyAiChat) ? legacyAiChat.slice(-100) : [] },
        assetsIndex: { items: [] },
        metadata: { updatedAt: Date.now(), migratedFrom: 'legacy-cloud-format' }
    };
}

async function putCloudPiece(headers, owner, repo, key, data, sha = '') {
    const path = CLOUD_PATHS[key];
    if (!path) return;
    const body = { message: `sync ${key}`, content: toBase64FromText(JSON.stringify(data)) };
    if (sha) body.sha = sha;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await requestJson(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!res.res.ok) throw new Error(res.body?.message || `${key} upload failed`);
}

async function migrateLegacyCloudIfNeeded(headers, owner, repo, remote, remoteMeta) {
    const legacy = LEGACY_CLOUD_PATHS;
    if (remote.settings || remote.stories || remote.memos) return; // Already migrated
    
    const legacyUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${legacy.data}`;
    const legacyRes = await requestJson(legacyUrl, { headers });
    if (legacyRes.res.status !== 200 || !legacyRes.body?.content) return;
    
    const legacyData = fromBase64ToJson(legacyRes.body.content);
    const legacyAiChatUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${legacy.aiChat}`;
    const legacyAiRes = await requestJson(legacyAiChatUrl, { headers });
    const legacyAiChat = legacyAiRes.res.status === 200 ? fromBase64ToJson(legacyAiRes.body.content) : null;
    
    const pieces = convertLegacyRemoteToPieces(legacyData, legacyAiChat);
    Object.entries(pieces).forEach(([key, data]) => {
        remote[key] = data;
        remoteMeta[key] = { sha: legacyRes.body.sha };
    });
}

// === GitHub Tree API for efficient sync ===
async function fetchRemoteTreeShas(headers, owner, repo) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
    const res = await requestJson(url, { headers });
    if (!res.res.ok) return {};
    
    const shas = {};
    (res.body?.tree || []).forEach(item => {
        if (item.type === 'blob' && (item.path.startsWith('設定/') || item.path.startsWith('話/') || item.path.startsWith('メモ/') || item.path.startsWith('テキスト/'))) {
            shas[item.path] = item.sha;
        }
    });
    return shas;
}

// === GitHub Sync (UP/DOWN) ===
async function githubSync(mode) {
    save();
    const token = document.getElementById('gh-token')?.value?.trim();
    const repoInput = state.ghRepo;
    if (!token || !repoInput) return showToast('GitHub設定（PAT / リポジトリ）を入力してください', 'error');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

    try {
        const userRes = await requestJson('https://api.github.com/user', { headers });
        const parsedRepo = parseRepoTarget(repoInput, userRes.body?.login);
        if (!parsedRepo) throw new Error('リポジトリ形式が不正です');
        const { owner, repo } = parsedRepo;

        // Save snapshot before any sync operation
        await uploadRepoSnapshot(headers, owner, repo, getStateWithoutAIChat(), mode === 'up' ? 'before-up' : 'before-down');

        // Fetch remote pieces + SHA
        const remote = {};
        const remoteMeta = {};
        const pieceKeys = Object.keys(CLOUD_PATHS);
        showProgressToast(`${mode === 'up' ? 'UP' : 'DOWN'}: リモート情報を取得中...`, 0, pieceKeys.length);

        // Parallel fetch of remote pieces
        const fetchResults = await Promise.all(pieceKeys.map(async (key) => {
            const path = CLOUD_PATHS[key];
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            const got = await requestJson(url, { headers });
            return { key, got };
        }));
        fetchResults.forEach(({ key, got }) => {
            if (got.res.status === 200 && got.body?.content) {
                remoteMeta[key] = { sha: got.body.sha };
                remote[key] = fromBase64ToJson(got.body.content);
            }
        });

        await migrateLegacyCloudIfNeeded(headers, owner, repo, remote, remoteMeta);

        if (mode === 'up') {
            const pieces = buildCloudPieces();
            // Determine which pieces changed (SHA-based skip)
            const changedPieces = [];
            for (const key of pieceKeys) {
                if (key === 'metadata') continue;
                const localJson = JSON.stringify(pieces[key]);
                const remoteJson = JSON.stringify(remote[key] || null);
                if (localJson !== remoteJson) changedPieces.push(key);
            }

            // Upload changed pieces in parallel batches
            const totalSteps = changedPieces.length + 1; // +1 for text backups
            let step = 0;
            if (changedPieces.length > 0) {
                // Upload in parallel (max 3 concurrent)
                const batchSize = 3;
                for (let i = 0; i < changedPieces.length; i += batchSize) {
                    const batch = changedPieces.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (key) => {
                        const contentJson = JSON.stringify(pieces[key]);
                        const putBody = { message: `sync ${key}`, content: toBase64FromText(contentJson) };
                        if (remoteMeta[key]?.sha) putBody.sha = remoteMeta[key].sha;
                        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_PATHS[key]}`;
                        const putRes = await requestJson(url, { method:'PUT', headers, body: JSON.stringify(putBody) });
                        if (!putRes.res.ok) throw new Error(putRes.body?.message || `${key}のアップロード失敗`);
                    }));
                    step += batch.length;
                    showProgressToast('UP: ピースをアップロード中...', step, totalSteps);
                }
            }

            // Metadata
            const meta = { updatedAt: Date.now(), files: Object.keys(pieces) };
            state.syncMeta = meta;
            const metaBody = { message: 'sync metadata', content: toBase64FromText(JSON.stringify(meta)) };
            if (remoteMeta.metadata?.sha) metaBody.sha = remoteMeta.metadata.sha;
            const metaUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_PATHS.metadata}`;
            await requestJson(metaUrl, { method:'PUT', headers, body: JSON.stringify(metaBody) });

            // Text backups with SHA-based skip
            showProgressToast('UP: テキストバックアップ中...', step, totalSteps);
            const txtFiles = buildTextBackupFiles();
            const txtEntries = Object.entries(txtFiles);

            // Fetch existing text file SHAs in parallel
            const existingShas = await Promise.all(txtEntries.map(async ([path]) => {
                const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
                const res = await requestJson(fileUrl, { headers });
                if (res.res.status === 200 && res.body?.sha && res.body?.content) {
                    return { path, sha: res.body.sha, remoteContent: res.body.content };
                }
                return { path, sha: null, remoteContent: null };
            }));
            const shaMap = {};
            existingShas.forEach(e => { shaMap[e.path] = e; });

            // Upload only changed text files in parallel
            const changedTxtFiles = txtEntries.filter(([path, text]) => {
                const existing = shaMap[path];
                if (!existing?.remoteContent) return true; // new file
                try {
                    const remoteText = new TextDecoder().decode(Uint8Array.from(atob(existing.remoteContent.replace(/\n/g, '')), c => c.charCodeAt(0)));
                    return remoteText !== text;
                } catch { return true; }
            });

            if (changedTxtFiles.length > 0) {
                const batchSize = 5;
                for (let i = 0; i < changedTxtFiles.length; i += batchSize) {
                    const batch = changedTxtFiles.slice(i, i + batchSize);
                    await Promise.all(batch.map(async ([path, text]) => {
                        const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
                        const txtBody = { message: `txt backup ${path}`, content: toBase64FromText(text) };
                        if (shaMap[path]?.sha) txtBody.sha = shaMap[path].sha;
                        await requestJson(fileUrl, { method:'PUT', headers, body: JSON.stringify(txtBody) });
                    }));
                }
            }
            step++;
            showProgressToast('UP: 添付ファイル同期中...', step, totalSteps);

            await syncAttachmentsToGithub(headers, owner, repo);
            hideProgressToast();
            showToast(`UP完了 (変更: ピース${changedPieces.length} / テキスト${changedTxtFiles.length})`, 'success');
        } else {
            // DOWN
            const hasRemote = ['settings','keys','stories','memos','aiChat','assetsIndex'].some(k => remote[k]);
            if (!hasRemote) return showToast('リモートにデータがありません。先にUPしてください。', 'error');
            if (!confirm('リモートデータで復元しますか？')) { hideProgressToast(); return; }

            showProgressToast('DOWN: 復元中...', 1, 2);
            await addLocalSnapshot('before-download-local', structuredClone(state));
            applyCloudPieces(remote);
            state.syncMeta = remote.metadata || state.syncMeta;
            await persistNow();
            showProgressToast('DOWN: 完了', 2, 2);
            hideProgressToast();
            showToast('復元完了', 'success');
            setTimeout(() => location.reload(), 400);
        }
    } catch (err) {
        console.error(err);
        hideProgressToast();
        showToast(`GitHub同期エラー: ${err.message}`, 'error');
    }
}

// === Snapshots on GitHub ===
async function uploadRepoSnapshot(headers, owner, repo, currentState, reason) {
    const snapshotPath = `kakudraft_snapshots/${new Date().toISOString().replace(/[:.]/g, '-')}_${sanitizeFileName(state.deviceName || 'device')}_${reason}.json`;
    const content = toBase64FromText(JSON.stringify(currentState));
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${snapshotPath}`;
    await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify({ message: `snapshot: ${reason}`, content }) });
}

async function fetchGithubSnapshots() {
    const token = document.getElementById('gh-token')?.value?.trim();
    const repoInput = state.ghRepo;
    if (!token || !repoInput) return showToast('GitHub設定を入力してください', 'error');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const parsedRepo = parseRepoTarget(repoInput, undefined);
    if (!parsedRepo) return showToast('リポジトリ形式が不正です', 'error');
    const { owner, repo } = parsedRepo;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/kakudraft_snapshots`;
    showProgressToast('スナップショット一覧を取得中...', 0, 1);
    try {
        const res = await requestJson(url, { headers });
        hideProgressToast();
        if (!res.res.ok) return showToast('スナップショットフォルダが見つかりません', 'error');
        const files = (res.body || []).filter(f => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name));
        const listEl = document.getElementById('gh-snapshot-list');
        if (!listEl) return;
        if (!files.length) {
            listEl.innerHTML = '<div class="config-item">スナップショットなし</div>';
            return;
        }
        listEl.innerHTML = files.slice(0, 50).map((f, i) => {
            const parts = f.name.replace('.json', '').split('_');
            const dateStr = parts[0] || '';
            const device = parts.length > 1 ? parts.slice(1, -1).join('_') : '';
            const reason = parts[parts.length - 1] || '';
            return `<div class="gh-snapshot-item">
                <div class="snapshot-info">
                    <div class="snapshot-date">${escapeHtml(dateStr)}</div>
                    <div class="snapshot-detail">${escapeHtml(device)} / ${escapeHtml(reason)}</div>
                </div>
                <div class="snapshot-actions">
                    <button class="sys-btn" style="width:auto;height:28px;margin:0;padding:0 8px;" onclick="previewGithubSnapshot('${escapeHtml(f.path)}')">
                        <span class="material-icons" style="font-size:18px;">preview</span>
                    </button>
                    <button class="sys-btn" style="width:auto;height:28px;margin:0;padding:0 8px;" onclick="restoreGithubSnapshot('${escapeHtml(f.path)}')">
                        <span class="material-icons" style="font-size:18px;">restore</span>
                    </button>
                </div>
            </div>`;
        }).join('');
        showToast(`${files.length} 件のスナップショットを取得`, 'success');
    } catch (e) {
        hideProgressToast();
        showToast(`スナップショット取得エラー: ${e.message}`, 'error');
    }
}

async function previewGithubSnapshot(path) {
    const token = document.getElementById('gh-token')?.value?.trim();
    const repoInput = state.ghRepo;
    if (!token || !repoInput) return;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const parsedRepo = parseRepoTarget(repoInput, undefined);
    if (!parsedRepo) return;
    const { owner, repo } = parsedRepo;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    showProgressToast('スナップショットを読み込み中...', 0, 1);
    try {
        const res = await requestJson(url, { headers });
        hideProgressToast();
        if (!res.res.ok || !res.body?.content) return showToast('スナップショットの取得に失敗', 'error');
        const data = fromBase64ToJson(res.body.content);
        const chapters = (data.chapters || []);
        const totalChars = chapters.reduce((sum, ch) => sum + (ch.body || '').length, 0);
        const info = `話数: ${chapters.length}\n合計文字数: ${totalChars}\n話一覧:\n${chapters.map((ch, i) => `  ${i + 1}. ${ch.title} (${(ch.body || '').length}字)`).join('\n')}`;
        alert(`--- スナップショットの内容 ---\n${info}`);
    } catch (e) {
        hideProgressToast();
        showToast(`プレビューエラー: ${e.message}`, 'error');
    }
}

async function restoreGithubSnapshot(path) {
    if (!confirm('このスナップショットから復元しますか？現在のデータは上書きされます。')) return;
    const token = document.getElementById('gh-token')?.value?.trim();
    const repoInput = state.ghRepo;
    if (!token || !repoInput) return;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const parsedRepo = parseRepoTarget(repoInput, undefined);
    if (!parsedRepo) return;
    const { owner, repo } = parsedRepo;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    showProgressToast('スナップショットを復元中...', 0, 1);
    try {
        const res = await requestJson(url, { headers });
        if (!res.res.ok || !res.body?.content) { hideProgressToast(); return showToast('スナップショットの取得に失敗', 'error'); }
        const data = fromBase64ToJson(res.body.content);
        await addLocalSnapshot('before-snapshot-restore', structuredClone(state));
        state = normalizeStateShape(data);
        await persistNow();
        hideProgressToast();
        showToast('スナップショットから復元しました', 'success');
        setTimeout(() => location.reload(), 400);
    } catch (e) {
        hideProgressToast();
        showToast(`復元エラー: ${e.message}`, 'error');
    }
}

// === Startup diff check (local vs remote) ===
async function checkRemoteDiffOnStartup(token) {
    const parsedRepo = parseRepoTarget(state.ghRepo, undefined);
    if (!parsedRepo) return;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const { owner, repo } = parsedRepo;

    // Check metadata timestamp
    const metaUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_PATHS.metadata}`;
    const metaRes = await requestJson(metaUrl, { headers });
    if (!metaRes.res.ok || !metaRes.body?.content) return;
    const remoteMeta = fromBase64ToJson(metaRes.body.content);
    const remoteTs = Number(remoteMeta?.updatedAt || 0);
    const localTs = Number(state.syncMeta?.updatedAt || 0);

    if (remoteTs <= localTs) return;

    // Fetch remote pieces to compare per-piece
    const piecesToCheck = ['settings', 'stories', 'memos', 'aiChat'];
    const results = await Promise.all(piecesToCheck.map(async (key) => {
        const path = CLOUD_PATHS[key];
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
        const got = await requestJson(url, { headers });
        if (got.res.status !== 200 || !got.body?.content) return null;
        const remoteData = fromBase64ToJson(got.body.content);
        const localPieces = buildCloudPieces();
        const localJson = JSON.stringify(localPieces[key] || null);
        const remoteJson = JSON.stringify(remoteData);
        if (localJson === remoteJson) return null;
        return key;
    }));

    const changedPieces = results.filter(Boolean);
    if (!changedPieces.length) return;

    showDiffDialog(
        changedPieces.map(k => k === 'settings' ? '設定' : k === 'stories' ? '話本文' : k === 'memos' ? 'メモ' : 'AIチャット'),
        changedPieces,
        async (selectedKeys) => {
            showProgressToast('リモートから差分を取得中...', 0, selectedKeys.length);
            const remoteData = {};
            let step = 0;
            for (const key of selectedKeys) {
                const url = `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_PATHS[key]}`;
                const res = await requestJson(url, { headers });
                if (res.res.ok && res.body?.content) {
                    remoteData[key] = fromBase64ToJson(res.body.content);
                }
                showProgressToast('リモートから差分を取得中...', ++step, selectedKeys.length);
            }
            await addLocalSnapshot('before-remote-merge', structuredClone(state));
            applyCloudPieces(remoteData);
            await persistNow();
            hideProgressToast();
            showToast('リモートから復元しました', 'success');
            setTimeout(() => location.reload(), 400);
        }
    );
}

function showDiffDialog(labels, keys, onConfirm) {
    const dialog = document.getElementById('diff-dialog');
    if (!dialog) return;
    
    const listHtml = labels.map((label, i) => `
        <label class="config-item" style="cursor:pointer;">
            <input id="diff-check-${i}" type="checkbox" checked>
            <span>${escapeHtml(label)}</span>
        </label>
    `).join('');
    
    const dialogContent = document.getElementById('diff-dialog-content');
    if (dialogContent) {
        dialogContent.innerHTML = `
            <div style="max-height:60vh; overflow-y:auto;">
                <div style="padding:16px; color:var(--text-secondary); margin-bottom:16px;">
                    リモートに新しいデータがあります。復元する項目を選択してください。
                </div>
                ${listHtml}
            </div>
            <div style="display:flex; gap:8px; margin-top:16px;">
                <button class="sys-btn" onclick="document.getElementById('diff-dialog').classList.remove('show')" style="flex:1;">キャンセル</button>
                <button class="sys-btn" style="flex:1; background:var(--primary);" onclick="confirmDiffSelection(${JSON.stringify(keys).replace(/"/g, '&quot;')})">復元</button>
            </div>
        `;
    }
    dialog.classList.add('show');
    window._diffOnConfirm = onConfirm;
}

window.confirmDiffSelection = function(keys) {
    const dialog = document.getElementById('diff-dialog');
    const selectedKeys = keys.filter((_, i) => document.getElementById(`diff-check-${i}`)?.checked);
    if (dialog) dialog.classList.remove('show');
    if (window._diffOnConfirm && selectedKeys.length > 0) {
        window._diffOnConfirm(selectedKeys);
    }
};

// === Attachment sync to GitHub ===
async function syncAttachmentsToGithub(headers, owner, repo) {
    // Placeholder - can be extended for attachment upload
    return;
}
