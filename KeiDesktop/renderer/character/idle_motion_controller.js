class IdleMotionController {
    constructor(adapter) {
        this.adapter = adapter;
    }

    setSpeaking(speaking) {
        this.adapter?.setSpeaking?.(Boolean(speaking));
    }

    setVisible(visible) {
        this.adapter?.setPresentationVisible?.(Boolean(visible));
    }
}

window.IdleMotionController = IdleMotionController;
