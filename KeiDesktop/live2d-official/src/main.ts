/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppDelegate } from './lappdelegate';

console.log('[Kei Live2D] bundle loaded');

/**
 * 获取当前主 Canvas 上真正正在运行的 Kei 模型。
 * 不创建新的 Manager，只访问官方 Cubism 当前正在使用的实例。
 */
function getKeiModel() {
  const manager = LAppDelegate.getInstance().getLive2DManager(0);

  if (!manager) {
    return null;
  }

  return manager.getModel(0);
}

// Model-specific profile stays at the Live2D boundary. Cubism Core probes show
// that this moc has no drawable response to eye-ball or angle parameters.
const expressionProfile: Record<string, string | null> = {
  neutral: 'Neutral',
  small_smile: 'SmallSmile',
  gentle: 'Gentle',
  happy: 'HappyClosed',
  bashful: 'Bashful',
  surprised: 'OpenMouth',
  flustered: 'Flustered',
  shadowed: 'Shadowed',
  shout: 'Shout',
  sad: 'Crying',
  serious: 'Serious',
  thoughtful: 'Thoughtful'
};
let requestedExpression = 'neutral';

// The current Cubism art is a flat standing illustration. Keep the small
// expression posture at the presentation boundary until head and eye meshes
// exist in the source model. Values are canvas pixels and degrees.
const expressionPosture: Record<string, { x: number; y: number; angle: number }> = {
  neutral: { x: 0, y: 0, angle: 0 },
  small_smile: { x: 0, y: -0.35, angle: 0.08 },
  gentle: { x: 0, y: -0.2, angle: 0.07 },
  happy: { x: 0, y: -0.75, angle: 0.16 },
  bashful: { x: -0.35, y: 0.3, angle: -0.14 },
  surprised: { x: 0, y: -0.8, angle: -0.08 },
  flustered: { x: -0.4, y: 0.2, angle: -0.12 },
  shadowed: { x: 0, y: 0.65, angle: -0.12 },
  shout: { x: 0, y: -0.45, angle: -0.08 },
  sad: { x: 0, y: 0.85, angle: -0.13 },
  serious: { x: 0, y: 0.3, angle: -0.06 },
  thoughtful: { x: -0.3, y: 0.35, angle: -0.13 }
};
let postureTarget = expressionPosture.neutral;

function effectiveExpression(name: string): string | null {
  // Keep a visible smile during speech while the PCM-driven mouth stays active.
  if (swaySpeaking && name === 'happy') return 'SmallSmile';
  if (swaySpeaking && name === 'shout') return 'Serious';
  return expressionProfile[name] ?? null;
}

declare global {
  interface Window {
    KeiLive2D?: {
      setMouth(value: number): void;
      resetMouth(): void;
      isReady(): boolean;
      getMouthCapabilities(): { openY: boolean; form: boolean };
      getLookCapabilities(): { eyes: boolean; head: boolean };
      setLook(x: number, y: number): boolean;
      setExpression(name: string): boolean;
      getExpressionCapabilities(): string[];
      setSpeaking(speaking: boolean): void;
      setPresentationVisible(visible: boolean): void;
      playGesture(name: string): boolean;
      getGestureCapabilities(): string[];
      cancelGesture(): void;
    };
  }
}

console.log('[Kei Live2D] installing bridge');

window.KeiLive2D = {
  setMouth(value: number): void {
    const model = getKeiModel();

    if (!model) {
      return;
    }

    model.setExternalMouth(value);
  },

  resetMouth(): void {
    const model = getKeiModel();

    if (!model) {
      return;
    }

    model.setExternalMouth(0.0);
  },

  getMouthCapabilities(): { openY: boolean; form: boolean } {
    return getKeiModel()?.getMouthCapabilities() ?? { openY: false, form: false };
  },

  getLookCapabilities(): { eyes: boolean; head: boolean } {
    return { eyes: false, head: false };
  },

  setLook(_x: number, _y: number): boolean {
    return false;
  },

  setExpression(name: string): boolean {
    const model = getKeiModel();
    const actualName = effectiveExpression(name);
    if (!model || !model.getModel() || !actualName) return false;
    requestedExpression = name;
    postureTarget = expressionPosture[name] ?? expressionPosture.neutral;
    model.setExpression(actualName);
    return true;
  },

  getExpressionCapabilities(): string[] {
    return Object.keys(expressionProfile).filter(name => expressionProfile[name] !== null);
  },

  setSpeaking(speaking: boolean): void {
    swaySpeaking = Boolean(speaking);
    if (swaySpeaking) microStart = 0;
    const model = getKeiModel();
    const actualName = effectiveExpression(requestedExpression);
    if (model?.getModel() && actualName) model.setExpression(actualName);
  },

  setPresentationVisible(visible: boolean): void {
    swayVisible = Boolean(visible);
    if (!swayVisible) {
      microStart = 0;
      gestureName = null;
      getKeiModel()?.cancelWink();
    }
  },

  playGesture(name: string): boolean {
    const model = getKeiModel();
    if (!swayVisible || !model?.getModel()) return false;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
    if (name === 'wink' || name === 'wink_left' || name === 'wink_right') {
      return model.playWink(name === 'wink_left' ? 'left' : 'right');
    }
    if (!['nod', 'ponder', 'brighten', 'startle'].includes(name)) return false;
    gestureName = name;
    gestureStart = performance.now();
    gestureDuration = name === 'ponder' ? 1350 : name === 'startle' ? 560 : 850;
    microStart = 0;
    return true;
  },

  getGestureCapabilities(): string[] {
    const model = getKeiModel();
    if (!model?.getModel()) return [];
    return ['nod', 'ponder', 'brighten', 'startle',
      ...(model.canWink() ? ['wink', 'wink_left', 'wink_right'] : [])];
  },

  cancelGesture(): void {
    gestureName = null;
    getKeiModel()?.cancelWink();
  },

  isReady(): boolean {
    const model = getKeiModel();

    return model !== null && model.getModel() !== null;
  }
};

