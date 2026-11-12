class ExpressionController {
    constructor(adapter) {
        this.adapter = adapter;
        this.current = 'neutral';
        this.requested = 'neutral';
        this.speaking = false;
        this.activeTurnId = null;
        this.reservedTurnId = null;
        this.restoreTimer = null;
        this.generation = 0;
    }

    getSupported() {
        return this.adapter?.getExpressionCapabilities?.() || [];
    }

    cancelRestore() {
        clearTimeout(this.restoreTimer);
        this.restoreTimer = null;
        this.generation += 1;
    }

    apply(name, { fallback = false } = {}) {
        const supported = this.getSupported().includes(name);
        if (!supported && !fallback) return false;
        const visualName = supported ? name : 'neutral';
        if (!this.adapter?.setExpression?.(visualName)) return false;
        this.requested = name;
        this.current = visualName;
        return true;
    }

    setExpression(name) {
        this.cancelRestore();
        return this.apply(name);
    }

    reserveTurn(turnId) {
        if (!turnId || this.reservedTurnId === turnId) return;
        this.cancelRestore();
        this.reservedTurnId = turnId;
    }

    beginTurn(turnId, name) {
        if (!turnId || (this.reservedTurnId && this.reservedTurnId !== turnId)) return false;
        this.reservedTurnId = turnId;
        if (this.activeTurnId === turnId && this.requested === name) return true;
        this.cancelRestore();
        this.activeTurnId = turnId;
        return this.apply(name, { fallback: true });
    }

    finishTurn(turnId) {
        if (!turnId || this.activeTurnId !== turnId || this.reservedTurnId !== turnId) return false;
        this.activeTurnId = null;
        this.cancelRestore();
        const generation = this.generation;
        this.restoreTimer = setTimeout(() => {
            if (this.generation !== generation || this.reservedTurnId !== turnId || this.activeTurnId) return;
            this.restoreTimer = null;
            this.apply('neutral');
            this.reservedTurnId = null;
        }, 1200);
        return true;
    }

    setSpeaking(speaking) {
        this.speaking = Boolean(speaking);
    }

    interrupt() {
        this.cancelRestore();
        this.activeTurnId = null;
        this.reservedTurnId = null;
        this.apply('neutral');
    }
}

window.ExpressionController = ExpressionController;
