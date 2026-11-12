(() => {
    const list = document.querySelector('#storage-items');
    const status = document.querySelector('#storage-status');
    async function update() {
        try {
            const {items} = await window.keiAdmin.storage({action:'list'});
            const previous = new Map([...list.children].map(group => [group.dataset.day,group.open]));
            const groups = new Map();
            const dayKey = new Intl.DateTimeFormat('sv-SE', {year:'numeric',month:'2-digit',day:'2-digit'});
            const fragment = document.createDocumentFragment();
            items.sort((a,b) => (Date.parse(b.date)||0) - (Date.parse(a.date)||0));
            for (const x of items) {
                const time = Date.parse(x.date);
                const day = Number.isFinite(time) ? dayKey.format(time) : '日付不明';
                if (!groups.has(day)) {
                    const group = document.createElement('details');
                    group.dataset.day = day;
                    group.open = previous.get(day) ?? (groups.size === 0);
                    const summary = document.createElement('summary');
                    group.append(summary);
                    groups.set(day,{group,summary,count:0,bytes:0});
                    fragment.append(group);
                }
                const section = groups.get(day);
                section.count++;
                section.bytes += x.size;
                const row = document.createElement('p');
                const btn = document.createElement('button');
                btn.textContent = '削除';
                btn.disabled = x.locked;
                row.append(btn, document.createTextNode('  ' + [x.kind, x.title, Number.isFinite(time) ? new Date(time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}) : '', (x.size/1024).toFixed(1)+' KiB', x.status].filter(Boolean).join(' · ')));
                btn.onclick = async () => {
                    if (!window.confirm(x.title + ' の保存データを完全に削除しますか？')) return;
                    btn.disabled = true;
                    try { await window.keiAdmin.storage({action:'delete',kind:x.kind,id:x.id}); await update(); }
                    catch(e) { status.textContent=e.message; btn.disabled=false; }
                };
                section.group.append(row);
            }
            for (const [day,section] of groups) {
                section.summary.textContent = day + ' · ' + section.count + ' 件 · ' + (section.bytes/1024).toFixed(1) + ' KiB';
            }
            list.replaceChildren(fragment);
            status.textContent = items.length + ' 件';
        } catch(e) { status.textContent=e.message; }
    }
    document.querySelector('#storage-refresh').onclick=update;
    document.querySelector('a[href="#storage"]').addEventListener('click',update);
    document.querySelector('#storage-release').onclick=async () => {
        try {await window.keiAdmin.storage({action:'release'});status.textContent='待機中の実行器を終了しました';}
        catch(e) {status.textContent=e.message;}
    };
    update();
})();
