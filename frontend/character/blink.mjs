const smooth = t => t * t * (3 - 2 * t);

// The eyelids close faster than they reopen. Hold the full seal briefly.
export function shortBlink(elapsed) {
    if (elapsed < 0 || elapsed >= 185) return 0;
    if (elapsed < 62) return smooth(elapsed / 62);
    if (elapsed < 80) return 1;
    return 1 - smooth((elapsed - 80) / 105);
}

const gaps = [3280, 4170, 2930, 3680];
const cycle = gaps.reduce((total, gap) => total + gap, 0);

export function automaticBlink(now) {
    let time = now % cycle;
    for (const gap of gaps) {
        if (time < gap) return shortBlink(time - gap + 185);
        time -= gap;
    }
    return 0;
}
