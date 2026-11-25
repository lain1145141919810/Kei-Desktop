import assert from "node:assert/strict";
import test from "node:test";
import { Quaternion, Vector3 } from "three";
import { MOTION_BONES, MotionTimeline } from "./motion.mjs";

test("samples only the approved mask and interpolates between 20 Hz frames", () => {
    assert.equal(new Set(MOTION_BONES).size, 53);
    const timeline = new MotionTimeline();
    const rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const clip = {
        version: 1, motion: "arm", rate: 20, mask: ["leftUpperArm"],
        frames: [[[0, 0, 0, 1]], [rotation], [rotation], [rotation], [rotation], [rotation]],
    };
    assert.equal(timeline.play(clip, 100), true);
    const halfway = timeline.sample(125);
    assert.deepEqual(halfway.mask, ["leftUpperArm"]);
    assert.equal(halfway.at, 0.5);
    assert.ok(Math.abs(halfway.rotations[0].z - Math.sin(Math.PI / 8)) < 1e-8);
    assert.equal(timeline.sample(350), null);
    assert.equal(timeline.play({ ...clip, mask: ["unknown"] }, 100), false);
    assert.equal(timeline.play({ ...clip, frames: [[[0, 0, 0, 4]], [rotation]] }, 100), false);
});

test("MotionTimeline reports completion and cancellation accurately for sequencing", () => {
    const timeline = new MotionTimeline();
    const rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const clip = {
        version: 1, motion: "arm", rate: 20, mask: ["leftUpperArm"],
        frames: [[[0, 0, 0, 1]], [rotation], [rotation]],
    };
    const outcomes = [];
    assert.equal(timeline.play(clip, 1000, reason => outcomes.push(reason)), true);
    assert.ok(timeline.sample(1050));
    assert.deepEqual(outcomes, []);
    assert.equal(timeline.sample(1200), null);
    assert.deepEqual(outcomes, ["completed"]);

    assert.equal(timeline.play(clip, 2000, reason => outcomes.push(reason)), true);
    timeline.clear("cancelled");
    assert.deepEqual(outcomes, ["completed", "cancelled"]);
});

test("MotionTimeline transitions smoothly from live pose and eases out on release without snapping", () => {
    const timeline = new MotionTimeline();
    const qA = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7).toArray();
    const qB = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.4).toArray();
    const clip = { version: 1, motion: "smooth-test", rate: 20, mask: ["leftUpperArm"], frames: [[qB], [qB], [qB], [qB], [qB], [qB], [qB], [qB]] };

    assert.equal(timeline.play(clip, 1000, null, { fromPose: { leftUpperArm: qA }, transitionMs: 160 }), true);
    const startSample = timeline.sample(1000);
    assert.ok(startSample.rotations[0].angleTo(new Quaternion().fromArray(qA)) < 0.01);
    const midSample = timeline.sample(1080);
    assert.ok(midSample.rotations[0].angleTo(new Quaternion().fromArray(qA)) > 0.2);
    assert.ok(midSample.rotations[0].angleTo(new Quaternion().fromArray(qB)) > 0.2);
    const settledSample = timeline.sample(1180);
    assert.ok(settledSample.rotations[0].angleTo(new Quaternion().fromArray(qB)) < 0.01);

    const reasons = [];
    assert.equal(timeline.play(clip, 2000, r => reasons.push(r)), true);
    timeline.sample(2100);
    timeline.release(2100, 200);
    assert.deepEqual(reasons, ["cancelled"]);
    const relMid = timeline.sample(2200);
    assert.equal(relMid.releasing, true);
    assert.ok(relMid.blend > 0.3 && relMid.blend < 0.7);
    assert.equal(timeline.sample(2310), null);
});
