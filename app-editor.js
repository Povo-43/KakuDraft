/* ===================================================================
 *  KakuDraft - app-editor.js
 *  Editor, chapters, memos, tags, search, replace
 * =================================================================== */

// === Main save function ===
function syncEditorToCurrentChapter() {
    const ch = state.chapters?.[state.currentIdx];
    if (ch) ch.body = editor.value || '';
}

function syncMemoInputToState() {
    const memo = getCurrentMemo();
    if (memo) memo.content = memoArea.value || '';
}

function save(immediate = false) {
    syncEditorToCurrentChapter();
    syncMemoInputToState();
    if (immediate) return persistNow();
    queuePersist();
}

// === Chapter management ===
function loadChapter(i) { editor.value = state.chapters[i].body; editor.scrollTop = 0; updateStats(); renderMemos(); updateHighlight(); }
function switchChapter(i) { save(); state.currentIdx = i; loadChapter(i); refreshUI(); }
function addChapter() { state.chapters.push({title: `第${state.chapters.length + 1}話`, body: "", memos:[{name:'メモ', content:'', attachments:[]}], currentMemoIdx: 0, snapshots:[], tags:['root']}); refreshUI(); loadChapter(state.chapters.length - 1); }
function deleteChapter(i) { if (state.chapters.length <= 1 || !confirm("削除？")) return; state.chapters.splice(i, 1); state.currentIdx = 0; refreshUI(); loadChapter(0); }
function moveChapter(i, delta) { if (i + delta < 0 || i + delta >= state.chapters.length) return; [state.chapters[i], state.chapters[i + delta]] = [state.chapters[i + delta], state.chapters[i]]; state.currentIdx = i + delta; refreshUI(); loadChapter(state.currentIdx); save(); }
function renameChapter(i) { const newTitle = prompt("話のタイトルを入力してください:", state.chapters[i].title); if (newTitle) { state.chapters[i].title = newTitle; refreshUI(); save(); } }
function splitChapter() { const curCh = state.chapters[state.currentIdx]; const lines = editor.value.split('\n'); const splitIdx = Math.floor(lines.length / 2); const first = lines.slice(0, splitIdx).join('\n'); const second = lines.slice(splitIdx).join('\n'); editor.value = first; curCh.body = first; const newCh = {title: curCh.title + '_2', body: second, memos:[{name:'メモ', content:'', attachments:[]}], currentMemoIdx: 0, snapshots:[], tags: structuredClone(curCh.tags || ['root'])}; state.chapters.splice(state.currentIdx + 1, 0, newCh); refreshUI(); save(); }
function mergeChapter() { const ch = state.chapters[state.currentIdx]; if (state.currentIdx + 1 >= state.chapters.length) return showToast('次の話がありません', 'error'); const nextCh = state.chapters[state.currentIdx + 1]; ch.body += '\n\n' + nextCh.body; state.chapters.splice(state.currentIdx + 1, 1); editor.value = ch.body; updateStats(); refreshUI(); save(); }

// === Chapter tags ===
function openChapterTagEditor(chapterIdx) {
    const ch = state.chapters[chapterIdx];
    const dialogEl = document.getElementById('tag-editor-modal');
    if (!dialogEl || !ch) return;
    const tagsHtml = (state.folders || []).map(f => {
        const checked = (ch.tags || ['root']).includes(f.id) ? 'checked' : '';
        return `<label class="config-item" style="cursor:pointer;"><input type="checkbox" data-tag-id="${escapeHtml(f.id)}" ${checked}><span>${escapeHtml(f.name)}</span></label>`;
    }).join('');
    const content = document.getElementById('tag-editor-checkboxes');
    if (content) content.innerHTML = tagsHtml;
    const title = document.getElementById('tag-editor-title');
    if (title) title.textContent = `タグ編集: ${ch.title}`;
    dialogEl.style.display = 'flex';
    window._tagEditorChapterIdx = chapterIdx;
}

