class WebMRenderer {

    constructor({
        idleVideo,
        talkVideo,
        talkVariants,
    }) {
        this.idleVideo =
            idleVideo;

        this.talkVideo =
            talkVideo;

        this.talkVariants =
            talkVariants;

        this.speaking =
            false;

        this.lastTalkIndex =
            -1;

        this.sequenceToken =
            0;


        this.talkVideo.addEventListener(
            "ended",
            () => {
                this._handleTalkEnded();
            }
        );
    }


    async initialize() {
        await this.setIdle();
    }


    _chooseTalkVariant() {

        if (
            !this.talkVariants
            ||
            this.talkVariants.length === 0
        ) {
            return null;
        }


        if (
            this.talkVariants.length === 1
        ) {
            this.lastTalkIndex = 0;

            return (
                this.talkVariants[0]
            );
        }


        let index;

        do {
            index = Math.floor(
                Math.random()
                * this.talkVariants.length
            );
        }
        while (
            index ===
            this.lastTalkIndex
        );


        this.lastTalkIndex =
            index;


        return (
            this.talkVariants[index]
        );
    }


    async _playNextTalk(
        token
    ) {
        if (
            !this.speaking
            ||
            token !==
                this.sequenceToken
        ) {
            return;
        }


        const source =
            this._chooseTalkVariant();


        if (!source) {
            return;
        }


        console.log(
            "[WebMRenderer] talk:",
            source
        );


        this.talkVideo.pause();

        this.talkVideo.src =
            source;

        this.talkVideo.currentTime =
            0;


        try {
            await this.talkVideo.play();
        }
        catch (error) {
            console.warn(
                "[WebMRenderer] "
                + "talk play failed:",
                error
            );
        }
    }


    _handleTalkEnded() {

        if (this.speaking) {

            this._playNextTalk(
                this.sequenceToken
            );

        } else {

            this.setIdle();
        }
    }


    async setIdle() {

        this.speaking =
            false;

        ++this.sequenceToken;


        this.talkVideo.classList.remove(
            "active"
        );

        this.talkVideo.pause();


        this.idleVideo.classList.add(
            "active"
        );


        try {
            await this.idleVideo.play();
        }
        catch (error) {
            console.warn(
                "[WebMRenderer] "
                + "idle play failed:",
                error
            );
        }
    }


    async setSpeaking(
        speaking
    ) {

        if (!speaking) {
            await this.setIdle();
            return;
        }


        this.speaking =
            true;

        const token =
            ++this.sequenceToken;


        this.idleVideo.classList.remove(
            "active"
        );

        this.idleVideo.pause();


        this.talkVideo.classList.add(
            "active"
        );


        await this._playNextTalk(
            token
        );
    }


    async interrupt() {
        await this.setIdle();
    }


    setAffect(
        affect
    ) {
        /*
         * WebM 原型暂时不处理情绪。
         *
         * 以后 Live2DRenderer 会真正实现。
         */
    }


    setMouth(
        value
    ) {
        /*
         * WebM 无法连续控制嘴型。
         *
         * 保留统一接口，
         * 以后 Live2DRenderer 使用。
         */
    }


    playMotion(
        name
    ) {
        /*
         * 以后给 Live2D motion 使用。
         */
    }
}


window.WebMRenderer =
    WebMRenderer;