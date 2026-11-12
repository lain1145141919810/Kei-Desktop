const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        textContent: '', dataset: {}, children: [], className: '',
        classList: { add() {}, remove() {} },
        appendChild(child) { this.children.push(child); },
        replaceChildren() { this.children = []; },
        setAttribute() {},
    };
}

const panel = element();
let workTicker = null;
const parts = new Map();
panel.querySelector = selector => {
    if (!parts.has(selector)) parts.set(selector, element());
    return parts.get(selector);
};
const uiLayer = { querySelector: () => panel };
const document = { body: element(), createElement: element };
const backgroundLayer = element();
const root = element();
const context = {
    document,
    window: {
        KEI_SCENES: { cg2: { seatedImage: 'work.png', characterPresentation: 'seated-still' } },
        setTimeout: () => 1,
        setInterval(callback) { workTicker = callback; return 2; },
        clearInterval() { workTicker = null; },
    },
    console: { warn() {} },
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'scene', 'scene_controller.js'), 'utf8'), context);
const scene = new context.window.SceneController({ root, backgroundLayer, uiLayer });
assert.equal(backgroundLayer.children.length, 2, 'seated art and aligned monitor activity layer exist');
assert.equal(backgroundLayer.children[1].className, 'scene-monitor-fx');

scene.beginAgent('turn-a');
scene.toolStart('turn-a', { tool_name: 'deepseek_web_search', activity: 'searching', subject: '凯伊 最新动态' });
assert.equal(scene.currentScene, 'cg2');
assert.equal(root.dataset.workActivity, 'searching');
assert.equal(typeof workTicker, 'function');
assert.match(parts.get('.scene-work-steps').children[0].textContent, /資料検索 · 実行中/);
assert.match(parts.get('.scene-work-steps').children[0].textContent, /凯伊 最新动态/);
workTicker();
assert.match(parts.get('.scene-work-steps').children[0].textContent, /秒/);

scene.toolEnd('turn-a', {
    tool_name: 'deepseek_web_search', activity: 'searching', status: 'completed',
    result_count: 2, result_previews: [
        { title: '官方发布说明', snippet: '主要变化已经公布', source: 'example.com' },
        { title: '第二条资料', snippet: '' },
    ],
});
assert.match(parts.get('.scene-work-steps').children[0].textContent, /完了 · 2 件の出典/);
assert.equal(workTicker, null);
assert.equal(root.dataset.workActivity, 'organizing');
assert.equal(parts.get('.scene-work-findings').children.length, 2);
assert.equal(parts.get('.scene-work-findings').children[0].textContent, '手がかり：官方发布说明 · example.com\n主要变化已经公布');

scene.toolStart('turn-a', { tool_name: 'read_page', activity: 'reading' });
scene.toolEnd('turn-a', { tool_name: 'read_page', activity: 'reading', status: 'failed' });
assert.match(parts.get('.scene-work-steps').children[1].textContent, /未完了/);
assert.equal(scene.completedActivities.includes('reading'), false);

scene.toolStart('turn-a', {
    tool_name: 'astrbot_execute_shell', activity: 'reading', step_label: '检索本地内容',
});
assert.match(parts.get('.scene-work-steps').children[2].textContent, /检索本地内容 · 実行中/);
scene.toolEnd('turn-a', { tool_name: 'astrbot_execute_shell', activity: 'reading' });

scene.markResultReady('turn-a', { has_reply: true });
scene.renderResult('turn-a', '完整回答', '简要结果');
assert.equal(scene.currentScene, 'cg2', 'work scene remains until speech starts');
scene.startResultPresentation('turn-a');
assert.equal(scene.currentScene, 'cg1');
assert.equal(root.dataset.workActivity, 'idle');
assert.equal(parts.get('.scene-result-summary').textContent, '简要结果');

scene.interrupt('turn-a');
scene.beginAgent('turn-b');
assert.equal(parts.get('.scene-work-steps').children.length, 0);
assert.equal(parts.get('.scene-work-findings').children.length, 0);
scene.toolStart('turn-b', { tool_name: 'deepseek_web_search', activity: 'searching' });
scene.toolStart('turn-b', { tool_name: 'unclassified_tool' });
assert.equal(root.dataset.workActivity, 'searching', 'unknown concurrent tool preserves visible work activity');
scene.toolEnd('turn-b', { tool_name: 'unclassified_tool' });
assert.equal(root.dataset.workActivity, 'searching');
scene.interrupt('turn-b');
assert.equal(scene.toolEnd('turn-a', { tool_name: 'web_search_tavily', activity: 'searching' }), false);
assert.equal(scene.currentScene, 'cg1');
assert.equal(root.dataset.workActivity, 'idle');

assert.equal(scene.handleRuntimeEvent({
    type: 'agent.scene.snapshot', turn_id: 'turn-b', payload: {
        revision: 4,
        steps: [{
            tool_name: 'deepseek_web_search', activity: 'searching', status: 'running',
            started_at_ms: Date.now() - 5000, subject: '重连中的搜索',
        }],
    },
}), true);
assert.equal(scene.currentScene, 'cg2');
assert.equal(root.dataset.workActivity, 'searching');
assert.match(parts.get('.scene-work-steps').children[0].textContent, /重连中的搜索/);
assert.equal(scene.handleRuntimeEvent({
    type: 'agent.tool.end', turn_id: 'turn-b', payload: {
        scene_revision: 5, tool_name: 'deepseek_web_search', activity: 'searching', status: 'completed',
    },
}), true);
assert.equal(root.dataset.workActivity, 'organizing');
assert.equal(scene.handleRuntimeEvent({
    type: 'agent.scene.snapshot', turn_id: 'turn-b', payload: { revision: 4, steps: [] },
}), false, 'an older snapshot cannot rewind a live event');
assert.equal(scene.handleRuntimeEvent({
    type: 'agent.scene.snapshot', turn_id: null, payload: { revision: 6, steps: [] },
}), true);
assert.equal(scene.currentScene, 'cg1');
assert.equal(root.dataset.workActivity, 'idle');
scene.resetToIdle(null, { clearRevision: true });
assert.equal(scene.lastSceneRevision, 0, 'a new connection may replay the current revision');
console.log('scene work progress passed');
