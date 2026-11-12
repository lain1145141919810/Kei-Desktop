// Conversation shell: composer, "you said" line, and the backlog drawer.
// app.js forwards runtime events through window.KeiConversation.
(() => {
    const bridge = window.keiDesktop;
    const find = id => document.getElementById(id);
    const composer = find('composer');
    const input = find('composer-input');
    const sendButton = find('composer-send');
    const composerStatus = find('composer-status');
    const echo = find('user-echo');
    const echoText = find('user-echo-text');
    const drawer = find('backlog');
    const backlogButton = find('backlog-button');
    const body = find('backlog-body');
    const title = find('backlog-title');
    const backButton = find('backlog-back');
    const search = find('backlog-search');
    const removeButton = find('backlog-remove');
    const clearButton = find('backlog-clear');
    const resume = document.createElement('button');
    const fresh = document.createElement('button');
    for (const [button, action, label] of [[resume,'resume','この会話を続ける'],[fresh,'new','新しい会話']]) {
        button.type = 'button';
        button.className = 'sheet-tool';
        button.textContent = label;
        clearButton.before(button);
        button.addEventListener('click', async () => {
            button.disabled = true;
            try { await history(action, view.convId); setOpen(false); }
            catch (error) { empty(error.message); }
            finally { button.disabled = false; }
        });
    }

    let connected = false;
    let sending = false;
    let echoTimer = null;
    let pendingTimer = null;
    // view.live follows whichever conversation is current; a reopened one stays put.
    let view = { mode: 'thread', convId: null, live: true };
    let viewRequest = 0;
    let searchTimer = null;

    const history = (action, data) => bridge?.history
        ? bridge.history(action, data)
        : Promise.reject(new Error('履歴は Kei Desktop のウィンドウ内でのみ利用できます'));

    const api = {};
    const model = new window.KeiConversationModel.ConversationModel({
        describeStep: payload => api.describeStep?.(payload) ?? null,
        persist: entry => {
            if (entry.role === 'user') showEcho(entry.text);
            history('record', entry).then(stored => onStored(stored)).catch(error => {
                console.error('[Kei Conversation] record failed:', error.message);
            });
        },
        onPending: turnId => {
            clearTimeout(pendingTimer);
            echo.classList.toggle('is-waiting', Boolean(turnId));
            // Never leave a spinner behind if the runtime answers under another turn id.
            if (turnId) pendingTimer = setTimeout(() => model.clearPending(), 90000);
        },
    });

    // ---------------------------------------------------------------
    // Composer
    // ---------------------------------------------------------------

    function setStatus(text, tone = '') {
        composerStatus.textContent = text;
        composerStatus.dataset.tone = tone;
    }

    // Files dropped on the window wait here until the message is sent.
    const fileList = find('composer-files');
    let attachments = [];
    const MAX_FILES = 5;

    function renderAttachments() {
        fileList.replaceChildren(...attachments.map((file, index) => {
            const chip = node('span', 'file-chip');
            chip.append(node('span', 'file-chip-name', file.name));
            const remove = node('button', 'file-chip-remove', '×');
            remove.type = 'button';
            remove.setAttribute('aria-label', `${file.name} を外す`);
            remove.addEventListener('click', () => { attachments.splice(index, 1); renderAttachments(); });
            chip.append(remove);
            return chip;
        }));
        refreshComposer();
    }

    function addFiles(files) {
        const room = MAX_FILES - attachments.length;
        if (files.length > room) setStatus(`ファイルは一度に ${MAX_FILES} 個までです`, 'error');
        attachments.push(...files.slice(0, Math.max(0, room)));
        renderAttachments();
        if (files.length) { window.KeiReactions?.play('file-received'); input.focus(); }
    }

    let dragDepth = 0;
    const carriesFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth += 1;
        document.body.classList.add('file-dragging');
    });
    window.addEventListener('dragover', event => { if (carriesFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('dragleave', event => {
        if (!carriesFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) document.body.classList.remove('file-dragging');
    });
    window.addEventListener('drop', event => {
        if (!carriesFiles(event)) return;
        // Without this the window would navigate to the dropped file.
        event.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('file-dragging');
        addFiles([...event.dataTransfer.files]);
    });

    function refreshComposer() {
        sendButton.disabled = sending || (!input.value.trim() && !attachments.length);
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
    }

    function showEcho(text) {
        clearTimeout(echoTimer);
        echoText.textContent = text.replace(/\s+/g, ' ').slice(0, 160);
        echo.classList.add('visible');
        echoTimer = setTimeout(() => {
            if (!echo.classList.contains('is-waiting')) echo.classList.remove('visible');
        }, 20000);
    }

    async function send() {
        const text = input.value.trim();
        if ((!text && !attachments.length) || sending) return;
        if (!bridge?.sendChat) return setStatus('Kei Desktop のウィンドウ内でのみ送信できます', 'error');
        sending = true;
        refreshComposer();
        setStatus('送信中…');
        try {
            const { turnId, files = [] } = await bridge.sendChat(text, attachments);
            model.addLocalUser(turnId, text || '（ファイルを渡しました）', files.map(file => file.name));
            // The runtime may not echo a typed message, so acknowledge it here.
            window.KeiReactions?.play('heard');
            input.value = '';
            attachments = [];
            renderAttachments();
            setStatus(files.length ? `${files.length} 個のファイルを実行エージェントの作業フォルダーに置きました` : '');
        } catch (error) {
            // Keep the draft: nothing reached the runtime.
            const reason = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            setStatus(connected ? `送信できませんでした：${reason}` : 'ケイのランタイムに接続できていません。少し待ってからもう一度どうぞ', 'error');
        } finally {
            sending = false;
            refreshComposer();
            input.focus();
        }
    }

    input.addEventListener('input', () => { if (composerStatus.dataset.tone === 'error') setStatus(''); refreshComposer(); });
    input.addEventListener('keydown', event => {
        // Enter confirms an IME candidate first; only a plain Enter sends.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send();
        }
    });
    composer.addEventListener('submit', event => { event.preventDefault(); send(); });

    // ---------------------------------------------------------------
    // Backlog drawer
    // ---------------------------------------------------------------

    const clock = timestamp => new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    function day(timestamp) {
        const date = new Date(timestamp);
        const today = new Date();
        const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate())
            - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
        if (days === 0) return '今日';
        if (days === 1) return '昨日';
        return date.toLocaleDateString('ja-JP', date.getFullYear() === today.getFullYear()
            ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
    }

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function entryNode(entry) {
        const item = node('article', `log-entry log-${entry.role}`);
        item.dataset.entryId = entry.id;
        const meta = node('div', 'log-meta');
        meta.append(node('span', 'log-name', entry.role === 'kei' ? 'ケイ' : 'あなた'));
        const notes = [clock(entry.ts)];
        if (entry.source === 'voice') notes.push('音声');
        if (entry.status === 'interrupted') notes.push('中断');
        meta.append(node('span', 'log-time', notes.join(' · ')));
        item.append(meta);
        // Kei is read in Japanese, as spoken. The original reply text is only a
        // fallback for answers whose translation never arrived.
        const line = entry.role === 'kei' ? (entry.ja || entry.text) : entry.text;
        if (line) item.append(node('p', 'log-text', line));
        if (entry.files?.length) item.append(node('p', 'log-files', `添付：${entry.files.join('、')}`));
        if (entry.steps?.length) {
            const steps = node('ul', 'log-steps');
            const marks = { completed: '済', failed: '失敗', cancelled: '中止', running: '実行中' };
            for (const step of entry.steps) {
                const count = Number.isInteger(step.count) ? `（${step.count} 件）` : '';
                const row = node('li', `log-step log-step-${step.status}`, `${step.label}${count}`);
                row.append(node('span', 'log-step-mark', marks[step.status] || ''));
                steps.append(row);
            }
            item.append(steps);
        }
        if (entry.summary) item.append(node('p', 'log-summary', entry.summary));
        return item;
    }

    function empty(text) {
        body.replaceChildren(node('p', 'backlog-empty', text));
    }

    function resetConfirm(button) {
        clearTimeout(button.confirmTimer);
        delete button.dataset.confirm;
        button.textContent = button.dataset.label;
    }

    // Deleting is irreversible, so the same button asks once before acting.
    function confirming(button, action) {
        button.dataset.label = button.textContent;
        button.addEventListener('click', async () => {
            if (!button.dataset.confirm) {
                button.dataset.confirm = '1';
                button.textContent = 'もう一度押すと削除';
                button.confirmTimer = setTimeout(() => resetConfirm(button), 4000);
                return;
            }
            resetConfirm(button);
            try { await action(); } catch (error) { empty(`操作を完了できませんでした：${error.message}`); }
        });
    }

    function setView(next) {
        view = next;
        viewRequest += 1;
        drawer.dataset.view = next.mode;
        backButton.hidden = next.mode !== 'thread';
        removeButton.hidden = next.mode !== 'thread' || !next.convId;
        clearButton.hidden = next.mode !== 'list';
        fresh.hidden = next.mode !== 'list';
        resume.hidden = next.mode !== 'thread' || next.live;
        search.parentElement.hidden = next.mode !== 'list';
        resetConfirm(removeButton);
        resetConfirm(clearButton);
        return viewRequest;
    }

    function renderThread(conversation) {
        title.textContent = conversation
            ? `${day(conversation.started)} ${clock(conversation.started)}${conversation.current ? ' · 進行中' : ''}`
            : '今の会話';
        if (!conversation) return empty('まだ会話がありません。ケイに話しかけるか、入力してみてください。');
        body.replaceChildren(...conversation.entries.map(entryNode));
        body.scrollTop = body.scrollHeight;
    }

    async function openThread(convId, live) {
        const request = setView({ mode: 'thread', convId, live });
        try {
            const conversation = live ? await history('current') : await history('read', convId);
            if (request !== viewRequest) return;
            view.convId = conversation?.id || null;
            removeButton.hidden = !view.convId;
            if (!conversation && !live) return openList();
            renderThread(conversation);
        } catch (error) { if (request === viewRequest) empty(error.message); }
    }

    async function openList() {
        const request = setView({ mode: 'list', convId: null, live: false });
        title.textContent = 'すべての会話';
        try {
            const query = search.value.trim();
            const conversations = await history('list', { query });
            if (request !== viewRequest) return;
            if (!conversations.length) return empty(query ? `「${query}」を含む会話は見つかりませんでした。` : '保存された会話はまだありません。');
            let lastDay = '';
            const items = [];
            for (const conversation of conversations) {
                const label = day(conversation.updated);
                if (label !== lastDay) { items.push(node('h3', 'backlog-day', label)); lastDay = label; }
                const button = node('button', 'backlog-item');
                button.type = 'button';
                const head = node('div', 'backlog-item-head');
                head.append(node('span', 'backlog-item-title', conversation.title || '（テキストなし）'));
                head.append(node('span', 'backlog-item-meta',
                    `${conversation.current ? '進行中 · ' : ''}${clock(conversation.started)} · ${conversation.count} 件`));
                button.append(head);
                if (conversation.snippet) button.append(node('div', 'backlog-item-snippet', conversation.snippet));
                button.addEventListener('click', () => openThread(conversation.id, conversation.current));
                items.push(button);
            }
            body.replaceChildren(...items);
            body.scrollTop = 0;
        } catch (error) { if (request === viewRequest) empty(error.message); }
    }

    function onStored(entry) {
        if (!entry || !isOpen() || view.mode !== 'thread') return;
        // A live view follows the conversation that the new entry belongs to.
        if (view.live && entry.conv !== view.convId) { openThread(null, true); return; }
        if (entry.conv !== view.convId) return;
        const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
        const fresh = entryNode(entry);
        const previous = [...body.children].find(child => child.dataset?.entryId === entry.id);
        if (previous) previous.replaceWith(fresh);
        else {
            body.querySelector('.backlog-empty')?.remove();
            body.append(fresh);
        }
        if (pinned) body.scrollTop = body.scrollHeight;
    }

    const isOpen = () => document.body.classList.contains('backlog-open');
    function setOpen(open) {
        document.body.classList.toggle('backlog-open', open);
        drawer.setAttribute('aria-hidden', String(!open));
        drawer.inert = !open;
        backlogButton.setAttribute('aria-expanded', String(open));
        if (open) openThread(null, true);
        else input.focus();
    }

    backlogButton.addEventListener('click', () => setOpen(!isOpen()));
    find('backlog-close').addEventListener('click', () => setOpen(false));
    backButton.addEventListener('click', openList);
    search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { if (view.mode === 'list') openList(); }, 180);
    });
    confirming(removeButton, async () => { await history('remove', view.convId); await openList(); });
    confirming(clearButton, async () => { await history('clear'); await openList(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isOpen()) { event.preventDefault(); setOpen(false); }
    });
    find('backlog-scrim').addEventListener('click', () => setOpen(false));
    document.addEventListener('kei:close-overlays', () => { if (isOpen()) setOpen(false); });

    drawer.inert = true;
    refreshComposer();

    window.KeiConversation = Object.assign(api, {
        handleRuntimeEvent: event => { model.handle(event); },
        // A message another part of this window sent (the reading sheet).
        addLocalUser: (turnId, text) => { model.addLocalUser(turnId, text); window.KeiReactions?.play('heard'); },
        // A turn the desktop started by itself: its prompt is not something the user said.
        ignoreUserTurn: turnId => { model.localTurns.add(turnId); },
        isPending: () => model.pendingTurn !== null,
        // Kei's most recent answer in this session, for the idle overview.
        lastAnswer() {
            const entry = [...model.entries.values()].reverse().find(item => item.role === 'kei' && (item.ja || item.text));
            return entry ? { text: entry.ja || entry.text, steps: entry.steps, interrupted: entry.status === 'interrupted' } : null;
        },
        setConnected(value) {
            connected = Boolean(value);
            document.body.dataset.connection = connected ? 'online' : 'offline';
            input.placeholder = connected ? 'ケイに話しかける…（Enter で送信、Shift+Enter で改行）' : 'ケイのランタイムに接続中…';
            if (!connected) model.disconnected();
            else if (composerStatus.dataset.tone === 'error') setStatus('');
        },
    });
})();
