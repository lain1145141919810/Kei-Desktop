class ExpressionResolver {
    static resolve(affect) {
        if (!affect || typeof affect !== 'object') return 'neutral';
        const number = (key, fallback, min, max) => {
            const value = Number(affect[key]);
            return Number.isFinite(value)
                ? Math.max(min, Math.min(max, value))
                : fallback;
        };
        const valence = number('valence', 0, -1, 1);
        const arousal = number('arousal', 0.25, 0, 1);
        const intensity = number('intensity', 0.25, 0, 1);
        const warmth = number('warmth', 0.55, 0, 1);
        const certainty = number('certainty', 0.55, 0, 1);
        const restraint = number('restraint', 0.7, 0, 1);
        if (valence <= -0.6 && arousal >= 0.85 && intensity >= 0.85 && restraint <= 0.35) return 'shout';
        if (valence <= -0.35 && arousal >= 0.65 && intensity >= 0.6) return 'shadowed';
        if (valence <= -0.55 && arousal < 0.5 && intensity >= 0.45) return 'sad';
        if (valence <= -0.25 && intensity >= 0.5) return 'serious';
        if (arousal >= 0.68 && certainty <= 0.3 && intensity >= 0.55) {
            return warmth >= 0.65 ? 'bashful' : 'surprised';
        }
        if (valence >= 0.45 && arousal >= 0.55 && intensity >= 0.45 && restraint < 0.82) return 'happy';
        if (valence >= 0.25 && warmth >= 0.6) return 'small_smile';
        if (warmth >= 0.78 && intensity <= 0.35 && valence >= 0) return 'gentle';
        if (certainty <= 0.38 && arousal <= 0.55 && intensity >= 0.3 && valence > -0.25) return 'thoughtful';
        return 'neutral';
    }
}

window.ExpressionResolver = ExpressionResolver;
