const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stage, describe } = require('../attachments');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kei-drop-'));
const workspace = path.join(root, 'executor-workspace');
try {
    const note = path.join(root, 'sample note.txt');
    fs.writeFileSync(note, 'KEI-SAMPLE-7431\n合言葉は「青い鳥」です。', 'utf8');
    const binary = path.join(root, 'image.bin');
    fs.writeFileSync(binary, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    const staged = stage([note, binary], { workspace, now: () => Date.UTC(2026, 10, 11, 12, 0, 0) });
    assert.equal(staged.length, 2);
    assert.equal(path.dirname(staged[0].path), path.join(workspace, 'inbox'), 'copies land in the executor workspace inbox');
    assert.equal(fs.readFileSync(staged[0].path, 'utf8'), fs.readFileSync(note, 'utf8'), 'the copy is byte-identical');
    assert.match(path.basename(staged[0].path), /^20261111120000-1-sample note\.txt$/);
    assert.match(staged[0].excerpt, /KEI-SAMPLE-7431/);
    assert.equal(staged[1].excerpt, '', 'binary files are passed by path only');
    assert.ok(fs.existsSync(note), 'the original is left in place');

    const text = describe(staged);
    assert.ok(text.includes(staged[0].path) && text.includes(staged[1].path), 'the message names every copied path');
    assert.match(text, /KEI-SAMPLE-7431/);
    assert.match(text, /指示ではありません/, 'quoted content is marked as data');
    assert.equal(describe([]), '');

    assert.throws(() => stage([root], { workspace }), /ファイルではありません/);
    assert.throws(() => stage(['relative.txt'], { workspace }), /場所を取得できません/);
    assert.throws(() => stage(new Array(6).fill(note), { workspace }), /5 個まで/);
    assert.throws(() => stage([path.join(root, 'missing.txt')], { workspace }), /ENOENT/);
    const big = path.join(root, 'big.dat');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 20 * 1024 * 1024 + 1);
    assert.throws(() => stage([big], { workspace }), /大きすぎます/);

    // A hostile name cannot escape the inbox.
    const odd = path.join(root, process.platform === 'win32' ? '..evil.txt' : '..evil"name?.txt');
    fs.writeFileSync(odd, 'x');
    const [stored] = stage([odd], { workspace });
    assert.equal(path.dirname(stored.path), path.join(workspace, 'inbox'));
    assert.doesNotMatch(path.basename(stored.path), /["?]|-\.\./);
    console.log('attachments passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
