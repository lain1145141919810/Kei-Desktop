"use strict";

let stream;
const video = document.createElement("video");
video.muted = true;
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { alpha: false });

window.openSelectedSource = async id => {
    if (stream) throw new Error("A source is already open");
    stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id, maxFrameRate: 5 } },
    });
    if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 0) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("Expected one selected video track");
    }
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) throw new Error("Selected source has no dimensions");
    return true;
};

window.readSelectedFrame = () => {
    if (stream?.getVideoTracks()[0]?.readyState !== "live" || video.readyState < 2) return null;
    let scale = Math.min(1, 1280 / video.videoWidth, 800 / video.videoHeight);
    for (const quality of [0.70, 0.55, 0.40]) {
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
        if (base64 && base64.length <= 740000) return { mime: "image/jpeg", base64 };
        scale *= .7;
    }
    return null;
};
addEventListener("pagehide", () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
});
