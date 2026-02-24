/* ===================================================================
 *  KakuDraft - app-ai.js
 *  AI integration (providers, models, chat, proofread)
 * =================================================================== */

// === AI Key Management ===
function getAIKeyInputId(provider) { return `ai-api-key-${provider}`; }

async function stashAllProviderKeys() {
    const providers = ['openrouter', 'groq', 'google'];
    for (const p of providers) {
        const input = document.getElementById(getAIKeyInputId(p));
        if (input?.value?.trim()) {
            state.aiKeysEnc[p] = await encryptPatToken(input.value.trim(), state.deviceName);
        }
    }
}

async function getProviderKey(provider) {
    const input = document.getElementById(getAIKeyInputId(provider));
    if (input?.value?.trim()) return input.value.trim();
    if (state.aiKeysEnc?.[provider]) {
        try { return await decryptPatToken(state.aiKeysEnc[provider], state.deviceName); } catch { }
    }
    return '';
}

// === AI Model & Provider ===
function switchAITab(tab) { state.aiTab = tab; refreshUI(); save(); }
function openAISettings() { togglePanel('menu-panel'); switchMenuTab('ai'); }

async function onAIProviderChange() {
    const provider = document.getElementById('ai-provider').value;
    if (!navigator.onLine) { showToast('オンライン時のみ利用できます', 'error'); return; }
    
    const key = await getProviderKey(provider);
    if (!key) return;
    
    try {
        setAIBusy(true);
        const models = await fetchAIModels();
        const sel = document.getElementById('ai-model');
        if (sel) {
            sel.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
            state.aiModel = models[0] || '';
        }
        showToast(`${models.length} 個のモデルを取得しました`, 'success');
    } catch (e) {
        showToast(`モデル取得失敗: ${e.message}`, 'error');
    } finally {
        setAIBusy(false);
    }
}

function getAIScopeText() {
    if (state.memoScope === 'local') return editor.value;
    if (state.memoScope === 'global') return (state.globalMemos || []).map(m => m.content).join('\n');
    const bundle = state.folderMemos?.[state.currentFolderId];
    return (bundle?.memos || []).map(m => m.content).join('\n');
}

function getValidAppOrigin() {
    if (location.origin === 'http://localhost:5173' || location.origin === 'http://localhost:3000') return 'http://localhost:5173';
    return location.origin;
}

function buildProviderHeaders(provider, key, withJson = true) {
    const headers = { 'Content-Type': withJson ? 'application/json' : 'application/octet-stream' };
    if (provider === 'openrouter') headers['Authorization'] = `Bearer ${key}`;
    else if (provider === 'groq') headers['Authorization'] = `Bearer ${key}`;
    else if (provider === 'google') {}
    return headers;
}

async function fetchAIModels() {
    const provider = document.getElementById('ai-provider').value;
    const key = await getProviderKey(provider);
    if (!key) throw new Error('APIキーが設定されていません');

    if (provider === 'openrouter') {
        const res = await fetch('https://openrouter.ai/api/v1/models');
        const data = await res.json();
        return (data.data || []).filter(m => !m.id.includes('vision')).map(m => m.id).slice(0, 20);
    }
    if (provider === 'groq') {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();
        return (data.data || []).map(m => m.id).slice(0, 20);
    }
    if (provider === 'google') {
        return ['gemini-pro', 'gemini-1.5-pro', 'gemini-2.0-flash'];
    }
    return [];
}

