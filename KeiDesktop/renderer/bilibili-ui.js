(() => {
  let pending = false;
  const find = id => document.getElementById(id);
  const labels = {draft:'プレビュー', published:'投稿済み', unknown:'結果不明・再試行なし', publishing:'投稿中', quarantined_input:'入力を隔離', quarantined_visual:'映像を隔離', quarantined_review:'再確認で不合格', skipped_no_full_subtitles:'根拠が不足', skipped_by_reader:'スキップ'};
  async function refresh(body) {
    if (pending) return;
    pending = true;
    try {
      const s = await window.keiAdmin.bilibili(body);
      find('bili-qr').hidden = !s.login_qr;
      if (s.login_qr && s.login_qr.startsWith('data:image/png;base64,')) find('bili-qr').src = s.login_qr;
      find('bili-status').textContent = `${s.enabled ? '自主活動オン' : '一時停止中'} · ${s.busy ? '処理中' : '待機中'} · ${s.owner_configured ? '本人アカウント連携済み' : 'QR コードでのログインが必要'}\n理解の方法：${s.evidence_mode === 'subtitles_only' ? '字幕' : 'フレームと字幕'}\n直近のエラー：${s.last_error || 'なし'}\n` + s.recent.map(x => `${x.bvid} · ${labels[x.state] || x.state}\n${x.summary || ''}\n${x.comment || ''}${x.rpid ? `\nコメント ID：${x.rpid}` : ''}`).join('\n\n');
      find('bili-error').textContent = '';
      if (s.scheduled_activity?.enabled) {
        const a = s.scheduled_activity;
        find('bili-status').textContent += `\n毎日の活動：${a.start}–${a.end}（${a.timezone}） · ${a.paused ? '一時停止中' : a.in_window ? '活動時間内' : '次の時間帯を待機中'}\n` +
          a.recent_actions.map(x => `${x.day} ${x.action} ${x.target} · ${x.state}`).join('\n');
      }
    } catch (e) { find('bili-error').textContent = e.message; }
    finally { pending = false; }
  }
  for (const action of ['login','start','stop','preview']) find(`bili-${action}`).onclick = () => refresh({action});
  refresh();
  const timer = setInterval(() => refresh(), 5000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