function closeTagEditor() {
    const dialogEl = document.getElementById('tag-editor-modal');
    if (dialogEl) dialogEl.style.display = 'none';
}

function saveTagEditor() {
    const chIdx = window._tagEditorChapterIdx;
    if (chIdx === undefined) return;
    const selectedTags = Array.from(document.querySelectorAll('#tag-editor-checkboxes input[data-tag-id]:checked')).map(el => el.dataset.tagId);
    if (!selectedTags.length) selectedTags.push('root');
    state.chapters[chIdx].tags = selectedTags;
    closeTagEditor();
    refreshUI();
    save();
    showToast('タグを更新しました', 'success');
}

// === Memos ===
function renderMemoScopeSwitch() {
    ['local', 'folder', 'global'].forEach(scope => {
        const el = document.getElementById(`scope-${scope}`);
        if (!el) return;
        el.classList.toggle('active', state.memoScope === scope);
    });
}

function switchMemoScope(scope) {
    save();
    state.memoScope = scope;
    if (scope === 'folder' && state.currentFolderId === 'all') state.currentFolderId = 'root';
    renderMemoScopeSwitch();
    renderMemos();
    save();
}
function renameMemo(i) { const memo = getCurrentMemo(); if (!memo) return; const newName = prompt("メモ名:", memo.name); if (newName) { memo.name = newName; renderMemos(); save(); } }
function moveMemo(i, delta) {
    const memos = getCurrentMemoArray();
    if (!memos || i + delta < 0 || i + delta >= memos.length) return;
    [memos[i], memos[i + delta]] = [memos[i + delta], memos[i]];
    setCurrentMemoIndex(i + delta);
    renderMemos();
    save();
}
function renderMemos() { const memos = getCurrentMemoArray(); const container = document.getElementById('memo-tabs'); if (!container || !memos) return; container.innerHTML = memos.map((m, i) => `<button class="memo-tab ${i === getCurrentMemoIndex() ? 'active' : ''}" onclick="switchMemo(${i})">${escapeHtml(m.name)}</button><button class="memo-tab-btn" onclick="renameMemo(${i})" title="名前変更"><span class="material-icons" style="font-size:18px;">edit</span></button><button class="memo-tab-btn" onclick="moveMemo(${i}, -1)" title="左に移動"><span class="material-icons" style="font-size:18px;">chevron_left</span></button><button class="memo-tab-btn" onclick="moveMemo(${i}, 1)" title="右に移動"><span class="material-icons" style="font-size:18px;">chevron_right</span></button><button class="memo-tab-btn" onclick="deleteMemo(${i})" title="削除"><span class="material-icons" style="font-size:18px;">close</span></button>`).join(''); renderMemoAttachments(); }
function deleteMemo(i) { const memos = getCurrentMemoArray(); if (!memos || memos.length <= 1) { showToast('メモは1つ以上必要です', 'error'); return; } if (!confirm(`メモ「${escapeHtml(memos[i].name)}」を削除しますか？`)) return; memos.splice(i, 1); const nextIdx = Math.min(getCurrentMemoIndex(), memos.length - 1);
    setCurrentMemoIndex(nextIdx); switchMemo(nextIdx); save(); }
function switchMemo(i) {
    setCurrentMemoIndex(i);
    const memo = getCurrentMemo();
    if (memo) memoArea.value = memo.content;
    renderMemos();
    renderMemoAttachments();
}
function addMemoTab() { const newMemo = {name: prompt("新しいメモの名前:", "新規メモ") || "新規メモ", content: "", attachments: []}; const memos = getCurrentMemoArray(); if (memos) memos.push(newMemo); renderMemos(); switchMemo(memos.length - 1); save(); }
function getCurrentMemo() { const memos = getCurrentMemoArray(); const idx = getCurrentMemoIndex(); return memos && idx >= 0 && idx < memos.length ? memos[idx] : null; }
function getCurrentFolderMemoId() {
    if (state.currentFolderId && state.currentFolderId !== 'all') return state.currentFolderId;
    return (state.folders || []).find(f => f.id === 'root') ? 'root' : state.folders?.[0]?.id;
}