console.log('[Kei Live2D] bridge installed', window.KeiLive2D);

// The current moc has no geometry bound to its hair or angle parameters.
// Give the flat character a small spring-driven sway at the presentation layer.
let swayFrame = 0;
let swayCanvas: HTMLCanvasElement | null = null;
let swaySpeaking = false;
let swayVisible = true;
let microStart = 0;
let microDuration = 0;
let microAngle = 0;
let microOffsetX = 0;
let nextMicro = 0;
let gestureName: string | null = null;
let gestureStart = 0;
let gestureDuration = 0;
let postureX = 0;
let postureY = 0;
let postureAngle = 0;

function scheduleMicro(now: number): void {
  nextMicro = now + 5000 + Math.random() * 7000;
}

function startSubtleSway(): void {
  const canvas = document.getElementById('live2d-canvas') as HTMLCanvasElement | null;
  if (!canvas || swayFrame) return;

  swayCanvas = canvas;
  canvas.style.transformOrigin = '50% 92%';
  canvas.style.willChange = 'transform';

  let lastFrame = performance.now();
  let angle = 0;
  let angularVelocity = 0;
  scheduleMicro(lastFrame);

  const update = (now: number): void => {
    const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.05);
    lastFrame = now;
    const time = now / 1000;
    if (!swaySpeaking && swayVisible && now >= nextMicro) {
      microStart = now;
      microDuration = 800 + Math.random() * 1200;
      microAngle = (Math.random() * 2 - 1) * 0.16;
      microOffsetX = (Math.random() * 2 - 1) * 0.8;
      scheduleMicro(now);
    }
    let microEnvelope = 0;
    if (microStart && !swaySpeaking && swayVisible) {
      const progress = (now - microStart) / microDuration;
      if (progress >= 1) microStart = 0;
      else microEnvelope = Math.sin(Math.PI * progress) ** 2;
    }
    const talkScale = swaySpeaking ? 0.7 : 1;
    const targetAngle =
      talkScale * (0.32 * Math.sin(time * 1.03) + 0.09 * Math.sin(time * 1.71 + 1.4))
      + microAngle * microEnvelope;

    angularVelocity += (targetAngle - angle) * 16 * dt;
    angularVelocity *= Math.exp(-6 * dt);
    angle += angularVelocity * dt;

    const postureBlend = 1 - Math.exp(-5 * dt);
    const targetPosture = swayVisible && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
      ? postureTarget : expressionPosture.neutral;
    postureX += (targetPosture.x - postureX) * postureBlend;
    postureY += (targetPosture.y - postureY) * postureBlend;
    postureAngle += (targetPosture.angle - postureAngle) * postureBlend;

    const offsetX = talkScale * 1.2 * Math.sin(time * 0.83 + 0.7)
      + microOffsetX * microEnvelope;
    const offsetY = -0.6 * (1 - Math.cos(time * 1.62));
    let gestureX = 0;
    let gestureY = 0;
    let gestureAngle = 0;
    if (gestureName) {
      const progress = Math.min(1, (now - gestureStart) / gestureDuration);
      const envelope = Math.sin(Math.PI * progress) ** 2;
      if (gestureName === 'nod') gestureY = 2.8 * Math.sin(Math.PI * progress) ** 2;
      else if (gestureName === 'ponder') gestureAngle = -0.85 * envelope;
      else if (gestureName === 'brighten') gestureY = -2.8 * envelope;
      else if (gestureName === 'startle') {
        gestureX = -2.2 * envelope;
        gestureAngle = -0.5 * envelope;
      }
      if (progress >= 1) gestureName = null;
    }
    canvas.style.transform =
      `translate(${(offsetX + gestureX + postureX).toFixed(2)}px, ${(offsetY + gestureY + postureY).toFixed(2)}px) ` +
      `rotate(${(angle + gestureAngle + postureAngle).toFixed(3)}deg)`;
    swayFrame = requestAnimationFrame(update);
  };

  swayFrame = requestAnimationFrame(update);
}

function stopSubtleSway(): void {
  if (swayFrame) cancelAnimationFrame(swayFrame);
  swayFrame = 0;
  microStart = 0;
  gestureName = null;
  if (swayCanvas) {
    swayCanvas.style.transform = '';
    swayCanvas.style.willChange = '';
    swayCanvas = null;
  }
}

function startKeiLive2D(): void {
  console.log('[Kei Live2D] starting');

  const delegate = LAppDelegate.getInstance();

  if (!delegate.initialize()) {
    console.error('[Kei Live2D] initialize failed');
    return;
  }

  delegate.run();
  startSubtleSway();

  console.log('[Kei Live2D] render loop started');
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startKeiLive2D, {
    once: true
  });
} else {
  startKeiLive2D();
}

window.addEventListener(
  'beforeunload',
  (): void => {
    stopSubtleSway();
    LAppDelegate.releaseInstance();
  },
  { passive: true }
);
