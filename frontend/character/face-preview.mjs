export const EXPRESSION_LABELS = Object.freeze({
    neutral: "通常", smallSmile: "微笑", gentle: "穏やか", happy: "笑顔", bashful: "照れ",
    surprised: "驚き", flustered: "動揺", shadowed: "沈んだ表情", shout: "叫び",
    sad: "泣き顔", serious: "真剣", thoughtful: "考え中", angry: "怒り", relaxed: "安らぎ",
    relieved: "安堵", worried: "心配", skeptical: "疑わしい", eyesClosed: "そっと目を閉じる",
});

export class FacePreview {
    constructor() {
        this.clear();
    }

    clear() {
        this.name = "neutral";
        this.before = {};
        this.started = null;
    }

    select(name, now) {
        if (this.name === name) return;
        this.before = this.sample(now)?.values ?? {};
        this.name = name;
        this.started = now;
    }

    sample(now) {
        if (this.started === null) return null;
        const position = Math.max(0, Math.min(1, (now - this.started) / 250));
        const mix = position * position * (3 - 2 * position);
        const values = Object.fromEntries(Object.entries(this.before).map(([name, weight]) => [name, weight * (1 - mix)]));
        if (this.name !== "neutral") values[this.name] = (values[this.name] ?? 0) + mix;
        if (position >= 1) {
            this.before = {};
            if (this.name === "neutral") {
                this.started = null;
                return null;
            }
        }
        return { name: this.name, values };
    }
}