async function callAI(messages, jsonMode = false) {
    if (!navigator.onLine) throw new Error('オフライン中です');
    const provider = document.getElementById('ai-provider').value;
    const key = document.getElementById(getAIKeyInputId(provider))?.value.trim() || '';
    const model = document.getElementById('ai-model').value.trim();
    if (!key || !model) throw new Error('APIキーとモデルを設定してください');
    if (provider === 'google') {
        const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
        const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`, { method:'POST', headers: buildProviderHeaders('google', key), body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!text.trim()) throw new Error('AI応答が空でした。モデル設定や利用制限を確認してください。');
        updateAIUsage('google', j); return text;
    }
    const base = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
    const body = { model, messages, temperature: 0.4 };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const r = await fetch(base, { method:'POST', headers: buildProviderHeaders(provider, key), body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    const content = j.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text || '').join('') : '';
    if (!text.trim()) throw new Error('AI応答が空でした。モデル設定や利用制限を確認してください。');
    updateAIUsage(provider, j); return text;
}

async function sendAIChat() {
    if (aiBusy) return;
    const promptEl = document.getElementById('ai-prompt');
    try {
        const prompt = promptEl.value.trim();
        if (!prompt) return showToast('AIへの指示を入力してください', 'error');
        promptEl.value = ''; setAIBusy(true);
        const ans = await callAI([
            { role: 'system', content: 'あなたは日本語小説執筆を支援するアシスタントです。簡潔で実用的に答えてください。' },
            { role: 'user', content: `対象テキスト:\n${getAIScopeText().slice(0, 12000)}\n\n指示:\n${prompt}` }
        ], false);
        aiChatState = aiChatState || [];
        aiChatState.push({ q: prompt, a: ans, at: Date.now() });
        aiChatState = aiChatState.slice(-100);
        renderAIChatLog(); renderAIUsage();
        showToast('AIチャット応答を取得しました', 'success'); save();
    } catch (e) { showToast(`AIチャット失敗: ${e.message}`, 'error'); }
    finally { setAIBusy(false); queuePersist(); }
}

async function runAIProofread() {
    if (aiBusy) return;
    try {
        setAIBusy(true);
        const userPrompt = document.getElementById('ai-proofread-prompt').value.trim() || '誤字脱字・不自然表現・表記揺れを校閲してください';
        const text = await callAI([
            { role: 'system', content: '出力はJSONのみ。{replacements:[{from,to,reason}]} 形式で返してください。' },
            { role: 'user', content: `対象:\n${getAIScopeText().slice(0, 12000)}\n\n要件:${userPrompt}` }
        ], true);
        let data;
        try { data = JSON.parse(text); } catch { data = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"replacements":[]}'); }
        state.lastAISuggestions = data.replacements || [];
        renderAISuggestions();
        showToast(`校閲候補 ${state.lastAISuggestions.length} 件`, 'success');
    } catch (e) { showToast(`AI校閲失敗: ${e.message}`, 'error'); }
    finally { setAIBusy(false); }
}

function applyAISuggestion(i) {
    const r = (state.lastAISuggestions || [])[i];
    if (!r) return;
    editor.value = editor.value.split(r.from).join(r.to);
    state.lastAISuggestions.splice(i, 1);
    renderAISuggestions(); save(); updateHighlight(); updateStats();
    showToast(`置換適用: ${r.from} → ${r.to}`, 'success');
}

function ignoreAISuggestion(i) {
    if (!state.lastAISuggestions) return;
    state.lastAISuggestions.splice(i, 1); renderAISuggestions();
    showToast('この置き換えを無視しました', 'success');
}

function renderAISuggestions() {
    const reps = state.lastAISuggestions || [];
    document.getElementById('ai-suggestions').innerHTML = reps.map((r, i) => `<div class="config-item" style="align-items:flex-start;"><div style="flex:1;"><div><strong>${escapeHtml(r.from || '')}</strong> → <strong>${escapeHtml(r.to || '')}</strong></div><div style="font-size:11px;opacity:.8;">${escapeHtml(r.reason || '')}</div></div><button onclick="applyAISuggestion(${i})" title="適用"><span class="material-icons" style="font-size:19px;">published_with_changes</span></button><button onclick="ignoreAISuggestion(${i})" title="この置き換えは無視"><span class="material-icons" style="font-size:19px;">block</span></button></div>`).join('') || '<div class="config-item">候補なし</div>';
}

function renderMarkdown(text) {
    const src = String(text || '').replace(/\r\n/g, '\n');
    const lines = src.split('\n');
    const out = [];
    let inUl = false, inOl = false, inCode = false, tableRows = [];
    const inline = v => escapeHtml(v).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const flush = () => {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (tableRows.length) {
            const head = tableRows[0] || [], body = tableRows.slice(1);
            out.push('<table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
            tableRows = [];
        }
    };
    for (const line of lines) {
        if (line.trim().startsWith('```')) { flush(); out.push(inCode ? '</code></pre>' : '<pre><code>'); inCode = !inCode; continue; }
        if (inCode) { out.push(escapeHtml(line) + '\n'); continue; }
        if (line.includes('|')) {
            const cols = line.split('|').map(x => x.trim()).filter((_, i, arr) => !(i === 0 && arr[0] === '') && !(i === arr.length - 1 && arr[arr.length - 1] === '')).map(inline);
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
    aiChatState = []; renderAIChatLog(); renderAIUsage(); queuePersist();
    showToast('AIチャット履歴を削除しました', 'success');
}

function renderAIChatLog() {
    const log = document.getElementById('ai-chat-log');
    if (!log) return;
    const rows = (aiChatState || []).map(x => `<div class="config-item" style="display:block;"><div><strong>あなた:</strong></div><div class="md-content">${renderMarkdown(x.q || '')}</div><div><strong>AI:</strong></div><div class="md-content">${renderMarkdown(x.a || '')}</div></div>`);
    if (aiBusy) rows.push(`<div class="config-item" style="display:block;"><div><strong>AI:</strong></div><div class="md-content">AIが思考中${'.'.repeat(aiThinkingDots)}</div></div>`);
    log.innerHTML = rows.join('') || '<div class="config-item">会話履歴はありません</div>';
    log.scrollTop = log.scrollHeight;
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

window.addEventListener('online', onAIProviderChange);
window.addEventListener('offline', onAIProviderChange);
