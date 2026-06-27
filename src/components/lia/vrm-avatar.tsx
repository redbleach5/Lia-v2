'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
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
  type PlatformShape,
  type RingAnimation,
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
// Фон — отдельный CSS-слой под Canvas
// ============================================================================
function BackgroundLayer({ config }: { config: AvatarConfig }) {
  const { style, color, edgeColor } = config.background;
  if (style === 'transparent') return null;

  let bg: React.CSSProperties;
  if (style === 'solid') {
    bg = { background: color };
  } else if (style === 'gradient') {
    bg = { background: `linear-gradient(135deg, ${color} 0%, ${edgeColor} 100%)` };
  } else {
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

  const lights = LIGHTING_PRESETS[config.lighting.preset];
  const lightScale = config.lighting.intensity;

  return (
    <>
      <ambientLight intensity={lights.ambient.intensity * lightScale} color={lights.ambient.color} />
      <directionalLight
        position={lights.keyLight.position}
        intensity={lights.keyLight.intensity * lightScale}
        color={lights.keyLight.color}
        castShadow
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

      {config.platform.shape !== 'off' && (
        <Platform colors={colors} intensity={intensity} config={config.platform} />
      )}

      <OrbitControls
        target={cameraTarget}
        enablePan={false}
        enableZoom={true}
        minDistance={0.6}
        maxDistance={4.0}
        minPolarAngle={Math.PI / 6}
        maxPolarAngle={Math.PI / 2.02}
        minAzimuthAngle={-Math.PI / 5}
        maxAzimuthAngle={Math.PI / 5}
        enableDamping
        dampingFactor={0.08}
      />
    </>
  );
}

// ============================================================================
// Платформа — 4 формы (disc/hexagon/ring/pedestal) + 4 анимации кольца
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
  const ringGroupRef = useRef<THREE.Group>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const targetBase = useMemo(() => new THREE.Color(colors.base), [colors.base]);
  const targetGlow = useMemo(() => new THREE.Color(colors.glow), [colors.glow]);
  const radius = config.radius;
  const height = config.height;

  useFrame(() => {
    const t = performance.now() / 1000;
    // Базовая пульсация для всех анимаций кроме 'solid'
    const pulse = config.ringAnimation === 'pulse'
      ? 0.5 + Math.sin(t * 1.5) * 0.25
      : config.ringAnimation === 'breathing'
        ? 0.6 + Math.sin(t * 0.8) * 0.3
        : 0.7;

    if (baseMatRef.current) {
      baseMatRef.current.color.lerp(targetBase, 0.08);
      baseMatRef.current.opacity = THREE.MathUtils.lerp(baseMatRef.current.opacity, config.opacity, 0.08);
    }
    if (ringMatRef.current) {
      ringMatRef.current.color.lerp(targetGlow, 0.08);
      const targetOp = config.ringAnimation === 'solid' ? 0.9 : 0.5 + pulse * 0.5;
      ringMatRef.current.opacity = THREE.MathUtils.lerp(ringMatRef.current.opacity, targetOp, 0.08);
      ringMatRef.current.emissiveIntensity = THREE.MathUtils.lerp(
        ringMatRef.current.emissiveIntensity,
        0.4 + pulse * 0.6,
        0.08,
      );
    }
    if (innerRingMatRef.current) {
      innerRingMatRef.current.color.lerp(targetGlow, 0.08);
      innerRingMatRef.current.opacity = THREE.MathUtils.lerp(innerRingMatRef.current.opacity, 0.4 + pulse * 0.3, 0.08);
    }
    if (glowMatRef.current) {
      glowMatRef.current.color.lerp(targetGlow, 0.08);
      glowMatRef.current.opacity = THREE.MathUtils.lerp(
        glowMatRef.current.opacity,
        0.15 + intensity * 0.35 * pulse,
        0.08,
      );
    }
    // Вращение кольца
    if (ringGroupRef.current && config.ringAnimation === 'rotate') {
      ringGroupRef.current.rotation.y += 0.01 * config.rotateSpeed;
    }
    // Контактная тень — лёгкая пульсация размера в такт дыханию аватара
    if (shadowMatRef.current) {
      const breath = 0.95 + Math.sin(t * 0.8) * 0.05;
      shadowMatRef.current.opacity = THREE.MathUtils.lerp(
        shadowMatRef.current.opacity,
        0.25 * breath,
        0.08,
      );
    }
  });

  return (
    <group>
      {/* ── Геометрия платформы зависит от формы ── */}
      <PlatformGeometry shape={config.shape} radius={radius} height={height}>
        <meshStandardMaterial
          ref={baseMatRef}
          color={colors.base}
          transparent
          opacity={config.opacity}
          roughness={0.55}
          metalness={0.05}
        />
      </PlatformGeometry>

      {/* ── Внешнее светящееся кольцо (кроме ring — там только кольцо) ── */}
      <group ref={ringGroupRef}>
        <mesh position={[0, height + 0.005, 0]}>
          <torusGeometry args={[radius, 0.012, 16, 96]} />
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
        {config.showInnerRing && (
          <mesh position={[0, height + 0.005, 0]}>
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
      </group>

      {/* Мягкое свечение под платформой (halo на полу) */}
      {config.showHalo && (
        <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[radius * 1.4, 64]} />
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

      {/* Контактная тень под аватаром — мягкий тёмный диск */}
      {config.showShadow && (
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[radius * 0.55, 32]} />
          <meshBasicMaterial
            ref={shadowMatRef}
            color="#000000"
            transparent
            opacity={0.25}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

// ============================================================================
// Геометрия платформы — выбирается по форме
// ============================================================================
function PlatformGeometry({
  shape,
  radius,
  height,
  children,
}: {
  shape: PlatformShape;
  radius: number;
  height: number;
  children: React.ReactNode;
}) {
  if (shape === 'ring') {
    // Только тонкий диск-кольцо, без заполнения
    return (
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[radius, radius, height, 64, 1, true]} />
        {children}
      </mesh>
    );
  }
  if (shape === 'hexagon') {
    // Шестиугольная призма — 6 граней
    return (
      <mesh position={[0, height / 2, 0]} rotation={[0, Math.PI / 6, 0]}>
        <cylinderGeometry args={[radius, radius * 1.05, height, 6]} />
        {children}
      </mesh>
    );
  }
  if (shape === 'pedestal') {
    // Пьедестал — высокий диск сверху + широкое основание снизу
    return (
      <group>
        {/* Верхняя часть — диск на высоте */}
        <mesh position={[0, height, 0]}>
          <cylinderGeometry args={[radius, radius, 0.03, 64]} />
          {children}
        </mesh>
        {/* Основание — шире и ниже */}
        <mesh position={[0, height * 0.25, 0]}>
          <cylinderGeometry args={[radius * 1.15, radius * 1.25, height * 0.5, 64]} />
          {children}
        </mesh>
      </group>
    );
  }
  // disc — классический круглый диск (по умолчанию)
  return (
    <mesh position={[0, height / 2, 0]}>
      <cylinderGeometry args={[radius, radius + 0.04, height, 64]} />
      {children}
    </mesh>
  );
}

// ============================================================================
// VrmModel — загрузка VRM + все idle-анимации
// ============================================================================
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

  // При смене src или позы — перезагружаем VRM
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
        vrm.scene.rotation.y = 0;

        if (vrm.expressionManager) {
          vrm.expressionManager.resetValues();
        }

        // Применяем позу рук
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

  // ── Состояние анимаций ──
  // Каждый канал — отдельное значение, чтобы их можно было комбинировать без конфликтов.
  // phaseX — фаза для синусоиды (накапливается со временем).
  // baseRotationX — сохранённая базовая ротация кости (для возврата к позе после эмоции).
  const animState = useRef({
    blinkTimer: 2 + Math.random() * 3,
    isBlinking: false,
    blinkPhase: 0,
    blinkDuration: 0.15,
    mouthPhase: 0,
    mouthValue: 0,
    gazeX: 0,
    gazeY: 0,
    targetGazeX: 0,
    targetGazeY: 0,
    current: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 },
    // Фазы для разных частот движения
    breathPhase: 0,
    swayPhase: 0,
    armPhase: 0,
    weightPhase: 0,
    headPhase: 0,
    // Базовые ротации костей (сохраняем при загрузке, возвращаемся к ним)
    baseSpineRotX: 0,
    baseSpineRotY: 0,
    baseHeadRotX: 0,
    baseHeadRotY: 0,
    baseLeftUpperArmZ: 0,
    baseRightUpperArmZ: 0,
    baseHipsRotY: 0,
    baseLeftShoulderRotZ: 0,
    baseRightShoulderRotZ: 0,
  });

  // ── Отслеживание позиции мыши для gaze follow ──
  const mouseRef = useRef({ x: 0, y: 0, hasMouse: false });
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      // Нормализованные координаты -1..1 относительно центра canvas
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      mouseRef.current.hasMouse = true;
    };
    const onMouseLeave = () => {
      mouseRef.current.hasMouse = false;
    };
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [gl]);

  // Сохраняем базовые ротации костей после загрузки VRM — нужно для корректного возврата
  // к исходной позе при отключении анимаций
  useEffect(() => {
    if (!loaded) return;
    const vrm = vrmRef.current;
    if (!vrm?.humanoid) return;

    const spine = vrm.humanoid.getNormalizedBoneNode('spine');
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    const leftShoulder = vrm.humanoid.getNormalizedBoneNode('leftShoulder');
    const rightShoulder = vrm.humanoid.getNormalizedBoneNode('rightShoulder');

    if (spine) {
      animState.current.baseSpineRotX = spine.rotation.x;
      animState.current.baseSpineRotY = spine.rotation.y;
    }
    if (head) {
      animState.current.baseHeadRotX = head.rotation.x;
      animState.current.baseHeadRotY = head.rotation.y;
    }
    if (hips) animState.current.baseHipsRotY = hips.rotation.y;
    if (leftUpperArm) animState.current.baseLeftUpperArmZ = leftUpperArm.rotation.z;
    if (rightUpperArm) animState.current.baseRightUpperArmZ = rightUpperArm.rotation.z;
    if (leftShoulder) animState.current.baseLeftShoulderRotZ = leftShoulder.rotation.z;
    if (rightShoulder) animState.current.baseRightShoulderRotZ = rightShoulder.rotation.z;
  }, [loaded]);

  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !loaded) return;
    const cfg = config.animation;
    // idleFrequency — множитель скорости всех idle-анимаций. 1.0 = норма.
    const freq = cfg.idleFrequency;

    // Накапливаем фазы — каждый канал со своей частотой, чтобы движения не были синхронны
    animState.current.breathPhase += delta * 0.8 * freq;
    animState.current.swayPhase += delta * 0.35 * freq;
    animState.current.armPhase += delta * 0.5 * freq;
    animState.current.weightPhase += delta * 0.18 * freq;
    animState.current.headPhase += delta * 0.28 * freq;

    // ── Дыхание — спина + плечи ──
    if (cfg.breathing && vrm.humanoid) {
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      if (spine) {
        const breath = Math.sin(animState.current.breathPhase) * 0.025;
        spine.rotation.x = animState.current.baseSpineRotX + breath;
        // Лёгкое боковое движение при дыхании
        spine.rotation.z = Math.sin(animState.current.breathPhase * 0.5) * 0.008;
      }
      // Плечи слегка поднимаются на вдохе
      const leftShoulder = vrm.humanoid.getNormalizedBoneNode('leftShoulder');
      const rightShoulder = vrm.humanoid.getNormalizedBoneNode('rightShoulder');
      const shoulderLift = Math.sin(animState.current.breathPhase) * 0.015;
      if (leftShoulder) leftShoulder.rotation.z = animState.current.baseLeftShoulderRotZ + shoulderLift;
      if (rightShoulder) rightShoulder.rotation.z = animState.current.baseRightShoulderRotZ - shoulderLift;
    }

    // ── Покачивание всем телом (бёдра + плечи в противофазе) ──
    if (cfg.bodySway && vrm.humanoid) {
      const hips = vrm.humanoid.getNormalizedBoneNode('hips');
      if (hips) {
        hips.rotation.y = animState.current.baseHipsRotY + Math.sin(animState.current.swayPhase) * 0.04;
        hips.rotation.z = Math.sin(animState.current.swayPhase * 0.7) * 0.015;
      }
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      if (spine) {
        // Спина слегка компенсирует движение бёдер (как при реальной ходьбе)
        spine.rotation.y = animState.current.baseSpineRotY + Math.sin(animState.current.swayPhase + Math.PI) * 0.02;
      }
    }

    // ── Перенос веса с ноги на ногу (медленный цикл) ──
    if (cfg.weightShift && vrm.humanoid) {
      const hips = vrm.humanoid.getNormalizedBoneNode('hips');
      if (hips) {
        // Смещение бёдер по X + наклон
        const shift = Math.sin(animState.current.weightPhase) * 0.025;
        hips.position.x = shift;
      }
      const leftUpperLeg = vrm.humanoid.getNormalizedBoneNode('leftUpperLeg');
      const rightUpperLeg = vrm.humanoid.getNormalizedBoneNode('rightUpperLeg');
      const weight = Math.sin(animState.current.weightPhase);
      if (leftUpperLeg) leftUpperLeg.rotation.z = weight * 0.02;
      if (rightUpperLeg) rightUpperLeg.rotation.z = weight * 0.02;
    }

    // ── Микро-движения рук (как при лёгком покачивании) ──
    if (cfg.armSway && vrm.humanoid) {
      const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
      const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      // Руки качаются в противофазе с бёдрами
      const armSway = Math.sin(animState.current.armPhase) * 0.04;
      const armSway2 = Math.sin(animState.current.armPhase + Math.PI) * 0.04;
      if (leftUpperArm) {
        leftUpperArm.rotation.z = animState.current.baseLeftUpperArmZ + armSway;
        leftUpperArm.rotation.x = Math.sin(animState.current.armPhase * 0.7) * 0.02;
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.z = animState.current.baseRightUpperArmZ + armSway2;
        rightUpperArm.rotation.x = Math.sin(animState.current.armPhase * 0.7 + Math.PI) * 0.02;
      }
    }

    // ── Эмоциональная поза — изменения костей под эмоцию ──
    if (cfg.emotionPose && vrm.humanoid) {
      applyEmotionPose(vrm, emotion, animState.current, delta);
    }

    // ── Покачивание головой + gaze follow ──
    if (vrm.humanoid) {
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        if (cfg.headSway) {
          // Базовое покачивание головой — независимый ритм от тела
          const headY = Math.sin(animState.current.headPhase) * 0.08;
          const headX = Math.sin(animState.current.headPhase * 0.6) * 0.03;
          // Сохраняем базовое + добавляем эмоциональное + idle
          head.rotation.y = animState.current.baseHeadRotY + headY;
          head.rotation.x = animState.current.baseHeadRotX + headX;
        }
        // Gaze follow — глаза/голова следуют за курсором
        if (cfg.gazeFollow && mouseRef.current.hasMouse) {
          // Плавно интерполируем к целевому направлению взгляда
          animState.current.targetGazeX = mouseRef.current.x * 0.15;
          animState.current.targetGazeY = mouseRef.current.y * 0.10;
          animState.current.gazeX = THREE.MathUtils.lerp(animState.current.gazeX, animState.current.targetGazeX, 0.05);
          animState.current.gazeY = THREE.MathUtils.lerp(animState.current.gazeY, animState.current.targetGazeY, 0.05);
          head.rotation.y += animState.current.gazeX;
          head.rotation.x += animState.current.gazeY;
        } else {
          // Без мыши — плавно возвращаем взгляд к центру
          animState.current.gazeX = THREE.MathUtils.lerp(animState.current.gazeX, 0, 0.05);
          animState.current.gazeY = THREE.MathUtils.lerp(animState.current.gazeY, 0, 0.05);
        }
      }
    }

    // ── Моргание (с редкими двойными морганиями) ──
    if (cfg.blinking) {
      animState.current.blinkTimer -= delta;
      if (!animState.current.isBlinking && animState.current.blinkTimer < 0) {
        animState.current.isBlinking = true;
        animState.current.blinkPhase = 0;
        // 15% шанс двойного моргания —眨眨
        const isDouble = Math.random() < 0.15;
        animState.current.blinkDuration = isDouble ? 0.35 : 0.15;
      }
      if (animState.current.isBlinking) {
        animState.current.blinkPhase += delta / (animState.current.blinkDuration ?? 0.15);
        if (animState.current.blinkPhase >= 1) {
          animState.current.isBlinking = false;
          // Случайный интервал до следующего моргания: 2-6 сек
          animState.current.blinkTimer = 2 + Math.random() * 4;
          setExpr(vrm, 'blink', 0);
        } else {
          // Треугольная функция: 0 → 1 → 0. Для двойного моргания — две волны.
          let v;
          if (animState.current.blinkDuration && animState.current.blinkDuration > 0.25) {
            // Двойное моргание: две треугольные волны
            const half = animState.current.blinkPhase * 2;
            const localPhase = half % 1;
            v = localPhase < 0.5 ? localPhase * 2 : (1 - localPhase) * 2;
          } else {
            v = animState.current.blinkPhase < 0.5
              ? animState.current.blinkPhase * 2
              : (1 - animState.current.blinkPhase) * 2;
          }
          setExpr(vrm, 'blink', v);
        }
      }
    }

    // ── Эмоции — плавная интерполяция к целевым blendshapes ──
    if (cfg.emotionMorph) {
      const target = emotionToBlendshapes(emotion);
      const lerp = 1 - Math.pow(0.001, delta);
      for (const key of Object.keys(target) as Array<keyof typeof target>) {
        if (key === 'aa') continue;
        const cur = animState.current.current[key] as number;
        const tgt = target[key];
        animState.current.current[key] = cur + (tgt - cur) * lerp;
        setExpr(vrm, key as VRMExpressionPresetName, animState.current.current[key]);
      }
    }

    // ── Липсинк — управляет ТОЛЬКО 'aa' ──
    if (cfg.lipSync && speaking) {
      animState.current.mouthPhase += delta * 12;
      const target = (Math.sin(animState.current.mouthPhase) + 1) / 2 * 0.5;
      animState.current.mouthValue = THREE.MathUtils.lerp(animState.current.mouthValue, target, 0.3);
    } else {
      animState.current.mouthValue = Math.max(0, animState.current.mouthValue - delta * 2);
    }
    setExpr(vrm, 'aa', animState.current.mouthValue);

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

