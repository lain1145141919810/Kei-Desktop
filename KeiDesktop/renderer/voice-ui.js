(() => {
  const mode = document.getElementById('voice-mode');
  const key = document.getElementById('voice-key');
  const toggle = document.getElementById('voice-toggle');
  const status = document.getElementById('voice-status');
  let busy = false;
  async function run(action='status', value) {
    if (busy) return;
    busy = true;
    try {
      const s = await window.keiAdmin.voice(action, value);
      mode.value = s.mode; key.value = s.key;
      toggle.disabled = s.mode !== 'manual';
      toggle.textContent = s.recording ? '終了して送信' : '録音を開始';
      status.textContent = `${s.mode === 'auto' ? '自動で終了を判定' : s.recording ? `録音中 · ${(s.duration_ms/1000).toFixed(1)} 秒` : '手動モード · 開始待ち'} · ショートカット ${s.key}${s.registered ? '' : '（未登録）'}${s.error ? ' · '+s.error : ''}`;
    } catch(e) { status.textContent = `操作を完了できませんでした：${e.message}`; }
    finally { busy = false; }
  }
  mode.addEventListener('change', () => run('mode',mode.value));
  key.addEventListener('change', () => run('key',key.value));
  toggle.addEventListener('click', () => run('toggle'));
  run(); setInterval(() => run(), 700);
})();
