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
// Платформа — 4 формы + 4 анимации кольца
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
    if (ringGroupRef.current && config.ringAnimation === 'rotate') {
      ringGroupRef.current.rotation.y += 0.01 * config.rotateSpeed;
    }
    if (shadowMatRef.current) {
      const breath = 0.95 + Math.sin(t * 0.8) * 0.05;
      shadowMatRef.current.opacity = THREE.MathUtils.lerp(shadowMatRef.current.opacity, 0.25 * breath, 0.08);
    }
  });

  return (
    <group>
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
    return (
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[radius, radius, height, 64, 1, true]} />
        {children}
      </mesh>
    );
  }
  if (shape === 'hexagon') {
    return (
      <mesh position={[0, height / 2, 0]} rotation={[0, Math.PI / 6, 0]}>
        <cylinderGeometry args={[radius, radius * 1.05, height, 6]} />
        {children}
      </mesh>
    );
  }
  if (shape === 'pedestal') {
    return (
      <group>
        <mesh position={[0, height, 0]}>
          <cylinderGeometry args={[radius, radius, 0.03, 64]} />
          {children}
        </mesh>
        <mesh position={[0, height * 0.25, 0]}>
          <cylinderGeometry args={[radius * 1.15, radius * 1.25, height * 0.5, 64]} />
          {children}
        </mesh>
      </group>
    );
  }
  return (
    <mesh position={[0, height / 2, 0]}>
      <cylinderGeometry args={[radius, radius + 0.04, height, 64]} />
      {children}
    </mesh>
  );
}

// ============================================================================
// BoneBases — все базовые rotations/positions для костей, которые
// мы модифицируем в useFrame. Сохраняются ОДИН раз после применения позы.
// Каждая анимация в useFrame использует absolute = base + delta,
// а не += (которая накапливается и ломает позу).
// ============================================================================
type BoneBases = {
  // hips
  hipsPosX: number;
  hipsPosY: number;
  hipsRotX: number;
  hipsRotY: number;
  hipsRotZ: number;
  // spine
  spineRotX: number;
  spineRotY: number;
  spineRotZ: number;
  // head
  headRotX: number;
  headRotY: number;
  headRotZ: number;
  // shoulders
  leftShoulderRotZ: number;
  rightShoulderRotZ: number;
  // upper arms
  leftUpperArmRotX: number;
  leftUpperArmRotZ: number;
  rightUpperArmRotX: number;
  rightUpperArmRotZ: number;
  // upper legs (для weightShift)
  leftUpperLegRotZ: number;
  rightUpperLegRotZ: number;
};

