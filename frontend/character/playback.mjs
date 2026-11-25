import { extractSpeechWindows } from "./speech-sync.mjs";

const LEAD_SECONDS = 0.08;
const ENVELOPE_SECONDS = 0.01;
const MAX_SEGMENTS = 64;
const MAX_FRAMES = 6000;

function envelope(buffer) {
    const step = Math.max(1, Math.round(buffer.sampleRate * ENVELOPE_SECONDS));
    const levels = new Float32Array(Math.ceil(buffer.length / step));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    for (let start = 0; start < buffer.length; start += step) {
        const end = Math.min(start + step, buffer.length);
        let squares = 0;
        for (const channel of channels) {
            for (let index = start; index < end; index++) squares += channel[index] ** 2;
        }
        levels[start / step] = Math.min(1, 3.4 * Math.sqrt(squares / ((end - start) * channels.length)));
    }
    return { levels, step };
}

function lastFrame(frames, positionMs) {
    let first = 0;
    let end = frames.length;
    while (first < end) {
        const midpoint = Math.floor((first + end) / 2);
        if (frames[midpoint].positionMs <= positionMs) first = midpoint + 1;
        else end = midpoint;
    }
    return frames[first - 1];
}

export class PlaybackClock {
    constructor(createContext = () => new AudioContext(), now = () => performance.now()) {
        this.createContext = createContext;
        this.now = now;
        this.context = null;
        this.active = null;
        this.disposed = false;
    }

    begin(turnId) {
        if (this.disposed || typeof turnId !== "string" || !turnId) throw new Error("A turn ID is required");
        this.interrupt();
        this.context ??= this.createContext();
        const session = {
            playbackId: crypto.randomUUID(),
            turnId,
            nextStart: 0,
            segments: [],
            byId: new Map(),
            queue: Promise.resolve(),
            pending: 0,
            submittedAt: this.now(),
            resume: this.context.resume(),
        };
        session.resume.catch(() => {});
        this.active = session;
        return { playbackId: session.playbackId, turnId };
    }

    matches({ playbackId, turnId } = {}) {
        return this.active?.playbackId === playbackId && this.active?.turnId === turnId && this.active !== null;
    }

