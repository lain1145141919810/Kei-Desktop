const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const gestures = [];
const expressions = [];
const adapter = {
    getExpressionCapabilities: () => ['neutral', 'happy', 'gentle', 'thoughtful'],
    setExpression(name) { expressions.push(name); return true; },
    playGesture(name) { gestures.push(name); return true; },
    cancelGesture() { gestures.push('cancel'); },
};
const context = {
    KeiLive2D: adapter,
    LookController: class { setSpeaking() {} setVisible() {} },
    IdleMotionController: class { setSpeaking() {} setVisible() {} },
    setTimeout: () => 1,
    clearTimeout() {},
};
context.window = context;
vm.createContext(context);
const characterDir = path.join(__dirname, '..', 'renderer', 'character');
for (const name of ['expression_resolver', 'expression_controller', 'character_controller']) {
    vm.runInContext(fs.readFileSync(path.join(characterDir, `${name}.js`), 'utf8'), context);
}

const character = new context.CharacterController(null);
character.reserveExpressionForTurn('first');
assert.equal(character.beginExpressionForTurn('first', {
    valence: 0.7, arousal: 0.7, intensity: 0.7, warmth: 0.8, restraint: 0.4,
}), true);
assert.deepEqual(gestures, ['brighten']);
character.beginExpressionForTurn('first', {
    valence: 0.7, arousal: 0.7, intensity: 0.7, warmth: 0.8, restraint: 0.4,
});
assert.deepEqual(gestures, ['brighten'], 'speech parts do not restart a gesture');

character.reserveExpressionForTurn('second');
assert.equal(character.beginExpressionForTurn('first', null), false);
assert.deepEqual(gestures, ['brighten'], 'retired turn cannot start a gesture');
assert.equal(character.beginExpressionForTurn('second', {
    valence: 0.05, arousal: 0.3, intensity: 0.4, warmth: 0.5, certainty: 0.2,
}), true);
assert.deepEqual(gestures, ['brighten', 'ponder']);

character.interrupt();
assert.equal(gestures.at(-1), 'cancel');
assert.equal(expressions.at(-1), 'neutral');
console.log('character gesture flow passed');
