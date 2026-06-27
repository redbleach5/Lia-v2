'use client';

// Live2D-стилизованный аватар — анимированная 2D-модель с эмоциями.
//
// Использует PixiJS для рендеринга. Если есть настоящая Live2D-модель (.model3.json)
// в public/live2d/, загружает её. Иначе использует встроенную стилизованную
// 2D-модель с плавной анимацией (дыхание, моргание, эмоции, говорение).
//
// Зачем не SVG: SVG даёт рваную анимацию (CSS transforms на path). PixiJS
// использует WebGL — 60 fps, плавные переходы, shader-эффекты.

import { useEffect, useRef } from 'react';
import type { EmotionVector } from '@/lib/personality';

export type Live2DAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string; // optional: path to a Live2D model3.json
};

export function Live2DAvatar({ emotion, speaking = false, size = 280, src }: Live2DAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Pixi v6 Application — тип конструктора не подходит под ReturnType, используем any
  const appRef = useRef<any>(null);
  const modelRef = useRef<Live2DModelProxy | null>(null);

  // Init PixiJS app + draw stylized avatar
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!canvasRef.current) return;

      const PIXI = await import('pixi.js');

      // Destroy old app if exists
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }

      const app = new PIXI.Application({
        view: canvasRef.current,
        backgroundAlpha: 0,
        width: size,
        height: size,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      if (cancelled) {
        app.destroy(true);
        return;
      }
      appRef.current = app;

      // Try to load a real Live2D model if src is provided
      if (src) {
        try {
          const { Live2DModel } = await import('pixi-live2d-display/cubism2').catch(() => ({}) as Record<string, never>);
          const { Live2DModel: Live2DModel4 } = await import('pixi-live2d-display/cubism4').catch(() => ({}) as Record<string, never>);
          const Model = (Live2DModel ?? Live2DModel4) as typeof import('pixi-live2d-display').Live2DModel | undefined;
          if (Model) {
            // @ts-ignore — Live2DModel.from signature varies between versions
            const model = await Model.from(src);
            if (cancelled) {
              model.destroy();
              return;
            }
            app.stage.addChild(model);

            // Scale to fit
            const scale = Math.min(size / model.width, size / model.height) * 0.9;
            model.scale.set(scale);
            model.x = size / 2 - (model.width * scale) / 2;
            model.y = size / 2 - (model.height * scale) / 2;

            modelRef.current = { type: 'live2d', model };
            return;
          }
        } catch (e) {
          console.warn('[Live2DAvatar] failed to load model, using stylized fallback:', e);
        }
      }

      // Fallback: stylized 2D character drawn with PixiJS graphics
      const stylized = createStylizedCharacter(PIXI, size, emotion);
      app.stage.addChild(stylized.container);
      modelRef.current = { type: 'stylized', character: stylized };
    })();

    return () => {
      cancelled = true;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
      modelRef.current = null;
    };
  }, [src, size]);

  // Update emotion + speaking
  useEffect(() => {
    const m = modelRef.current;
    if (!m) return;

    if (m.type === 'stylized') {
      m.character.setEmotion(emotion);
      m.character.setSpeaking(speaking);
    } else if (m.type === 'live2d') {
      // For real Live2D models — set expression parameters
      try {
        // Map our 5-axis emotion to Live2D ParamAngleX/Y, ParamMouthOpenY etc.
        const mouthOpen = speaking ? 0.5 + Math.sin(Date.now() / 100) * 0.3 : 0;
        // @ts-ignore — internal API
        m.model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', mouthOpen);
      } catch { /* ignore */ }
    }
  }, [emotion, speaking]);

  // Ticker for breathing + blink animation on stylized model
  useEffect(() => {
    let raf = 0;
    let lastBlink = Date.now();
    let blinking = false;
    let blinkPhase = 0;

    const tick = () => {
      const m = modelRef.current;
      if (m?.type === 'stylized') {
        const t = Date.now() / 1000;

        // Breathing
        m.character.breath(t);

        // Blink
        if (!blinking && t * 1000 - lastBlink > 3000 + Math.random() * 2000) {
          blinking = true;
          blinkPhase = 0;
          lastBlink = t * 1000;
        }
        if (blinking) {
          blinkPhase += 0.08;
          if (blinkPhase >= 1) {
            blinking = false;
            m.character.setBlink(1);
          } else {
            // Triangle wave: 0 → 1 → 0
            const v = blinkPhase < 0.5 ? blinkPhase * 2 : (1 - blinkPhase) * 2;
            m.character.setBlink(1 - v);
          }
        }

        // Lip sync
        if (m.character.speaking) {
          m.character.setMouthOpen(0.4 + Math.sin(t * 14) * 0.3);
        } else {
          m.character.setMouthOpen(0);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={{ width: size, height: size }} className="relative">
      <canvas ref={canvasRef} style={{ width: size, height: size }} />
    </div>
  );
}

// ============================================================================
// Stylized character — drawn with PixiJS Graphics
// ============================================================================
// This is a procedural 2D avatar (not a real Live2D model) — used as fallback
// when no .model3.json is available. Still much smoother than SVG because of
// WebGL rendering + per-frame redraw.

type Live2DModelProxy =
  | { type: 'stylized'; character: StylizedCharacter }
  | { type: 'live2d'; model: unknown };

import type * as PIXIType from 'pixi.js';

class StylizedCharacter {
  container: PIXIType.Container;
  private head: PIXIType.Graphics;
  private hairBack: PIXIType.Graphics;
  private hairFront: PIXIType.Graphics;
  private leftEye: PIXIType.Graphics;
  private rightEye: PIXIType.Graphics;
  private leftPupil: PIXIType.Graphics;
  private rightPupil: PIXIType.Graphics;
  private leftBrow: PIXIType.Graphics;
  private rightBrow: PIXIType.Graphics;
  private mouth: PIXIType.Graphics;
  private blushL: PIXIType.Graphics;
  private blushR: PIXIType.Graphics;
  private aura: PIXIType.Graphics;

  speaking = false;
  private mouthOpen = 0;
  private blinkAmount = 1; // 1 = open, 0 = closed
  private emotion: EmotionVector;

  constructor(PIXI: typeof PIXIType, size: number, emotion: EmotionVector) {
    this.emotion = emotion;
    this.container = new PIXI.Container();
    const cx = size / 2;
    const cy = size / 2;

    // Aura — colored glow behind character, changes with emotion
    this.aura = new PIXI.Graphics();
    this.container.addChild(this.aura);
    this.updateAura(size);

    // Hair back
    this.hairBack = new PIXI.Graphics();
    this.hairBack.beginFill(0x8b5cf6);
    this.hairBack.drawEllipse(cx, cy - 5, 75, 95);
    this.hairBack.endFill();
    this.container.addChild(this.hairBack);

    // Head
    this.head = new PIXI.Graphics();
    this.head.beginFill(0xfde4d3);
    this.head.drawEllipse(cx, cy, 55, 70);
    this.head.endFill();
    this.container.addChild(this.head);

    // Hair front (bangs)
    this.hairFront = new PIXI.Graphics();
    this.hairFront.beginFill(0x7c3aed);
    this.hairFront.drawRoundedRect(cx - 60, cy - 65, 120, 35, 20);
    this.hairFront.endFill();
    this.container.addChild(this.hairFront);

    // Eyes (whites)
    this.leftEye = new PIXI.Graphics();
    this.rightEye = new PIXI.Graphics();
    this.container.addChild(this.leftEye, this.rightEye);

    // Pupils
    this.leftPupil = new PIXI.Graphics();
    this.rightPupil = new PIXI.Graphics();
    this.container.addChild(this.leftPupil, this.rightPupil);

    // Brows
    this.leftBrow = new PIXI.Graphics();
    this.rightBrow = new PIXI.Graphics();
    this.container.addChild(this.leftBrow, this.rightBrow);

    // Mouth
    this.mouth = new PIXI.Graphics();
    this.container.addChild(this.mouth);

    // Blush
    this.blushL = new PIXI.Graphics();
    this.blushR = new PIXI.Graphics();
    this.blushL.alpha = 0;
    this.blushR.alpha = 0;
    this.container.addChild(this.blushL, this.blushR);

    this.drawEyes(cx, cy);
    this.drawBrows(cx, cy);
    this.drawMouth(cx, cy);
    this.drawBlush(cx, cy);
  }

  private updateAura(size: number) {
    this.aura.clear();
    const color = this.getAuraColor();
    this.aura.beginFill(color, 0.15);
    this.aura.drawCircle(size / 2, size / 2, size * 0.48);
    this.aura.endFill();
    this.aura.beginFill(color, 0.08);
    this.aura.drawCircle(size / 2, size / 2, size * 0.45);
    this.aura.endFill();
  }

  private getAuraColor(): number {
    const e = this.emotion;
    // Pick dominant emotion
    const entries: Array<[keyof EmotionVector, number, number]> = [
      ['joy', e.joy, 0x10b981],
      ['curiosity', e.curiosity, 0x8b5cf6],
      ['calm', e.calm, 0x06b6d4],
      ['irritation', e.irritation, 0xef4444],
      ['sadness', e.sadness, 0x3b82f6],
    ];
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][2];
  }

  private drawEyes(cx: number, cy: number) {
    const eyeY = cy - 5;
    const eyeOffset = 22;
    const openness = this.blinkAmount;

    this.leftEye.clear();
    this.leftEye.beginFill(0xffffff);
    this.leftEye.drawEllipse(cx - eyeOffset, eyeY, 9, 11 * openness);
    this.leftEye.endFill();

    this.rightEye.clear();
    this.rightEye.beginFill(0xffffff);
    this.rightEye.drawEllipse(cx + eyeOffset, eyeY, 9, 11 * openness);
    this.rightEye.endFill();

    // Pupils — violet
    const pupilColor = 0x6d28d9;
    this.leftPupil.clear();
    this.leftPupil.beginFill(pupilColor);
    if (openness > 0.3) {
      this.leftPupil.drawCircle(cx - eyeOffset, eyeY, 4 * openness);
    }
    this.leftPupil.endFill();

    this.rightPupil.clear();
    this.rightPupil.beginFill(pupilColor);
    if (openness > 0.3) {
      this.rightPupil.drawCircle(cx + eyeOffset, eyeY, 4 * openness);
    }
    this.rightPupil.endFill();
  }

  private drawBrows(cx: number, cy: number) {
    const browY = cy - 25;
    const browOffset = 22;
    const e = this.emotion;

    // Irritation → brows down (lower + angled inward)
    // Curiosity → brows up
    const browShift = (e.irritation - Math.max(0, e.curiosity - 0.5)) * 6;

    this.leftBrow.clear();
    this.leftBrow.lineStyle(2.5, 0x5b3a8a, 1);
    this.leftBrow.moveTo(cx - browOffset - 8, browY + browShift);
    this.leftBrow.lineTo(cx - browOffset + 8, browY - browShift * 0.5);

    this.rightBrow.clear();
    this.rightBrow.lineStyle(2.5, 0x5b3a8a, 1);
    this.rightBrow.moveTo(cx + browOffset - 8, browY - browShift * 0.5);
    this.rightBrow.lineTo(cx + browOffset + 8, browY + browShift);
  }

  private drawMouth(cx: number, cy: number) {
    this.mouth.clear();
    const e = this.emotion;
    const mouthY = cy + 30;

    // Smile amount: joy - sadness - irritation*0.5
    const smile = (e.joy - e.sadness - e.irritation * 0.5) * 8;

    if (this.mouthOpen > 0.05) {
      // Open mouth — talking
      this.mouth.beginFill(0xc26647);
      this.mouth.drawEllipse(cx, mouthY, 10, 4 + this.mouthOpen * 6);
      this.mouth.endFill();
    } else {
      // Closed mouth — curve
      this.mouth.lineStyle(2, 0xc26647, 1);
      this.mouth.moveTo(cx - 12, mouthY);
      this.mouth.quadraticCurveTo(cx, mouthY + smile, cx + 12, mouthY);
    }
  }

  private drawBlush(cx: number, cy: number) {
    const e = this.emotion;
    const intensity = Math.max(0, e.joy - 0.3) * 0.6;

    this.blushL.clear();
    this.blushL.beginFill(0xf87171, intensity);
    this.blushL.drawCircle(cx - 32, cy + 18, 8);
    this.blushL.endFill();
    this.blushL.alpha = intensity;

    this.blushR.clear();
    this.blushR.beginFill(0xf87171, intensity);
    this.blushR.drawCircle(cx + 32, cy + 18, 8);
    this.blushR.endFill();
    this.blushR.alpha = intensity;
  }

  setEmotion(e: EmotionVector) {
    this.emotion = e;
    const cx = this.container.width / 2;
    const cy = this.container.height / 2;
    this.drawBrows(cx, cy);
    this.drawMouth(cx, cy);
    this.drawBlush(cx, cy);
    this.updateAura(this.container.width);
  }

  setSpeaking(s: boolean) {
    this.speaking = s;
  }

  setMouthOpen(v: number) {
    this.mouthOpen = v;
    const cx = this.container.width / 2;
    const cy = this.container.height / 2;
    this.drawMouth(cx, cy);
  }

  setBlink(v: number) {
    this.blinkAmount = v;
    const cx = this.container.width / 2;
    const cy = this.container.height / 2;
    this.drawEyes(cx, cy);
  }

  breath(t: number) {
    const breath = Math.sin(t * 0.8) * 1.5;
    this.container.y = breath;
    // Subtle head tilt
    this.container.rotation = Math.sin(t * 0.4) * 0.01;
  }
}

function createStylizedCharacter(PIXI: typeof PIXIType, size: number, emotion: EmotionVector): StylizedCharacter {
  return new StylizedCharacter(PIXI, size, emotion);
}