function getCurrentMemoArray() {
    if (state.memoScope === 'local') return state.chapters[state.currentIdx]?.memos;
    if (state.memoScope === 'global') return state.globalMemos;
    const bundle = state.folderMemos?.[getCurrentFolderMemoId()];
    return bundle?.memos;
}
function getCurrentMemoIndex() {
    if (state.memoScope === 'local') return state.chapters[state.currentIdx]?.currentMemoIdx ?? 0;
    if (state.memoScope === 'global') return state.currentGlobalMemoIdx ?? 0;
    const bundle = state.folderMemos?.[getCurrentFolderMemoId()];
    return bundle?.currentMemoIdx ?? 0;
}

function setCurrentMemoIndex(nextIdx) {
    if (state.memoScope === 'local') {
        const ch = state.chapters[state.currentIdx];
        if (ch) ch.currentMemoIdx = nextIdx;
        return;
    }
    if (state.memoScope === 'global') {
        state.currentGlobalMemoIdx = nextIdx;
        return;
    }
    const bundle = state.folderMemos?.[getCurrentFolderMemoId()];
    if (bundle) bundle.currentMemoIdx = nextIdx;
}
function getCurrentMemoContext() { const memo = getCurrentMemo(); if (!memo) return ''; let text = memo.content || ''; if (state.memoScope === 'local') text += '\n' + editor.value; return text; }

// === Memo attachments ===
async function renderMemoAttachments() {
    const memo = getCurrentMemo();
    if (!memo) return;
    const container = document.getElementById('memo-attachments');
    if (!container) return;
    container.innerHTML = (memo.attachments || []).map((a, i) => `
        <div class="config-item" style="align-items:center;">
            <span style="flex:1; font-size:12px;">${escapeHtml(a.name)} (${a.size} bytes)</span>
            <button onclick="previewMemoAttachment(${i})" title="プレビュー" style="padding:4px 8px;"><span class="material-icons" style="font-size:18px;">preview</span></button>
            <button onclick="downloadMemoAttachment(${i})" title="ダウンロード" style="padding:4px 8px;"><span class="material-icons" style="font-size:18px;">download</span></button>
            <button onclick="removeMemoAttachment(${i})" title="削除" style="padding:4px 8px;"><span class="material-icons" style="font-size:18px;">close</span></button>
        </div>
    `).join('') || '<div class="config-item">添付ファイルなし</div>';
}

async function attachMemoFile(file) {
    const memo = getCurrentMemo();
    if (!memo) return;
    const blob = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(blob))).match(/.{1,64}/g).join('\n');
    const att = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: file.name, type: file.type, size: file.size, createdAt: Date.now(), storage: 'inline', data: b64 };
    memo.attachments = (memo.attachments || []);
    memo.attachments.push(normalizeAttachment(att));
    renderMemoAttachments();
    save();
    showToast(`ファイル「${file.name}」を追加しました`, 'success');
}

async function previewMemoAttachment(i) {
    const memo = getCurrentMemo();
    if (!memo || !memo.attachments?.[i]) return;
    const att = memo.attachments[i];
    if (att.type.startsWith('image/')) {
        const overlay = document.getElementById('memo-attachment-preview');
        if (overlay) {
            overlay.innerHTML = `<div style="text-align:center;"><img src="data:${att.type};base64,${att.data}" style="max-width:80%; max-height:80%;"><div style="margin-top:8px;"><button onclick="closeMemoAttachmentPreview()" class="sys-btn">閉じる</button></div></div>`;
            overlay.style.display = 'flex';
        }
    } else {
        alert(`ファイル: ${att.name}\n種類: ${att.type}\nサイズ: ${att.size} bytes`);
    }
}