function createEmptyBases(): BoneBases {
  return {
    hipsPosX: 0, hipsPosY: 0, hipsRotX: 0, hipsRotY: 0, hipsRotZ: 0,
    spineRotX: 0, spineRotY: 0, spineRotZ: 0,
    headRotX: 0, headRotY: 0, headRotZ: 0,
    leftShoulderRotZ: 0, rightShoulderRotZ: 0,
    leftUpperArmRotX: 0, leftUpperArmRotZ: 0,
    rightUpperArmRotX: 0, rightUpperArmRotZ: 0,
    leftUpperLegRotZ: 0, rightUpperLegRotZ: 0,
  };
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
  const basesRef = useRef<BoneBases>(createEmptyBases());
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // ── Загрузка VRM + применение позы + сохранение баз ──
  // ВСЁ в одном useEffect, чтобы гарантировать порядок:
  //   1. load → 2. resetValues → 3. apply pose → 4. capture bases
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

        // Сброс морфов
        if (vrm.expressionManager) {
          vrm.expressionManager.resetValues();
        }

        // ── Применяем позу рук ──
        const pose = ARM_POSES[config.body.armPose];
        const humanoid = vrm.humanoid;
        if (humanoid) {
          const setBoneRot = (name: string, axis: 'x' | 'y' | 'z', value: number) => {
            const node = humanoid.getNormalizedBoneNode(name as never);
            if (node) node.rotation[axis] = value;
          };
          setBoneRot('leftUpperArm', 'z', pose.leftUpperArmZ);
          setBoneRot('rightUpperArm', 'z', pose.rightUpperArmZ);
          setBoneRot('leftLowerArm', 'x', pose.leftLowerArmX);
          setBoneRot('rightLowerArm', 'x', pose.rightLowerArmX);
          setBoneRot('leftHand', 'z', pose.leftHandZ);
          setBoneRot('rightHand', 'z', pose.rightHandZ);
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

        // ── Сохраняем базы ВСЕХ костей, которые будем модифицировать ──
        // Делаем это ПОСЛЕ применения позы, чтобы базы включали выбранную позу рук.
        if (humanoid) {
          const getBone = (name: string) => humanoid.getNormalizedBoneNode(name as never);
          const hips = getBone('hips');
          const spine = getBone('spine');
          const head = getBone('head');
          const leftShoulder = getBone('leftShoulder');
          const rightShoulder = getBone('rightShoulder');
          const leftUpperArm = getBone('leftUpperArm');
          const rightUpperArm = getBone('rightUpperArm');
          const leftUpperLeg = getBone('leftUpperLeg');
          const rightUpperLeg = getBone('rightUpperLeg');

          const b = basesRef.current;
          if (hips) {
            b.hipsPosX = hips.position.x;
            b.hipsPosY = hips.position.y;
            b.hipsRotX = hips.rotation.x;
            b.hipsRotY = hips.rotation.y;
            b.hipsRotZ = hips.rotation.z;
          }
          if (spine) {
            b.spineRotX = spine.rotation.x;
            b.spineRotY = spine.rotation.y;
            b.spineRotZ = spine.rotation.z;
          }
          if (head) {
            b.headRotX = head.rotation.x;
            b.headRotY = head.rotation.y;
            b.headRotZ = head.rotation.z;
          }
          if (leftShoulder) b.leftShoulderRotZ = leftShoulder.rotation.z;
          if (rightShoulder) b.rightShoulderRotZ = rightShoulder.rotation.z;
          if (leftUpperArm) {
            b.leftUpperArmRotX = leftUpperArm.rotation.x;
            b.leftUpperArmRotZ = leftUpperArm.rotation.z;
          }
          if (rightUpperArm) {
            b.rightUpperArmRotX = rightUpperArm.rotation.x;
            b.rightUpperArmRotZ = rightUpperArm.rotation.z;
          }
          if (leftUpperLeg) b.leftUpperLegRotZ = leftUpperLeg.rotation.z;
          if (rightUpperLeg) b.rightUpperLegRotZ = rightUpperLeg.rotation.z;

          console.log('[VRM] pose applied, bases captured:', {
            armPose: config.body.armPose,
            leftUpperArmRotZ: b.leftUpperArmRotZ.toFixed(3),
            rightUpperArmRotZ: b.rightUpperArmRotZ.toFixed(3),
            hipsPosY: b.hipsPosY.toFixed(3),
          });
        }

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
    breathPhase: 0,
    swayPhase: 0,
    armPhase: 0,
    weightPhase: 0,
    headPhase: 0,
  });

  // ── Gaze follow — отслеживание мыши ──
  const mouseRef = useRef({ x: 0, y: 0, hasMouse: false });
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      mouseRef.current.hasMouse = true;
    };
    const onMouseLeave = () => { mouseRef.current.hasMouse = false; };
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [gl]);

  // ── Главный цикл анимации ──
  // АРХИТЕКТУРА: каждый кадр начинаем с базовых значений, потом накладываем
  // все активные анимации как absolute = base + delta. Никаких += !
  // Это гарантирует, что поза не «уплывает» со временем и что выключение
  // любой анимации мгновенно возвращает кость к базе.
  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !loaded) return;
    const humanoid = vrm.humanoid;
    if (!humanoid) return;
    const cfg = config.animation;
    const freq = cfg.idleFrequency;
    const b = basesRef.current;
    const t = performance.now() / 1000;

    // Накапливаем фазы
    animState.current.breathPhase += delta * 0.8 * freq;
    animState.current.swayPhase += delta * 0.35 * freq;
    animState.current.armPhase += delta * 0.5 * freq;
    animState.current.weightPhase += delta * 0.18 * freq;
    animState.current.headPhase += delta * 0.28 * freq;

    // Получаем кости один раз
    const hips = humanoid.getNormalizedBoneNode('hips' as never);
    const spine = humanoid.getNormalizedBoneNode('spine' as never);
    const head = humanoid.getNormalizedBoneNode('head' as never);
    const leftShoulder = humanoid.getNormalizedBoneNode('leftShoulder' as never);
    const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder' as never);
    const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm' as never);
    const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm' as never);
    const leftUpperLeg = humanoid.getNormalizedBoneNode('leftUpperLeg' as never);
    const rightUpperLeg = humanoid.getNormalizedBoneNode('rightUpperLeg' as never);

    // ── Шаг 1: сброс ВСЕХ модифицируемых костей к базе ──
    // Это гарантирует, что выключение любой анимации мгновенно возвращает позу.
    if (hips) {
      hips.position.x = b.hipsPosX;
      hips.position.y = b.hipsPosY;
      hips.rotation.x = b.hipsRotX;
      hips.rotation.y = b.hipsRotY;
      hips.rotation.z = b.hipsRotZ;
    }
    if (spine) {
      spine.rotation.x = b.spineRotX;
      spine.rotation.y = b.spineRotY;
      spine.rotation.z = b.spineRotZ;
    }
    if (head) {
      head.rotation.x = b.headRotX;
      head.rotation.y = b.headRotY;
      head.rotation.z = b.headRotZ;
    }
    if (leftShoulder) leftShoulder.rotation.z = b.leftShoulderRotZ;
    if (rightShoulder) rightShoulder.rotation.z = b.rightShoulderRotZ;
    if (leftUpperArm) {
      leftUpperArm.rotation.x = b.leftUpperArmRotX;
      leftUpperArm.rotation.z = b.leftUpperArmRotZ;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.x = b.rightUpperArmRotX;
      rightUpperArm.rotation.z = b.rightUpperArmRotZ;
    }
    if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLegRotZ;
    if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLegRotZ;

    // ── Шаг 2: дыхание (absolute = base + delta) ──
    if (cfg.breathing) {
      const breath = Math.sin(animState.current.breathPhase);
      if (spine) {
        spine.rotation.x = b.spineRotX + breath * 0.025;
        spine.rotation.z = b.spineRotZ + Math.sin(animState.current.breathPhase * 0.5) * 0.008;
      }
      if (leftShoulder) leftShoulder.rotation.z = b.leftShoulderRotZ + breath * 0.015;
      if (rightShoulder) rightShoulder.rotation.z = b.rightShoulderRotZ - breath * 0.015;
    }

    // ── Шаг 3: покачивание телом (absolute) ──
    if (cfg.bodySway) {
      const sway = Math.sin(animState.current.swayPhase);
      if (hips) {
        hips.rotation.y = b.hipsRotY + sway * 0.04;
        hips.rotation.z = b.hipsRotZ + Math.sin(animState.current.swayPhase * 0.7) * 0.015;
      }
      if (spine) {
        spine.rotation.y = b.spineRotY + Math.sin(animState.current.swayPhase + Math.PI) * 0.02;
      }
    }

    // ── Шаг 4: перенос веса (absolute) ──
    if (cfg.weightShift) {
      const shift = Math.sin(animState.current.weightPhase);
      if (hips) hips.position.x = b.hipsPosX + shift * 0.025;
      if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLegRotZ + shift * 0.02;
      if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLegRotZ + shift * 0.02;
    }

    // ── Шаг 5: микро-движения рук (absolute) ──
    if (cfg.armSway) {
      const armSway1 = Math.sin(animState.current.armPhase) * 0.04;
      const armSway2 = Math.sin(animState.current.armPhase + Math.PI) * 0.04;
      if (leftUpperArm) {
        leftUpperArm.rotation.z = b.leftUpperArmRotZ + armSway1;
        leftUpperArm.rotation.x = b.leftUpperArmRotX + Math.sin(animState.current.armPhase * 0.7) * 0.02;
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.z = b.rightUpperArmRotZ + armSway2;
        rightUpperArm.rotation.x = b.rightUpperArmRotX + Math.sin(animState.current.armPhase * 0.7 + Math.PI) * 0.02;
      }
    }

    // ── Шаг 6: эмоциональная поза (absolute = base + delta) ──
    // Все вычисления — относительно базы, никаких +=.
    if (cfg.emotionPose) {
      // Joy — лёгкое подпрыгивание
      if (emotion.joy > 0.6 && hips) {
        const bounce = Math.sin(t * 2.5) * 0.015 * (emotion.joy - 0.5);
        hips.position.y = b.hipsPosY + bounce;
      }
      // Sadness — плечи вперёд, голова вниз
      if (emotion.sadness > 0.4) {
        const intensity = (emotion.sadness - 0.3) * 0.5;
        if (spine) spine.rotation.x = b.spineRotX + intensity * 0.08;
        if (head) head.rotation.x = b.headRotX + intensity * 0.1;
        if (leftShoulder) leftShoulder.rotation.z = b.leftShoulderRotZ + intensity * 0.05;
        if (rightShoulder) rightShoulder.rotation.z = b.rightShoulderRotZ - intensity * 0.05;
      }
      // Irritation — подбородок вверх, руки ближе к корпусу
      if (emotion.irritation > 0.4) {
        const intensity = (emotion.irritation - 0.3) * 0.5;
        if (head) head.rotation.x = b.headRotX - intensity * 0.06;
        if (leftUpperArm) leftUpperArm.rotation.z = b.leftUpperArmRotZ + intensity * 0.04;
        if (rightUpperArm) rightUpperArm.rotation.z = b.rightUpperArmRotZ - intensity * 0.04;
      }
      // Curiosity — наклон головы вбок
      if (emotion.curiosity > 0.6 && head) {
        const intensity = (emotion.curiosity - 0.5) * 0.3;
        head.rotation.z = b.headRotZ + Math.sin(t * 0.4) * intensity * 0.08;
      }
      // Calm — расслабленные плечи
      if (emotion.calm > 0.6) {
        const intensity = (emotion.calm - 0.5) * 0.2;
        if (leftShoulder) leftShoulder.rotation.z = b.leftShoulderRotZ - intensity * 0.03;
        if (rightShoulder) rightShoulder.rotation.z = b.rightShoulderRotZ + intensity * 0.03;
      }
    }

    // ── Шаг 7: покачивание головой + gaze follow (absolute) ──
    if (cfg.headSway && head) {
      const headY = Math.sin(animState.current.headPhase) * 0.08;
      const headX = Math.sin(animState.current.headPhase * 0.6) * 0.03;
      head.rotation.y = b.headRotY + headY;
      head.rotation.x = b.headRotX + headX;
    }
    if (cfg.gazeFollow && head) {
      if (mouseRef.current.hasMouse) {
        animState.current.targetGazeX = mouseRef.current.x * 0.15;
        animState.current.targetGazeY = mouseRef.current.y * 0.10;
      } else {
        animState.current.targetGazeX = 0;
        animState.current.targetGazeY = 0;
      }
      animState.current.gazeX = THREE.MathUtils.lerp(animState.current.gazeX, animState.current.targetGazeX, 0.05);
      animState.current.gazeY = THREE.MathUtils.lerp(animState.current.gazeY, animState.current.targetGazeY, 0.05);
      head.rotation.y += animState.current.gazeX;
      head.rotation.x += animState.current.gazeY;
    }

    // ── Шаг 8: моргание ──
    if (cfg.blinking) {
      animState.current.blinkTimer -= delta;
      if (!animState.current.isBlinking && animState.current.blinkTimer < 0) {
        animState.current.isBlinking = true;
        animState.current.blinkPhase = 0;
        const isDouble = Math.random() < 0.15;
        animState.current.blinkDuration = isDouble ? 0.35 : 0.15;
      }
      if (animState.current.isBlinking) {
        animState.current.blinkPhase += delta / animState.current.blinkDuration;
        if (animState.current.blinkPhase >= 1) {
          animState.current.isBlinking = false;
          animState.current.blinkTimer = 2 + Math.random() * 4;
          setExpr(vrm, 'blink', 0);
        } else {
          let v;
          if (animState.current.blinkDuration > 0.25) {
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

    // ── Шаг 9: эмоции (blendshapes) ──
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

    // ── Шаг 10: липсинк ──
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

function setExpr(vrm: VRM, name: VRMExpressionPresetName | string, value: number) {
  if (!vrm.expressionManager) return;
  try {
    vrm.expressionManager.setValue(name as VRMExpressionPresetName, Math.max(0, Math.min(1, value)));
  } catch { /* skip */ }
}

function emotionToBlendshapes(e: EmotionVector): Record<string, number> {
  return {
    happy:     Math.max(0, e.joy - 0.4) * 1.0,
    angry:     Math.max(0, e.irritation - 0.35) * 1.2,
    sad:       Math.max(0, e.sadness - 0.3) * 1.1,
    relaxed:   Math.max(0, e.calm - 0.5) * 0.7,
    surprised: 0,
    aa: 0,
  };
}