    enqueue({ playbackId, turnId, segmentId, audio, subtitle = "", requireAudible = false }) {
        if (!this.matches({ playbackId, turnId })) return Promise.resolve(null);
        if (typeof segmentId !== "string" || !segmentId || !(audio instanceof ArrayBuffer) || !audio.byteLength) {
            return Promise.reject(new Error("Each segment needs an ID and nonempty audio"));
        }
        const session = this.active;
        if (session.byId.has(segmentId) || session.byId.size >= MAX_SEGMENTS) {
            return Promise.reject(new Error("Duplicate segment ID or too many segments"));
        }
        const segment = { segmentId, subtitle: String(subtitle), frames: [], seq: -1 };
        session.byId.set(segmentId, segment);
        session.pending++;
        const bytes = audio.slice(0);
        const job = session.queue.then(async () => {
            await session.resume;
            if (this.active !== session) return null;
            const buffer = await this.context.decodeAudioData(bytes);
            if (this.active !== session) return null;
            for (const frame of segment.frames) {
                if (frame.positionMs > buffer.duration * 1000) throw new Error("Mouth position is past the segment");
            }
            const env = envelope(buffer);
            if (requireAudible && !env.levels.some(level => level > 0.0005)) {
                throw Object.assign(new Error("Decoded speech contains no audible signal"), { code: "audio_silent" });
            }
            const start = Math.max(this.context.currentTime + LEAD_SECONDS, session.nextStart);
            const end = start + buffer.duration;
            const source = this.context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.context.destination);
            try {
                source.start(start);
            } catch (error) {
                source.disconnect();
                throw error;
            }
            const speech = extractSpeechWindows(env.levels, ENVELOPE_SECONDS);
            Object.assign(segment, { buffer, source, start, end, ...env, ...speech });
            session.segments.push(segment);
            session.nextStart = end;
            source.onended = () => {
                source.disconnect();
                segment.source = null;
            };
            return {
                playbackId, turnId, segmentId, start, end,
                duration: buffer.duration,
                activeStart: speech.activeStart,
                activeEnd: speech.activeEnd,
                speechWindows: speech.windows,
                submittedAt: session.submittedAt,
            };
        });
        session.queue = job.catch(() => {
            session.byId.delete(segmentId);
        }).finally(() => {
            session.pending--;
        });
        return job;
    }

    acceptFrame({ playbackId, turnId, segmentId, seq, positionMs, value } = {}) {
        if (!this.matches({ playbackId, turnId })) return false;
        const segment = this.active.byId.get(segmentId);
        if (!segment || !Number.isSafeInteger(seq) || seq <= segment.seq ||
            !Number.isFinite(positionMs) || positionMs < 0 || !Number.isFinite(value) ||
            segment.frames.length >= MAX_FRAMES) return false;
        const latest = segment.frames.at(-1);
        if (latest && positionMs < latest.positionMs) return false;
        const output = segment.start === undefined ? null : this.outputPosition();
        if (output && (positionMs < (output.time - segment.start) * 1000 ||
            positionMs > segment.buffer.duration * 1000)) return false;
        segment.seq = seq;
        segment.frames.push({ positionMs, value: Math.max(0, Math.min(1, value)) });
        return true;
    }

    outputPosition() {
        if (this.context?.state !== "running") return null;
        const timestamp = this.context.getOutputTimestamp?.();
        if (timestamp?.performanceTime > 0 && Number.isFinite(timestamp.contextTime)) {
            const time = timestamp.contextTime + Math.max(0, this.now() - timestamp.performanceTime) / 1000;
            return { time: Math.min(this.context.currentTime, time), source: "getOutputTimestamp" };
        }
        const delay = (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
        return { time: Math.max(0, this.context.currentTime - delay), source: "currentTime-minus-latency" };
    }

    sample() {
        const output = this.active && this.outputPosition();
        if (!output) return null;
        const segment = this.active.segments.find(item => item.start <= output.time && output.time < item.end);
        if (!segment) return null;
        const positionMs = (output.time - segment.start) * 1000;
        const index = Math.floor((output.time - segment.start) * segment.buffer.sampleRate / segment.step);
        const override = lastFrame(segment.frames, positionMs);
        return {
            playbackId: this.active.playbackId,
            turnId: this.active.turnId,
            segmentId: segment.segmentId,
            positionMs,
            value: override?.value ?? segment.levels[index] ?? 0,
            subtitle: segment.subtitle,
            clock: output.source,
        };
    }

    isBusy() {
        if (!this.active) return false;
        const output = this.outputPosition();
        return this.active.pending > 0 || this.active.segments.some(segment => segment.source) ||
            Boolean(output && output.time < this.active.nextStart);
    }

    interrupt(ids) {
        if (ids && !this.matches(ids)) return false;
        const session = this.active;
        this.active = null;
        if (!session) return false;
        for (const segment of session.segments) {
            if (segment.source) {
                segment.source.onended = null;
                segment.source.stop();
                segment.source.disconnect();
                segment.source = null;
            }
        }
        return true;
    }

    dispose() {
        if (this.disposed) return;
        this.interrupt();
        this.disposed = true;
        if (this.context && this.context.state !== "closed") this.context.close().catch(() => {});
    }
}

export function previewAudio(frequency = 290) {
    const rate = 24000;
    const length = Math.round(rate * 0.78);
    const buffer = new ArrayBuffer(44 + length * 2);
    const data = new DataView(buffer);
    function tag(offset, value) {
        for (let index = 0; index < value.length; index++) data.setUint8(offset + index, value.charCodeAt(index));
    }
    tag(0, "RIFF");
    data.setUint32(4, buffer.byteLength - 8, true);
    tag(8, "WAVEfmt ");
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, 1, true);
    data.setUint32(24, rate, true);
    data.setUint32(28, rate * 2, true);
    data.setUint16(32, 2, true);
    data.setUint16(34, 16, true);
    tag(36, "data");
    data.setUint32(40, length * 2, true);
    for (let index = 0; index < length; index++) {
        const time = index / rate;
        const pulse = time % 0.26;
        const gain = Math.max(0, Math.min(1, (pulse - 0.045) / 0.015, (0.19 - pulse) / 0.02));
        const carrier = Math.sin(2 * Math.PI * frequency * time) + 0.2 * Math.sin(4 * Math.PI * frequency * time);
        data.setInt16(44 + index * 2, Math.round(carrier * gain * 8300), true);
    }
    return buffer;
}