function closeMemoAttachmentPreview() {
    const overlay = document.getElementById('memo-attachment-preview');
    if (overlay) overlay.style.display = 'none';
}

async function downloadMemoAttachment(i) {
    const memo = getCurrentMemo();
    if (!memo || !memo.attachments?.[i]) return;
    const att = memo.attachments[i];
    const blob = new Blob([Uint8Array.from(atob(att.data.replace(/\n/g, '')), c => c.charCodeAt(0))], { type: att.type });
    triggerDownload(blob, att.name);
}

async function removeMemoAttachment(i) {
    const memo = getCurrentMemo();
    if (!memo || !memo.attachments?.[i]) return;
    if (!confirm(`ファイル「${escapeHtml(memo.attachments[i].name)}」を削除しますか？`)) return;
    memo.attachments.splice(i, 1);
    renderMemoAttachments();
    save();
    showToast('ファイルを削除しました', 'success');
}

// === Folders / Tags ===
function getVisibleChapterIndexes() {
    if (state.currentFolderId === 'all') return state.chapters.map((_, i) => i);
    return state.chapters.map((_, i) => i).filter(i => (state.chapters[i].tags || ['root']).includes(state.currentFolderId));
}

function renderFolderFilter() {
    const container = document.getElementById('folder-filter');
    if (!container) return;
    container.innerHTML = (state.folders || []).map(f => (
        `<option value="${escapeHtml(f.id)}" ${state.currentFolderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`
    )).join('') + `<option value="all" ${state.currentFolderId === 'all' ? 'selected' : ''}>すべて</option>`;
}

function addFolder() {
    const input = document.getElementById('new-folder-name');
    const typedName = input?.value?.trim();
    const name = typedName || prompt("タグ名:", "新規タグ");
    if (!name) return;
    const id = `folder-${Date.now()}`;
    state.folders.push({id, name});
    state.folderMemos[id] = {memos:[{name:'タグメモ', content:'', attachments:[]}], currentMemoIdx:0};
    state.currentFolderId = id;
    if (input) input.value = '';
    refreshUI();
    save();
    showToast('タグを作成しました', 'success');
}

function changeFolderFilter(folderId) { state.currentFolderId = folderId || 'all'; if (state.memoScope === 'folder') renderMemos(); refreshUI(); save(); }
function renameCurrentFolder() {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    if (folder.id === 'root') return showToast('既定タグは名前変更できません', 'error');
    const newName = prompt("タグ名:", folder.name)?.trim();
    if (newName) {
        folder.name = newName;
        refreshUI();
        save();
    }
}
function getCurrentFolderMemoBundle() { const bundle = state.folderMemos?.[state.currentFolderId]; return bundle || {memos:[{name:'タグメモ', content:'', attachments:[]}], currentMemoIdx:0}; }

// === Search & Replace ===
function getSearchRegex() {
    const pattern = document.getElementById('search-pattern')?.value || '';
    const flags = document.getElementById('search-case')?.checked ? 'g' : 'gi';
    try { return new RegExp(pattern, flags); } catch { return null; }
}

function collectSearchResults() {
    const regex = getSearchRegex();
    if (!regex) return [];
    const text = editor.value;
    let match, results = [];
    while ((match = regex.exec(text)) !== null) { results.push(match); }
    return results;
}

function toggleSearchPanel(forceOpen = false, forceClose = false) {
    const panel = document.getElementById('search-panel');
    if (!panel) return;
    if (forceClose) { panel.classList.remove('show'); return; }
    if (forceOpen || !panel.classList.contains('show')) { panel.classList.add('show'); document.getElementById('search-pattern')?.focus(); }
}

function findNext() {
    const results = collectSearchResults();
    if (!results.length) return showToast('見つかりません', 'error');
    const curPos = editor.selectionEnd;
    let nextResult = results.find(r => r.index >= curPos);
    if (!nextResult) nextResult = results[0];
    editor.setSelectionRange(nextResult.index, nextResult.index + nextResult[0].length);
    editor.focus();
}

