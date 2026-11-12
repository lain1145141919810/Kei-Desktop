// Decides when a screen observation is worth showing to Kei so that she can
// choose to speak. Pure: every input is passed in.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KeiProactiveModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const SECOND = 1000;
    const RULES = {
        settle: 2 * 60 * SECOND,        // after switching on, watch for a while first
        minInterval: 10 * 60 * SECOND,  // at most one question to Kei per 10 minutes
        quietAfterTalk: 90 * SECOND,    // never right after a conversation
        freshness: 60 * SECOND,         // the observation must be current
        similarity: 0.6,                // "the screen changed" = less alike than this
    };

    // Share of words two descriptions have in common (0 = unrelated, 1 = same).
    function similarity(a, b) {
        const words = text => new Set(String(text).toLowerCase().match(/[a-z0-9]+|[぀-ヿ一-鿿]/g) || []);
        const left = words(a), right = words(b);
        if (!left.size || !right.size) return 0;
        let shared = 0;
        for (const word of left) if (right.has(word)) shared += 1;
        return shared / Math.max(left.size, right.size);
    }

    class ProactiveModel {
        constructor(rules = {}) {
            this.rules = { ...RULES, ...rules };
            this.enabled = false;
            this.enabledAt = 0;
            this.lastAskedAt = 0;
            this.lastDescription = '';
            this.lastTalkAt = 0;
        }

        setEnabled(enabled, now) {
            if (enabled && !this.enabled) this.enabledAt = now;
            this.enabled = Boolean(enabled);
        }

        // Any sign of conversation: the user spoke or typed, or Kei is talking.
        noteTalk(now) { this.lastTalkAt = now; }

        // observation: { enabled, description, lastSuccess }; busy: speaking or awaiting a reply.
        shouldAsk(observation, { now, busy }) {
            const rules = this.rules;
            if (!this.enabled || busy || !observation?.enabled) return false;
            const description = String(observation.description || '').trim();
            if (!description || now - observation.lastSuccess > rules.freshness) return false;
            if (now - this.enabledAt < rules.settle) return false;
            if (this.lastAskedAt && now - this.lastAskedAt < rules.minInterval) return false;
            if (now - this.lastTalkAt < rules.quietAfterTalk) return false;
            return similarity(description, this.lastDescription) < rules.similarity;
        }

        asked(description, now) {
            this.lastAskedAt = now;
            this.lastDescription = String(description || '');
        }
    }

    return { ProactiveModel, similarity, RULES };
});
