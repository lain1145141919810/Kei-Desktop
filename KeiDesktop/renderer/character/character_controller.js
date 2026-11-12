class CharacterController {

    constructor(
        renderer
    ) {
        this.renderer =
            renderer;

        this.mouthFrame = null;
        this.mouthTarget = 0;
        this.visible = true;
        const adapter = window.KeiLive2D;
        this.look = new window.LookController(adapter);
        this.idleMotion = new window.IdleMotionController(adapter);
        this.expression = new window.ExpressionController(adapter);

        this.state = {
            speaking: false,
            affect: null,
            mouth: 0,
        };
    }


    async initialize() {

        this.look.start();

        if (
            this.renderer
            &&
            this.renderer.initialize
        ) {
            await (
                this.renderer.initialize()
            );
        }
    }


    async setSpeaking(
        speaking
    ) {
        this.state.speaking =
            speaking;

        this.look.setSpeaking(speaking);
        this.idleMotion.setSpeaking(speaking);
        this.expression.setSpeaking(speaking);


        if (
            this.renderer
            &&
            this.renderer.setSpeaking
        ) {
            await (
                this.renderer.setSpeaking(
                    speaking
                )
            );
        }
    }


    setAffect(
        affect
    ) {
        this.state.affect =
            affect;


        if (
            this.renderer
            &&
            this.renderer.setAffect
        ) {
            this.renderer.setAffect(
                affect
            );
        }
    }

    setExpression(name) {
        return this.expression.setExpression(name);
    }

    getExpressionCapabilities() {
        return this.expression.getSupported();
    }

    getLookCapabilities() {
        return this.look.capabilities;
    }

    reserveExpressionForTurn(turnId) {
        this.expression.reserveTurn(turnId);
    }

    beginExpressionForTurn(turnId, affect) {
        const name = window.ExpressionResolver.resolve(affect);
        const newTurn = this.expression.activeTurnId !== turnId;
        const applied = this.expression.beginTurn(turnId, name);
        if (applied && newTurn) {
            const gesture = {
                happy: 'brighten',
                bashful: 'brighten',
                surprised: 'startle',
                flustered: 'startle',
                serious: 'ponder',
                thoughtful: 'ponder',
                gentle: 'nod',
                small_smile: 'nod',
            }[name];
            if (gesture) window.KeiLive2D?.playGesture?.(gesture);
        }
        return applied;
    }

    finishExpressionForTurn(turnId) {
        return this.expression.finishTurn(turnId);
    }


    setMouth(
        value,
        { immediate = false } = {}
    ) {
        const normalized =
            Math.max(
                0,
                Math.min(
                    1,
                    Number(value) || 0
                )
            );

        if (!this.visible && normalized > 0) {
            return;
        }

        if (
            !immediate
            && normalized === this.mouthTarget
            && this.mouthFrame !== null
        ) {
            return;
        }


        if (this.mouthFrame !== null) {
            cancelAnimationFrame(this.mouthFrame);
            this.mouthFrame = null;
        }

        this.mouthTarget = normalized;

        if (immediate) {
            this.applyMouth(normalized);
            return;
        }

        if (Math.abs(normalized - this.state.mouth) < 0.001) {
            this.applyMouth(normalized);
            return;
        }

        const start = performance.now();
        const from = this.state.mouth;
        const duration = normalized > from ? 35 : 115;
        const animate = now => {
            const progress = Math.min(1, (now - start) / duration);
            const eased = normalized > from
                ? progress
                : 1 - (1 - progress) ** 2;
            this.applyMouth(from + (normalized - from) * eased);
            if (progress < 1) {
                this.mouthFrame = requestAnimationFrame(animate);
            } else {
                this.mouthFrame = null;
            }
        };
        this.mouthFrame = requestAnimationFrame(animate);
    }

    releaseMouth() {
        this.setMouth(0);
    }

    hardResetMouth() {
        this.setMouth(0, { immediate: true });
    }

    setVisible(visible) {
        this.visible = Boolean(visible);
        this.look.setVisible(this.visible);
        this.idleMotion.setVisible(this.visible);
        if (!this.visible) {
            this.hardResetMouth();
            this.expression.interrupt();
            window.KeiLive2D?.cancelGesture?.();
        }
        this.renderer?.setVisible?.(this.visible);
    }


    applyMouth(normalized) {
        this.state.mouth = normalized;


        if (
            this.renderer
            &&
            this.renderer.setMouth
        ) {
            this.renderer.setMouth(
                normalized
            );
        }

        if (
            window.KeiLive2D
            &&
            typeof window.KeiLive2D.setMouth === "function"
        ) {
            window.KeiLive2D.setMouth(
                normalized
            );
        }
    }


    playMotion(
        name
    ) {
        if (window.KeiLive2D?.playGesture?.(name)) return true;
        if (
            this.renderer
            &&
            this.renderer.playMotion
        ) {
            this.renderer.playMotion(
                name
            );
        }
        return false;
    }

    getMotionCapabilities() {
        return window.KeiLive2D?.getGestureCapabilities?.() ?? [];
    }


    async interrupt() {

        this.state.speaking =
            false;

        this.look.setSpeaking(false);
        this.idleMotion.setSpeaking(false);
        this.expression.interrupt();
        window.KeiLive2D?.cancelGesture?.();

        this.hardResetMouth();


        if (
            this.renderer
            &&
            this.renderer.interrupt
        ) {
            await (
                this.renderer.interrupt()
            );
        }
    }
}


window.CharacterController =
    CharacterController;