function replaceCurrent() {
    const results = collectSearchResults();
    if (!results.length) return;
    const regex = getSearchRegex();
    const replacement = document.getElementById('search-replacement')?.value || '';
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end);
    if (regex.test(selected)) {
        const replaced = selected.replace(regex, replacement);
        editor.setRangeText(replaced);
        save();
        updateHighlight();
        updateStats();
    }
}

function replaceAllMatches() {
    const regex = getSearchRegex();
    if (!regex) return;
    const replacement = document.getElementById('search-replacement')?.value || '';
    const before = editor.value;
    const after = before.replace(regex, replacement);
    const count = (before.match(regex) || []).length;
    editor.value = after;
    save();
    updateHighlight();
    updateStats();
    showToast(`${count} 件を置換しました`, 'success');
}

// === Highlight ===
function ensureHighlightMirror() {
    if (!hl) return;
    hl.style.height = editor.scrollHeight + 'px';
    hl.scrollTop = editor.scrollTop;
}

function updateHighlight() {
    ensureHighlightMirror();
    const pattern = document.getElementById('highlight-pattern')?.value || '';
    if (!pattern) { hl.innerHTML = ''; return; }
    try {
        const regex = new RegExp(pattern, document.getElementById('highlight-case')?.checked ? 'g' : 'gi');
        const highlighted = editor.value.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(regex, m => `<mark>${escapeHtml(m)}</mark>`);
        hl.innerHTML = highlighted;
    } catch {}
}

// === Stats & Analytics ===
function updateStats() {
    const rawText = editor.value;
    const totalChars = rawText.length;
    const readableChars = rawText.replace(/[\s\u3000]/g, "").length;
    const minutes = readableChars / 600;
    let readingText;
    if (minutes < 1) { readingText = `約 ${Math.max(1, Math.round(minutes * 60))} 秒`; }
    else { const min = Math.floor(minutes); const sec = Math.round((minutes - min) * 60); readingText = sec > 0 ? `約 ${min} 分 ${sec} 秒` : `約 ${min} 分`; }
    document.getElementById('stats-display').innerText = `${totalChars} 文字（実質 ${readableChars}）｜ 読了 ${readingText}`;
    const now = Date.now();
    state.writingSessions = (state.writingSessions || []).filter(x => now - x.t < 1000*60*60*24*14);
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
    const points = recent.map(s => `${new Date(s.t).toLocaleDateString().slice(5)}:${s.c}`).join(' / ');
    document.getElementById('session-stats').innerHTML = `<div class="config-item" style="white-space:normal;">最近の文字数推移: ${points || 'データなし'}</div>`;
    const cvs = document.getElementById('writing-graph');
    if (cvs) {
        const ctx = cvs.getContext('2d');
        const w = cvs.width, h = cvs.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#999'; ctx.strokeRect(0, 0, w, h);
        const vals = recent.map(x => x.c);
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
    document.getElementById('top-words').innerHTML = `<div class="config-item" style="white-space:normal;">頻出語（日本語分かち書き）: ${topEntries.map(([w, c]) => `${w}(${c})`).join(' / ') || 'データなし'}</div>`;
    const paragraphCount = editor.value.split(/\n{2,}/).filter(Boolean).length;
    const sentenceCount = (editor.value.match(/[。！？!?]/g) || []).length;
    const avgSentence = sentenceCount ? Math.round(editor.value.replace(/\s/g, '').length / sentenceCount) : 0;
    document.getElementById('other-stats').innerHTML = `<div class="config-item" style="white-space:normal;">段落数: ${paragraphCount} / 文数: ${sentenceCount} / 1文平均: ${avgSentence}文字</div>`;
}

function extractJapaneseTerms(text) {
    const matches = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/g) || [];
    const freq = {};
    matches.forEach(m => { freq[m] = (freq[m] || 0) + 1; });
    return freq;
}
