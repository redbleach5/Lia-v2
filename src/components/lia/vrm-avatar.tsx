'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMExpressionPresetName } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import type { EmotionVector, EmotionAxis } from '@/lib/personality';
import { dominantEmotion } from '@/lib/emotion';
import {
  DEFAULT_AVATAR_CONFIG,
  LIGHTING_PRESETS,
  ARM_POSES,
  CAMERA_PRESETS,
  type AvatarConfig,
} from '@/lib/avatar-config';

export type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string;
  config?: AvatarConfig;
};

const DEFAULT_VRM_SRC = '/models/sample.vrm';

// ============================================================================
// Эмоция → цвет платформы
// Палитра тёплая, в стиле "лён" (см. globals.css)
// ============================================================================
const EMOTION_COLORS: Record<EmotionAxis, { base: string; glow: string }> = {
  joy:        { base: '#d4b89a', glow: '#e8c8a0' },
  curiosity:  { base: '#8b6f9a', glow: '#a58ab8' },
  calm:       { base: '#7a9a6b', glow: '#9ab88a' },
  irritation: { base: '#c2664a', glow: '#d97757' },
  sadness:    { base: '#7a8ba5', glow: '#9aabc0' },
};

export function VrmAvatar({
  emotion,
  speaking = false,
  size = 280,
  src = DEFAULT_VRM_SRC,
  config = DEFAULT_AVATAR_CONFIG,
}: VrmAvatarProps) {
  // Разрешаем финальную позицию камеры: для пресета берём значения из CAMERA_PRESETS,
  // для 'custom' — из config.camera.position/target/fov. Это позволяет пользователю
  // выбрать пресет и тут же видеть его, а потом переключиться в custom и тонко настроить.
  const cameraPos: [number, number, number] = config.camera.preset === 'custom'
    ? config.camera.position
    : CAMERA_PRESETS[config.camera.preset].position;
  const cameraTarget: [number, number, number] = config.camera.preset === 'custom'
    ? config.camera.target
    : CAMERA_PRESETS[config.camera.preset].target;
  const cameraFov = config.camera.preset === 'custom'
    ? config.camera.fov
    : CAMERA_PRESETS[config.camera.preset].fov;

  return (
    <div style={{ width: size, height: size }} className="relative">
      <BackgroundLayer config={config} />
      <Canvas
        camera={{ position: cameraPos, fov: cameraFov }}
        gl={{ alpha: config.background.style === 'transparent', antialias: true }}
        dpr={[1, 2]}
      >
        <Suspense fallback={null}>
          <Scene
            emotion={emotion}
            speaking={speaking}
            src={src}
            config={config}
            cameraTarget={cameraTarget}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

// ============================================================================
// Фон — отдельный CSS-слой под Canvas (alpha:true), чтобы не нагружать WebGL
// ============================================================================
function BackgroundLayer({ config }: { config: AvatarConfig }) {
  const { style, color, edgeColor } = config.background;
  if (style === 'transparent') return null;

  let bg: React.CSSProperties;
  if (style === 'solid') {
    bg = { background: color };
  } else if (style === 'gradient') {
    bg = { background: `linear-gradient(135deg, ${color} 0%, ${edgeColor} 100%)` };
  } else { // radial
    bg = { background: `radial-gradient(circle at 50% 40%, ${color} 0%, ${edgeColor} 100%)` };
  }

  return (
    <div
      className="absolute inset-0 rounded-lg pointer-events-none"
      style={bg}
    />
  );
}

function Scene({
  emotion,
  speaking,
  src,
  config,
  cameraTarget,
}: {
  emotion: EmotionVector;
  speaking: boolean;
  src: string;
  config: AvatarConfig;
  cameraTarget: [number, number, number];
}) {
  const dom = dominantEmotion(emotion);
  const colors = EMOTION_COLORS[dom];
  const intensity = Math.max(0.25, emotion[dom]);

  // Освещение — берём пресет и масштабируем на общую интенсивность
  const lights = LIGHTING_PRESETS[config.lighting.preset];
  const lightScale = config.lighting.intensity;

  return (
    <>
      <ambientLight intensity={lights.ambient.intensity * lightScale} color={lights.ambient.color} />
      <directionalLight
        position={lights.keyLight.position}
        intensity={lights.keyLight.intensity * lightScale}
        color={lights.keyLight.color}
      />
      <directionalLight
        position={lights.fillLight.position}
        intensity={lights.fillLight.intensity * lightScale}
        color={lights.fillLight.color}
      />
      {lights.hemisphere && (
        <hemisphereLight
          args={[lights.hemisphere.sky, lights.hemisphere.ground, lights.hemisphere.intensity * lightScale]}
        />
      )}

      <VrmModel emotion={emotion} speaking={speaking} src={src} config={config} />

      {config.platform.style !== 'off' && (
        <Platform colors={colors} intensity={intensity} config={config.platform} />
      )}

      <OrbitControls
        target={cameraTarget}
        enablePan={false}
        enableZoom={true}
        minDistance={0.6}
        maxDistance={2.0}
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
// Платформа — три стиля: classic / minimal / glow
// ============================================================================
function Platform({
  colors,
  intensity,
  config,
}: {
  colors: { base: string; glow: string };
  intensity: number;
  config: AvatarConfig['platform'];
}) {
  const baseMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const ringMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const innerRingMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const targetBase = useMemo(() => new THREE.Color(colors.base), [colors.base]);
  const targetGlow = useMemo(() => new THREE.Color(colors.glow), [colors.glow]);
  const radius = config.radius;

  useFrame(() => {
    const pulse = config.pulse ? (0.5 + Math.sin(performance.now() / 1000 * 1.5) * 0.15) : 0.7;

    if (baseMatRef.current) {
      baseMatRef.current.color.lerp(targetBase, 0.08);
      baseMatRef.current.opacity = THREE.MathUtils.lerp(baseMatRef.current.opacity, config.opacity, 0.08);
    }
    if (ringMatRef.current) {
      ringMatRef.current.color.lerp(targetGlow, 0.08);
      ringMatRef.current.opacity = THREE.MathUtils.lerp(ringMatRef.current.opacity, 0.9, 0.08);
    }
    if (innerRingMatRef.current) {
      innerRingMatRef.current.color.lerp(targetGlow, 0.08);
      innerRingMatRef.current.opacity = THREE.MathUtils.lerp(innerRingMatRef.current.opacity, 0.6, 0.08);
    }
    if (glowMatRef.current) {
      glowMatRef.current.color.lerp(targetGlow, 0.08);
      glowMatRef.current.opacity = THREE.MathUtils.lerp(
        glowMatRef.current.opacity,
        0.15 + intensity * 0.35 * pulse,
        0.08,
      );
    }
  });

  // 'minimal' — только диск, без колец и halo
  // 'classic' — диск + два кольца + halo (по умолчанию)
  // 'glow' — тонкий диск + мощное свечение (для драматичного вида)
  const isMinimal = config.style === 'minimal';
  const isGlow = config.style === 'glow';

  return (
    <group>
      {/* Основной диск платформы */}
      <mesh position={[0, 0.015, 0]} receiveShadow>
        <cylinderGeometry args={[radius, radius + 0.04, 0.04, 64]} />
        <meshStandardMaterial
          ref={baseMatRef}
          color={colors.base}
          transparent
          opacity={config.opacity}
          roughness={isGlow ? 0.15 : 0.55}
          metalness={isGlow ? 0.3 : 0.05}
        />
      </mesh>

      {/* Внешнее светящееся кольцо — индикатор эмоции */}
      {!isMinimal && (
        <mesh position={[0, 0.04, 0]}>
          <torusGeometry args={[radius, 0.012, 16, 96]} />
          <meshStandardMaterial
            ref={ringMatRef}
            color={colors.glow}
            emissive={colors.glow}
            emissiveIntensity={isGlow ? 1.2 : 0.6}
            transparent
            opacity={0.9}
            roughness={0.3}
          />
        </mesh>
      )}

      {/* Внутреннее светящееся кольцо */}
      {config.showInnerRing && !isMinimal && (
        <mesh position={[0, 0.04, 0]}>
          <torusGeometry args={[radius * 0.76, 0.006, 12, 64]} />
          <meshStandardMaterial
            ref={innerRingMatRef}
            color={colors.glow}
            emissive={colors.glow}
            emissiveIntensity={0.4}
            transparent
            opacity={0.6}
            roughness={0.3}
          />
        </mesh>
      )}

      {/* Мягкое свечение под платформой (halo на полу) */}
      {config.showHalo && (
        <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[radius * 1.3, 64]} />
          <meshBasicMaterial
            ref={glowMatRef}
            color={colors.glow}
            transparent
            opacity={0.2}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

function VrmModel({
  emotion,
  speaking,
  src,
  config,
}: {
  emotion: EmotionVector;
  speaking: boolean;
  src: string;
  config: AvatarConfig;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // При смене src — перезагружаем VRM
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
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          console.error('[VRM] No VRM in gltf');
          setLoadFailed(true);
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        // VRM смотрит в -Z по спецификации, камера на +Z — аватар уже лицом к нам.
        vrm.scene.rotation.y = 0;

        // Применяем выбранную позу рук
        const pose = ARM_POSES[config.body.armPose];
        if (vrm.humanoid) {
          const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
          const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
          if (leftUpperArm) leftUpperArm.rotation.z = pose.leftUpperArmZ;
          if (rightUpperArm) rightUpperArm.rotation.z = pose.rightUpperArmZ;

          const leftLowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
          const rightLowerArm = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
          if (leftLowerArm) leftLowerArm.rotation.x = pose.leftLowerArmX;
          if (rightLowerArm) rightLowerArm.rotation.x = pose.rightLowerArmX;

          const leftHand = vrm.humanoid.getNormalizedBoneNode('leftHand');
          const rightHand = vrm.humanoid.getNormalizedBoneNode('rightHand');
          if (leftHand) leftHand.rotation.z = pose.leftHandZ;
          if (rightHand) rightHand.rotation.z = pose.rightHandZ;
        }

        // Масштаб и вертикальное смещение
        vrm.scene.scale.setScalar(config.body.scale);
        vrm.scene.position.y = config.body.yOffset;

        if (groupRef.current) {
          while (groupRef.current.children.length > 0) {
            groupRef.current.remove(groupRef.current.children[0]);
          }
          groupRef.current.add(vrm.scene);
        }
        vrmRef.current = vrm;
        setLoaded(true);
        console.log('[VRM] loaded successfully, pose:', config.body.armPose);
      },
      undefined,
      (err) => {
        if (cancelled) return;
        console.error('[VRM] load failed:', err);
        setLoadFailed(true);
      },
    );

    return () => { cancelled = true; };
  }, [src, config.body.armPose, config.body.scale, config.body.yOffset]);

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

    // Дыхание — лёгкое движение спины
    if (config.animation.breathing && vrm.humanoid) {
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      if (spine) spine.rotation.x = Math.sin(t * 0.8) * 0.02;
    }

    // Покачивание головой
    if (config.animation.headSway && vrm.humanoid) {
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        head.rotation.y = Math.sin(t * 0.3) * 0.06;
        head.rotation.x = Math.sin(t * 0.2) * 0.025;
      }
    }

    // Моргание
    if (config.animation.blinking) {
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
    }

    // Эмоции — плавная интерполяция к целевым blendshapes
    if (config.animation.emotionMorph) {
      const target = emotionToBlendshapes(emotion);
      const lerp = 1 - Math.pow(0.001, delta);
      for (const key of Object.keys(target) as Array<keyof typeof target>) {
        const cur = animState.current.current[key] as number;
        const tgt = target[key];
        animState.current.current[key] = cur + (tgt - cur) * lerp;
        setExpr(vrm, key as VRMExpressionPresetName, animState.current.current[key]);
      }
    }

    // Липсинк во время стриминга
    if (config.animation.lipSync && speaking) {
      animState.current.mouthPhase += delta * 12;
      const mouth = (Math.sin(animState.current.mouthPhase) + 1) / 2 * 0.6;
      setExpr(vrm, 'aa', Math.max(animState.current.current.aa ?? 0, mouth));
    } else {
      const cur = animState.current.current.aa ?? 0;
      animState.current.current.aa = Math.max(0, cur - delta * 3);
      setExpr(vrm, 'aa', animState.current.current.aa);
    }

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