// ============================================================================
// Эмоциональная поза — изменения скелета под текущую эмоцию.
// Применяется поверх idle-анимаций (с маленьким весом), чтобы поза «дышала»
// вместе с эмоцией, а не застывала.
// ============================================================================
function applyEmotionPose(
  vrm: VRM,
  emotion: EmotionVector,
  state: {
    breathPhase: number;
    swayPhase: number;
  },
  delta: number,
) {
  if (!vrm.humanoid) return;
  const t = performance.now() / 1000;

  // Joy (радость) — лёгкое подпрыгивание, плечи чуть назад (открытая поза)
  if (emotion.joy > 0.6) {
    const bounce = Math.sin(t * 2.5) * 0.015 * (emotion.joy - 0.5);
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) hips.position.y = bounce;
  }

  // Sadness (грусть) — плечи опускаются вперёд, голова клонится вниз
  if (emotion.sadness > 0.4) {
    const intensity = (emotion.sadness - 0.3) * 0.5;
    const spine = vrm.humanoid.getNormalizedBoneNode('spine');
    if (spine) spine.rotation.x += intensity * 0.08;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) head.rotation.x += intensity * 0.1;
    const leftShoulder = vrm.humanoid.getNormalizedBoneNode('leftShoulder');
    const rightShoulder = vrm.humanoid.getNormalizedBoneNode('rightShoulder');
    if (leftShoulder) leftShoulder.rotation.z += intensity * 0.05;
    if (rightShoulder) rightShoulder.rotation.z -= intensity * 0.05;
  }

  // Irritation (раздражение) — лёгкое скрещивание рук, подбородок вверх
  if (emotion.irritation > 0.4) {
    const intensity = (emotion.irritation - 0.3) * 0.5;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) head.rotation.x -= intensity * 0.06;
    const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    // Слегка приближаем руки к корпусу
    if (leftUpperArm) leftUpperArm.rotation.z += intensity * 0.04;
    if (rightUpperArm) rightUpperArm.rotation.z -= intensity * 0.04;
  }

  // Curiosity (любопытство) — лёгкий наклон головы вбок
  if (emotion.curiosity > 0.6) {
    const intensity = (emotion.curiosity - 0.5) * 0.3;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) head.rotation.z = Math.sin(t * 0.4) * intensity * 0.08;
  }

  // Calm (спокойствие) — расслабленные плечи, мягкое покачивание
  if (emotion.calm > 0.6) {
    const intensity = (emotion.calm - 0.5) * 0.2;
    const leftShoulder = vrm.humanoid.getNormalizedBoneNode('leftShoulder');
    const rightShoulder = vrm.humanoid.getNormalizedBoneNode('rightShoulder');
    if (leftShoulder) leftShoulder.rotation.z -= intensity * 0.03;
    if (rightShoulder) rightShoulder.rotation.z += intensity * 0.03;
  }

  // delta используется только для согласованности сигнатуры;
  // реальные плавные переходы уже делает lerp в основном цикле
  void delta;
  void state;
}

function setExpr(vrm: VRM, name: VRMExpressionPresetName | string, value: number) {
  if (!vrm.expressionManager) return;
  try {
    vrm.expressionManager.setValue(name as VRMExpressionPresetName, Math.max(0, Math.min(1, value)));
  } catch { /* skip */ }
}

function emotionToBlendshapes(e: EmotionVector): Record<string, number> {
  // 'aa' намеренно отсутствует — управляется липсинком.
  // 'surprised' не используется — открывает рот.
  return {
    happy:     Math.max(0, e.joy - 0.4) * 1.0,
    angry:     Math.max(0, e.irritation - 0.35) * 1.2,
    sad:       Math.max(0, e.sadness - 0.3) * 1.1,
    relaxed:   Math.max(0, e.calm - 0.5) * 0.7,
    surprised: 0,
    aa: 0,
  };
}
