'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMExpressionPresetName } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import type { EmotionVector, EmotionAxis } from '@/lib/personality';
import { dominantEmotion } from '@/lib/emotion';

export type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string;
};

const DEFAULT_VRM_SRC = '/models/sample.vrm';

// ============================================================================
// Эмоция → цвет платформы
// Палитра тёплая, в стиле "лён" (см. globals.css):
//   joy        → тёплый янтарный   #c9a886 (taupe) + подсветка #d4b89a
//   curiosity  → лиловый            #8b6f9a
//   calm       → мягкий шалфей      #6b8e5a
//   irritation → приглушённый красный #c2664a
//   sadness    → пыльно-синий       #7a8ba5
// ============================================================================
const EMOTION_COLORS: Record<EmotionAxis, { base: string; glow: string }> = {
  joy:        { base: '#d4b89a', glow: '#e8c8a0' },
  curiosity:  { base: '#8b6f9a', glow: '#a58ab8' },
  calm:       { base: '#7a9a6b', glow: '#9ab88a' },
  irritation: { base: '#c2664a', glow: '#d97757' },
  sadness:    { base: '#7a8ba5', glow: '#9aabc0' },
};

export function VrmAvatar({ emotion, speaking = false, size = 280, src = DEFAULT_VRM_SRC }: VrmAvatarProps) {
  return (
    <div style={{ width: size, height: size }} className="relative">
      <Canvas
        camera={{ position: [0, 1.35, 1.1], fov: 38 }}
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

function Scene({ emotion, speaking, src }: { emotion: EmotionVector; speaking: boolean; src: string }) {
  const dom = dominantEmotion(emotion);
  const colors = EMOTION_COLORS[dom];
  const intensity = Math.max(0.25, emotion[dom]);

  return (
    <>
      {/* Освещение — мягкое, тёплое */}
      <ambientLight intensity={0.85} color="#ffffff" />
      <directionalLight position={[1, 3, 2]} intensity={1.0} color="#fff5e8" />
      <directionalLight position={[-1, 2, 1]} intensity={0.35} color="#e8d5c0" />
      <hemisphereLight args={['#fff5e8', '#c9a886', 0.25]} />

      <VrmModel emotion={emotion} speaking={speaking} src={src} />

      {/* Платформа — двойная: основание + светящееся кольцо */}
      <Platform colors={colors} intensity={intensity} />

      <OrbitControls
        target={[0, 1.25, 0]}
        enablePan={false}
        enableZoom={true}
        minDistance={0.7}
        maxDistance={1.6}
        minPolarAngle={Math.PI / 4}
        maxPolarAngle={Math.PI / 2.05}
        minAzimuthAngle={-Math.PI / 6}
        maxAzimuthAngle={Math.PI / 6}
        enableDamping
        dampingFactor={0.08}
      />
    </>
  );
}

// ============================================================================
// Платформа под аватаром — меняет цвет в зависимости от эмоции
// ============================================================================
function Platform({ colors, intensity }: { colors: { base: string; glow: string }; intensity: number }) {
  // Цвет платформы плавно интерполируется при смене эмоции
  const baseMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const ringMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const targetBase = useMemo(() => new THREE.Color(colors.base), [colors.base]);
  const targetGlow = useMemo(() => new THREE.Color(colors.glow), [colors.glow]);

  useFrame(() => {
    if (baseMatRef.current) {
      baseMatRef.current.color.lerp(targetBase, 0.08);
      baseMatRef.current.opacity = THREE.MathUtils.lerp(baseMatRef.current.opacity, 0.85, 0.08);
    }
    if (ringMatRef.current) {
      ringMatRef.current.color.lerp(targetGlow, 0.08);
      ringMatRef.current.opacity = THREE.MathUtils.lerp(ringMatRef.current.opacity, 0.9, 0.08);
    }
    if (glowMatRef.current) {
      glowMatRef.current.color.lerp(targetGlow, 0.08);
      // Лёгкая пульсация в зависимости от интенсивности эмоции
      const t = performance.now() / 1000;
      const pulse = 0.5 + Math.sin(t * 1.5) * 0.15;
      glowMatRef.current.opacity = THREE.MathUtils.lerp(
        glowMatRef.current.opacity,
        0.15 + intensity * 0.35 * pulse,
        0.08,
      );
    }
  });

  return (
    <group>
      {/* Основной диск платформы */}
      <mesh position={[0, 0.015, 0]} receiveShadow>
        <cylinderGeometry args={[0.42, 0.46, 0.04, 64]} />
        <meshStandardMaterial
          ref={baseMatRef}
          color={colors.base}
          transparent
          opacity={0.85}
          roughness={0.55}
          metalness={0.05}
        />
      </mesh>

      {/* Светящееся кольцо по краю платформы — индикатор эмоции */}
      <mesh position={[0, 0.04, 0]}>
        <torusGeometry args={[0.42, 0.012, 16, 96]} />
        <meshStandardMaterial
          ref={ringMatRef}
          color={colors.glow}
          emissive={colors.glow}
          emissiveIntensity={0.6}
          transparent
          opacity={0.9}
          roughness={0.3}
        />
      </mesh>

      {/* Внутреннее светящееся кольцо */}
      <mesh position={[0, 0.04, 0]}>
        <torusGeometry args={[0.32, 0.006, 12, 64]} />
        <meshStandardMaterial
          color={colors.glow}
          emissive={colors.glow}
          emissiveIntensity={0.4}
          transparent
          opacity={0.6}
          roughness={0.3}
        />
      </mesh>

      {/* Мягкое свечение под платформой (halo на полу) */}
      <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.55, 64]} />
        <meshBasicMaterial
          ref={glowMatRef}
          color={colors.glow}
          transparent
          opacity={0.2}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function VrmModel({ emotion, speaking, src }: { emotion: EmotionVector; speaking: boolean; src: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadFailed(false);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      src,
      (gltf) => {
        if (cancelled) return;
        // VRMLoaderPlugin сохраняет VRM-объект в gltf.userData.vrm во время afterRoot().
        // Тип GLTF из three.js объявляет userData как Record<string, any>, поэтому прямой
        // доступ безопасен и не требует cast.
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          console.error('[VRM] No VRM in gltf');
          setLoadFailed(true);
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        // ВАЖНО: НЕ поворачивать сцену на Math.PI — это разворачивало аватар спиной к камере.
        // VRM-модели по спецификации смотрят в -Z, камера у нас на +Z, значит аватар уже лицом к нам.
        vrm.scene.rotation.y = 0;

        // Опускаем руки из T-pose в естественное положение.
        // В VRM normalized bones:
        //   leftUpperArm.rotation.z  < 0 → опускает левую руку вниз
        //   rightUpperArm.rotation.z > 0 → опускает правую руку вниз
        // Значения ~1.3-1.5 радиан дают естественный наклон вдоль тела.
        if (vrm.humanoid) {
          const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
          const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
          if (leftUpperArm) leftUpperArm.rotation.z = -1.35;
          if (rightUpperArm) rightUpperArm.rotation.z = 1.35;

          const leftLowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
          const rightLowerArm = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
          if (leftLowerArm) leftLowerArm.rotation.x = -0.25;
          if (rightLowerArm) rightLowerArm.rotation.x = -0.25;

          // Лёгкий наклон кистей
          const leftHand = vrm.humanoid.getNormalizedBoneNode('leftHand');
          const rightHand = vrm.humanoid.getNormalizedBoneNode('rightHand');
          if (leftHand) leftHand.rotation.z = 0.15;
          if (rightHand) rightHand.rotation.z = -0.15;
        }

        // Слегка опускаем всю модель, чтобы ноги уходили в платформу
        vrm.scene.position.y = 0;

        if (groupRef.current) {
          while (groupRef.current.children.length > 0) {
            groupRef.current.remove(groupRef.current.children[0]);
          }
          groupRef.current.add(vrm.scene);
        }
        vrmRef.current = vrm;
        setLoaded(true);
        console.log('[VRM] loaded successfully');
      },
      undefined,
      (err) => {
        if (cancelled) return;
        console.error('[VRM] load failed:', err);
        setLoadFailed(true);
      },
    );

    return () => { cancelled = true; };
  }, [src]);

  const animState = useRef({
    blinkTimer: 2 + Math.random() * 3,
    isBlinking: false,
    blinkPhase: 0,
    mouthPhase: 0,
    current: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, aa: 0 },
  });

  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !loaded) return;
    const t = performance.now() / 1000;

    // Дыхание
    if (vrm.humanoid) {
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      if (spine) spine.rotation.x = Math.sin(t * 0.8) * 0.02;

      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        head.rotation.y = Math.sin(t * 0.3) * 0.06;
        head.rotation.x = Math.sin(t * 0.2) * 0.025;
      }
    }

    // Моргание
    animState.current.blinkTimer -= delta;
    if (!animState.current.isBlinking && animState.current.blinkTimer < 0) {
      animState.current.isBlinking = true;
      animState.current.blinkPhase = 0;
    }
    if (animState.current.isBlinking) {
      animState.current.blinkPhase += delta * 8;
      if (animState.current.blinkPhase >= 1) {
        animState.current.isBlinking = false;
        animState.current.blinkTimer = 2 + Math.random() * 3;
        setExpr(vrm, 'blink', 0);
      } else {
        const v = animState.current.blinkPhase < 0.5
          ? animState.current.blinkPhase * 2
          : (1 - animState.current.blinkPhase) * 2;
        setExpr(vrm, 'blink', v);
      }
    }

    // Эмоции — плавная интерполяция
    const target = emotionToBlendshapes(emotion);
    const lerp = 1 - Math.pow(0.001, delta);
    for (const key of Object.keys(target) as Array<keyof typeof target>) {
      const cur = animState.current.current[key] as number;
      const tgt = target[key];
      animState.current.current[key] = cur + (tgt - cur) * lerp;
      setExpr(vrm, key as VRMExpressionPresetName, animState.current.current[key]);
    }

    // Липсинк
    if (speaking) {
      animState.current.mouthPhase += delta * 12;
      const mouth = (Math.sin(animState.current.mouthPhase) + 1) / 2 * 0.6;
      setExpr(vrm, 'aa', Math.max(animState.current.current.aa ?? 0, mouth));
    } else {
      const cur = animState.current.current.aa ?? 0;
      animState.current.current.aa = Math.max(0, cur - delta * 3);
      setExpr(vrm, 'aa', animState.current.current.aa);
    }

    // CRITICAL: update VRM every frame
    vrm.update(delta);
  });

  if (loadFailed) {
    return (
      <group position={[0, 1.2, 0]}>
        <mesh>
          <sphereGeometry args={[0.15, 16, 16]} />
          <meshStandardMaterial color="#c9a886" />
        </mesh>
      </group>
    );
  }

  return <group ref={groupRef} />;
}

function setExpr(vrm: VRM, name: VRMExpressionPresetName | string, value: number) {
  if (!vrm.expressionManager) return;
  try {
    vrm.expressionManager.setValue(name as VRMExpressionPresetName, Math.max(0, Math.min(1, value)));
  } catch { /* skip */ }
}

function emotionToBlendshapes(e: EmotionVector): Record<string, number> {
  return {
    happy:     Math.max(0, e.joy - 0.3) * 1.2,
    angry:     Math.max(0, e.irritation - 0.2) * 1.5,
    sad:       Math.max(0, e.sadness - 0.2) * 1.3,
    relaxed:   Math.max(0, e.calm - 0.3) * 0.8,
    surprised: Math.max(0, e.curiosity - 0.5) * 1.5,
    aa: 0,
  };
}
