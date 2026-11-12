(() => {
  const find = id => document.getElementById(id);
  let pending = false;
  let dirty = false;
  function showRoles() { find('child-roles').style.display = find('child-mode').value === 'manual' ? 'flex' : 'none'; }
  for (const id of ['child-mode','child-work','child-review']) find(id).onchange = () => {
    dirty = true; find('child-saved').textContent = ''; showRoles();
  };
  find('models-reload').onclick = () => refresh({action:'reload-models'});
  find('child-save').onclick = async () => {
    if (pending) return;
    await refresh({action:'subagents',settings:Object.fromEntries(['mode','work','review'].map(k=>[k,find('child-'+k).value]))});
  };
  async function refresh(body) {
    if (pending) return;
    pending = true; find('child-save').disabled = true;
    try {
      const state = await window.keiAdmin.executors(body);
      if (body?.action === 'reload-models') { dirty=false; find('child-saved').textContent='モデル一覧を更新しました'; }
      if (body?.action === 'subagents') { dirty = false; find('child-saved').textContent = '保存済み'; }
      if (state.dsh_models) {
        for (const role of ['work','review']) {
          const select=find('child-'+role);
          const signature=JSON.stringify(state.dsh_models);
          if (select.dataset.catalog!==signature) {
            const previous=select.value;
            select.replaceChildren(...Object.entries(state.dsh_models).map(([alias,m])=>new Option(m.label+' · '+m.provider,alias)));
            if (Object.hasOwn(state.dsh_models,previous)) select.value=previous;
            select.dataset.catalog=signature;
          }
        }
      }
      if (!dirty && state.subagents) {
        for (const k of ['mode','work','review']) find('child-'+k).value=state.subagents[k];
        showRoles();
      }
      const codex = find('executor-backend').querySelector('option[value="codex"]');
      codex.disabled = !state.codex_available;
      codex.textContent = state.codex_available ? 'Codex（独立プロセス）' : 'Codex（権限の確認に失敗・利用不可）';
      if (body || document.activeElement !== find('executor-backend')) find('executor-backend').value = state.backend;
      const workers = Object.entries(state.workers).map(([name, w]) => `${name}：${w.running ? `動作中 · PID ${w.pid} · ${w.sessions} セッション` : '停止中'}`);
      find('executor-status').textContent = `現在：${state.backend}\nタスク：${state.active_task || '待機中'}\n${workers.join('\n') || 'まだ起動していません'}\n最近のタスク：${state.recent.map(t => `${t.backend} ${t.task_id.slice(0, 8)} ${t.status}`).join('、') || 'なし'}`;
      if (state.child_activity?.length) find('executor-status').textContent += '\n子タスク：' + state.child_activity.map(c=>c.role+' ('+c.model+') '+c.state).join('、');
      find('executor-error').textContent = state.catalog_error || '';
    } catch (error) { find('executor-error').textContent = error.message; }
    finally { pending = false; find('child-save').disabled=false; }
  }
  find('executor-select').onclick = () => refresh({action: 'select', backend: find('executor-backend').value});
  find('executor-cancel').onclick = () => refresh({action: 'cancel'});
  find('executor-release').onclick = () => refresh({action: 'release'});
  refresh();
  const timer = setInterval(() => refresh(), 3000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
