class LookController {
    constructor(adapter) {
        this.adapter = adapter;
        this.capabilities = adapter?.getLookCapabilities?.() || { eyes: false, head: false };
        this.speaking = false;
        this.visible = true;
        this.target = { x: 0, y: 0 };
        this.current = { x: 0, y: 0 };
        this.frame = null;
        this.timer = null;
        this.cursorTarget = null;
        this.onMouseMove = this.onMouseMove.bind(this);
    }

    start() {
        if (!this.capabilities.eyes && !this.capabilities.head) return;
        window.addEventListener('mousemove', this.onMouseMove, { passive: true });
        this.chooseIdleTarget();
        this.frame = requestAnimationFrame(now => this.update(now));
    }

    setSpeaking(speaking) {
        this.speaking = Boolean(speaking);
        if (this.speaking) this.target = { x: 0, y: 0 };
        else this.chooseIdleTarget();
    }

    setVisible(visible) {
        this.visible = Boolean(visible);
        if (!this.visible) {
            this.target = { x: 0, y: 0 };
            this.current = { x: 0, y: 0 };
            this.adapter?.setLook?.(0, 0);
        }
    }

    onMouseMove(event) {
        const canvas = document.getElementById('live2d-canvas');
        if (!canvas || !this.visible || this.speaking) return;
        const box = canvas.getBoundingClientRect();
        const dx = event.clientX - (box.left + box.width / 2);
        const dy = event.clientY - (box.top + box.height / 2);
        if (Math.abs(dx) > box.width * 0.65 || Math.abs(dy) > box.height * 0.65) {
            this.cursorTarget = null;
            return;
        }
        this.cursorTarget = {
            x: Math.max(-0.25, Math.min(0.25, dx / box.width * 0.4)),
            y: Math.max(-0.18, Math.min(0.18, -dy / box.height * 0.3))
        };
    }

    chooseIdleTarget() {
        if (!this.capabilities.eyes && !this.capabilities.head) return;
        clearTimeout(this.timer);
        if (!this.speaking && this.visible) {
            this.target = {
                x: (Math.random() * 2 - 1) * 0.22,
                y: (Math.random() * 2 - 1) * 0.15
            };
        }
        this.timer = setTimeout(() => this.chooseIdleTarget(), 3000 + Math.random() * 3000);
    }

    update() {
        if (this.visible) {
            const target = this.speaking ? { x: 0, y: 0 } : (this.cursorTarget || this.target);
            this.current.x += (target.x - this.current.x) * 0.045;
            this.current.y += (target.y - this.current.y) * 0.045;
            this.adapter?.setLook?.(this.current.x, this.current.y);
        }
        this.frame = requestAnimationFrame(() => this.update());
    }

    stop() {
        clearTimeout(this.timer);
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        window.removeEventListener('mousemove', this.onMouseMove);
        this.adapter?.setLook?.(0, 0);
    }
}

window.LookController = LookController;
