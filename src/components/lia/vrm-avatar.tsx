'use client';

// VRM 3D Avatar — загружает VRM модель, применяет blendshapes по эмоциям,
// добавляет дыхание, моргание, lip-sync при говорении.
//
// Источник модели: /public/models/sample.vrm (или /models/Lia.vrm если есть).
// Можно подменить через props.src.

import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMExpressionPresetName } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import type { EmotionVector } from '@/lib/personality';

// ============================================================================
// Props
// ============================================================================
export type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string;
};

// Default model path — relative to public/
const DEFAULT_VRM_SRC = '/models/sample.vrm';

// ============================================================================
// Main component
// ============================================================================
export function VrmAvatar({ emotion, speaking = false, size = 320, src = DEFAULT_VRM_SRC }: VrmAvatarProps) {
  return (
    <div style={{ width: size, height: size }} className="relative">
      <Canvas
        camera={{ position: [0, 1.35, 1.2], fov: 35 }}
        gl={{ alpha: true, antialias: true }}
        dpr={[1, 2]}
      >
        <Suspense fallback={null}>
          <Scene emotion={emotion} speaking={speaking} src={src} />
        </Suspense>
      </Canvas>
    </div>
  );
}

// ============================================================================
// Scene — lighting + VRM model
// ============================================================================
function Scene({ emotion, speaking, src }: { emotion: EmotionVector; speaking: boolean; src: string }) {
  return (
    <>
      {/* Lighting — soft, no harsh shadows */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 4, 3]} intensity={1.2} color="#ffffff" />
      <directionalLight position={[-2, 2, -1]} intensity={0.4} color="#a78bfa" />

      {/* Slight violet fill from below — matches UI accent */}
      <pointLight position={[0, -1, 2]} intensity={0.3} color="#8b5cf6" distance={5} />

      <VrmModel emotion={emotion} speaking={speaking} src={src} />

      <OrbitControls
        target={[0, 1.35, 0]}
        enablePan={false}
        enableZoom={false}
        minPolarAngle={Math.PI / 3}
        maxPolarAngle={Math.PI / 2}
        minAzimuthAngle={-Math.PI / 6}
        maxAzimuthAngle={Math.PI / 6}
      />
    </>
  );
}

// ============================================================================
// VRM Model — loads, animates, applies blendshapes
// ============================================================================
function VrmModel({ emotion, speaking, src }: { emotion: EmotionVector; speaking: boolean; src: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load VRM
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      src,
      (gltf) => {
        if (cancelled) return;
        const vrm = (gltf as any).userData.vrm as VRM | undefined;
        if (!vrm) {
          setError('VRM not found in gltf');
          return;
        }
        // Apply VRMUtils fixes
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(vrm);
        vrm.scene.rotation.y = Math.PI; // face the camera
        if (groupRef.current) {
          // Clear previous model
          while (groupRef.current.children.length > 0) {
            groupRef.current.remove(groupRef.current.children[0]);
          }
          groupRef.current.add(vrm.scene);
        }
        vrmRef.current = vrm;
        setLoaded(true);
      },
      undefined,
      (err) => {
        if (cancelled) return;
        console.error('[VrmAvatar] load failed:', err);
        setError(err instanceof Error ? err.message : String(err));
      },
    );

    return () => { cancelled = true; };
  }, [src]);

  // Animation state — smoothed values
  const animState = useRef({
    breathPhase: 0,
    blinkTimer: 2 + Math.random() * 3,
    blinkPhase: 0,
    isBlinking: false,
    mouthPhase: 0,
    // Smoothed blendshape values (lerp toward target)
    current: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
  });

  // Per-frame update
  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;
    const t = performance.now() / 1000;

    // ── Breath ── subtle vertical movement + chest expansion
    const breath = Math.sin(t * 0.6) * 0.5 + 0.5; // 0..1, ~10s cycle
    if (vrm.humanoid) {
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      if (spine) {
        spine.rotation.x = breath * 0.02 - 0.01;
      }
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        // Subtle head sway
        head.rotation.y = Math.sin(t * 0.4) * 0.04;
        head.rotation.x = Math.sin(t * 0.3) * 0.02 + breath * 0.01 - 0.01;
      }
    }

    // ── Blink ──
    animState.current.blinkTimer -= delta;
    if (!animState.current.isBlinking && animState.current.blinkTimer < 0) {
      animState.current.isBlinking = true;
      animState.current.blinkPhase = 0;
    }
    if (animState.current.isBlinking) {
      animState.current.blinkPhase += delta * 10; // 100ms total blink
      if (animState.current.blinkPhase >= 1) {
        animState.current.isBlinking = false;
        animState.current.blinkTimer = 2 + Math.random() * 3;
        setExpression(vrm, 'blink', 0);
      } else {
        // Triangle wave: 0 → 1 → 0
        const blinkValue = animState.current.blinkPhase < 0.5
          ? animState.current.blinkPhase * 2
          : (1 - animState.current.blinkPhase) * 2;
        setExpression(vrm, 'blink', blinkValue);
      }
    }

    // ── Emotion blendshapes ── smooth lerp toward target
    const target = emotionToBlendshapes(emotion);
    const lerpSpeed = 1 - Math.pow(0.001, delta); // ~smoothing per frame
    for (const key of Object.keys(target) as Array<keyof typeof target>) {
      const cur = animState.current.current[key] as number;
      const tgt = target[key];
      animState.current.current[key] = cur + (tgt - cur) * lerpSpeed;
      setExpression(vrm, key as VRMExpressionPresetName, animState.current.current[key]);
    }

    // ── Lip-sync during speaking ── oscillate mouth open
    if (speaking) {
      animState.current.mouthPhase += delta * 12;
      const mouthValue = (Math.sin(animState.current.mouthPhase) + 1) / 2 * 0.7;
      setExpression(vrm, 'aa', Math.max(animState.current.current.aa ?? 0, mouthValue));
    } else {
      // Decay mouth
      const cur = animState.current.current.aa ?? 0;
      animState.current.current.aa = Math.max(0, cur - delta * 2);
      setExpression(vrm, 'aa', animState.current.current.aa);
    }

    // Update VRM
    vrm.update(delta);
  });

  if (error) {
    return <></>;
  }

  return <group ref={groupRef} />;
}

// ============================================================================
// Helper: set expression (handles both preset names and custom)
// ============================================================================
function setExpression(vrm: VRM, name: VRMExpressionPresetName | string, value: number) {
  if (!vrm.expressionManager) return;
  try {
    vrm.expressionManager.setValue(name as VRMExpressionPresetName, Math.max(0, Math.min(1, value)));
  } catch {
    // expression not available on this model — skip
  }
}

// ============================================================================
// Emotion → VRM blendshapes mapping
// ============================================================================
function emotionToBlendshapes(e: EmotionVector): Record<string, number> {
  // VRM standard expressions:
  //   happy, angry, sad, relaxed, surprised, blink, blinkLeft, blinkRight,
  //   lookUp, lookDown, lookLeft, lookRight, neutral
  //   Plus visemes: aa, ih, ou, ee, oh

  return {
    happy:     Math.max(0, e.joy - 0.3) * 1.2,
    angry:     Math.max(0, e.irritation - 0.2) * 1.5,
    sad:       Math.max(0, e.sadness - 0.2) * 1.3,
    relaxed:   Math.max(0, e.calm - 0.3) * 0.8,
    surprised: Math.max(0, e.curiosity - 0.5) * 1.5,
    // Visemes default to 0 — set during lip-sync
    aa: 0,
    ih: 0,
    ou: 0,
    ee: 0,
    oh: 0,
  };
}
