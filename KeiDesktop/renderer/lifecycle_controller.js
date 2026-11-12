class DesktopLifecycleController {
    constructor({ overlay, video, button, bridge, onClose }) {
        this.overlay = overlay;
        this.video = video;
        this.loadingVoice = document.getElementById("loading-voice");
        this.button = button;
        this.bridge = bridge;
        this.onClose = onClose;
        this.phase = "opening";
        this.connected = false;
        this.loginAttempted = false;
        this.userActive = false;
        this.videoFinish = null;
        this.loadingVoiceFinish = null;
        this.loadingVoiceStartSeconds = 3;
        this.loadingVoice?.addEventListener("playing", () => {
            console.info(`[Kei Lifecycle] Fixed loading voice playing; video_time=${this.video.currentTime.toFixed(2)}s`);
        });
        button.addEventListener("click", () => {
            console.info("[Kei Lifecycle] Power button clicked");
            bridge?.requestClose();
        });
        bridge?.onPrepareClose(() => this.close());
    }

    playVideo(source, timeoutMs) {
        // Replacing startup with shutdown settles the old wait immediately.
        this.videoFinish?.();
        this.video.pause();
        if(window.keiLocal)return this.playCustom(source,timeoutMs);
        this.video.src = source;
        return new Promise((resolve) => {
            let timer;
            const finish = () => {
                clearTimeout(timer);
                this.video.removeEventListener("ended", finish);
                this.video.removeEventListener("error", finish);
                if (this.videoFinish === finish) this.videoFinish = null;
                resolve();
            };
            this.videoFinish = finish;
            this.video.addEventListener("ended", finish);
            this.video.addEventListener("error", finish);
            timer = setTimeout(finish, timeoutMs);
            this.video.play().catch(finish);
        });
    }

    async playCustom(source,limit){
        const media=await window.keiLocal.media();
        const chosen=source.includes('shutdown')?media.ending:media.opening;
        const item=chosen.video?this.video:document.createElement('img');
        if(item!==this.video){this.video.hidden=true;this.overlay.append(item);item.style.cssText='width:100%;height:100%;object-fit:contain';}
        item.src=chosen.src;
        await new Promise(resolve=>{
            const done=()=>{clearTimeout(timer);resolve();};
            const timer=setTimeout(done,chosen.video?limit:1500);
            this.videoFinish=done;item.onerror=done;
            if(chosen.video){item.onended=done;item.play().catch(done);}
        });
        if(item!==this.video){item.remove();this.video.hidden=false;}
    }

    async start() {
        // Use media time so stalls or pauses cannot make the announcement early.
        // Loading needs no Runtime connection, model inference or network request.
        const loadingVoice = new Promise((resolve) => {
            let timer;
            let voiceStarted = false;
            const audio = this.loadingVoice;
            const finish = () => {
                clearTimeout(timer);
                this.video.removeEventListener("playing", play);
                this.video.removeEventListener("timeupdate", play);
                audio?.removeEventListener("ended", finish);
                audio?.removeEventListener("error", finish);
                if (this.loadingVoiceFinish === finish) this.loadingVoiceFinish = null;
                resolve();
            };
            const play = () => {
                if (this.phase !== "opening" || !audio) return finish();
                if (voiceStarted || this.video.currentTime < this.loadingVoiceStartSeconds) return;
                voiceStarted = true;
                this.video.removeEventListener("playing", play);
                this.video.removeEventListener("timeupdate", play);
                console.info("[Kei Lifecycle] Fixed loading voice started");
                audio.play().catch(finish);
            };
            this.loadingVoiceFinish = finish;
            if (!audio) return finish();
            audio.addEventListener("ended", finish);
            audio.addEventListener("error", finish);
            this.video.addEventListener("playing", play);
            this.video.addEventListener("timeupdate", play);
            timer = setTimeout(finish, 8000);
        });
        await this.playVideo("../assets/lifecycle/startup.mp4", 8500);
        // Also settles when the startup video is unavailable, without trapping startup.
        if (this.loadingVoice?.paused) this.loadingVoiceFinish?.();
        await loadingVoice;
        this.loadingVoice?.pause();
        if (this.phase !== "opening") return;
        this.phase = "ready";
        console.info("[Kei Lifecycle] Startup animation completed");
        document.body.classList.remove("lifecycle-opening");
        this.overlay.classList.add("is-dismissed");
        this.overlay.setAttribute("aria-hidden", "true");
        this.tryLogin();
    }

    runtimeReady() {
        this.connected = true;
        this.tryLogin();
    }

    observeEvent(event) {
        if (["user.message", "asr.final", "agent.begin", "assistant.reply"].includes(event.type)) {
            this.userActive = true;
        }
    }

    async tryLogin() {
        if (this.phase !== "ready" || !this.connected || this.loginAttempted || this.userActive || !this.bridge) return;
        this.loginAttempted = true;
        try {
            this.loginTurnId = await this.bridge.playLogin();
            // Closing can begin while the Runtime request is in flight.
            if (this.phase === "closing" && this.loginTurnId) this.bridge.stopPlayback(this.loginTurnId);
        } catch (error) {
            console.warn("[Kei Desktop] Recorded login unavailable:", error.message);
        }
    }

    async close() {
        if (this.phase === "closing") return;
        this.phase = "closing";
        this.loadingVoice?.pause();
        this.loadingVoiceFinish?.();
        console.info("[Kei Lifecycle] Shutdown animation started");
        this.button.disabled = true;
        document.body.classList.remove("lifecycle-opening");
        document.body.classList.add("lifecycle-closing");
        this.overlay.classList.remove("is-dismissed");
        this.overlay.setAttribute("aria-hidden", "false");
        this.overlay.setAttribute("aria-label", "終了画面");
        this.onClose(this.loginTurnId);
        await this.playVideo("../assets/lifecycle/shutdown.mp4", 4500);
        console.info("[Kei Lifecycle] Shutdown animation completed");
        this.bridge?.finishClose();
    }
}

window.DesktopLifecycleController = DesktopLifecycleController;
