let observing = false;
async function refreshCompanion() {
    try {
        const state = await window.keiAdmin.companion('status');
        observing = state.enabled;
        document.getElementById('observe').textContent = observing ? '画面観察を停止' : '画面観察を開始';
        document.getElementById('observe-status').textContent = (observing ? '観察中' : '停止中') + (state.busy ? ' · 認識中' : '') + '\n' + (state.error || state.description || '') + ((!state.shortcuts.observation || !state.shortcuts.selection) ? '\nショートカットが他のアプリに使われています。Ctrl+Alt+S / Q を解放して Desktop を再起動してください。' : '');
    } catch (e) { document.getElementById('observe-status').textContent = e.message; }
}
window.keiAdmin.onSelection(state => {
    document.getElementById('reading-text').value = state.selection;
    document.getElementById('reading-status').textContent = state.error || '選択範囲を読み取りました。確認してから質問してください。';
    document.getElementById('reading-text').scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('observe').onclick = async () => { await window.keiAdmin.companion('toggle', !observing); await refreshCompanion(); };
document.getElementById('reading-send').onclick = async () => {
    const button = document.getElementById('reading-send'); button.disabled = true;
    try {
        await window.keiAdmin.companion('ask', { text: document.getElementById('reading-text').value, question: document.getElementById('reading-question').value });
        document.getElementById('reading-status').textContent = 'Desktop の会話に送りました。日本語の返答と再生をお待ちください。';
    } catch (e) { document.getElementById('reading-status').textContent = e.message; }
    finally { button.disabled = false; }
};
window.keiAdmin.companion('status').then(state => { document.getElementById('reading-text').value = state.selection; }).catch(() => {});
const companionTimer = setInterval(refreshCompanion, 2000);
window.addEventListener('beforeunload', () => clearInterval(companionTimer));
refreshCompanion();
