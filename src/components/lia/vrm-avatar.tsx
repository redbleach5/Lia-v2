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
  CAMERA_PRESETS,
  type AvatarConfig,
  type PlatformShape,
  type RingAnimation,
  type ArmPose,
} from '@/lib/avatar-config';

export type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string;
  config?: AvatarConfig;
};

const DEFAULT_VRM_SRC = '/models/Lia.vrm';

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
// Arm pose presets → quaternions.
//
// Используем THREE.Quaternion.setFromEuler для каждого сустава, чтобы избежать
// проблем с порядком Euler XYZ (который в VRM normalized bones даёт непредсказуемые
// результаты при комбинировании X+Y+Z вращений). Quaternion — однозначное
// представление旋转, порядок не важен.
//
// Все углы подобраны визуально на модели Lia.vrm (высота 1.666m).
// ============================================================================
export const ARM_POSE_QUATERNIONS: Record<ArmPose, {
  leftUpperArm: [number, number, number];   // Euler XYZ в радианах
  rightUpperArm: [number, number, number];
  leftLowerArm: [number, number, number];
  rightLowerArm: [number, number, number];
  leftHand: [number, number, number];
  rightHand: [number, number, number];
}> = {
  // Естественная поза — руки опущены вдоль тела.
  // X=0.05 — лёгкий наклон вперёд, Z=-1.35 — опустить вдоль тела.
  natural: {
    leftUpperArm:  [0.05, 0, -1.35],
    rightUpperArm: [0.05, 0, 1.35],
    leftLowerArm:  [-0.25, 0, 0],
    rightLowerArm: [-0.25, 0, 0],
    leftHand:  [0, 0, 0.15],
    rightHand: [0, 0, -0.15],
  },
  // Расслабленная — локти согнуты больше, кисти ближе к бёдрам.
  relaxed: {
    leftUpperArm:  [0.10, 0, -1.15],
    rightUpperArm: [0.10, 0, 1.15],
    leftLowerArm:  [-0.55, 0.05, 0],
    rightLowerArm: [-0.55, -0.05, 0],
    leftHand:  [0, 0, 0.20],
    rightHand: [0, 0, -0.20],
  },
  // T-pose — руки строго в стороны.
  't-pose': {
    leftUpperArm:  [0, 0, 0],
    rightUpperArm: [0, 0, 0],
    leftLowerArm:  [0, 0, 0],
    rightLowerArm: [0, 0, 0],
    leftHand:  [0, 0, 0],
    rightHand: [0, 0, 0],
  },
  // Скрещённые на груди.
  // Анатомия VRM 1.0 (проверено визуально итеративно):
  //   upperArm.X ≈ +1.3 → поднимает руку вперёд к горизонтали
  //   upperArm.Z ≈ ∓0.4 → прижимает плечевую кость к корпусу
  //   lowerArm.X ≈ -1.6 → сгибает локоть (negative = кисть к плечу)
  //   lowerArm.Z ≈ ±0.6 → отводит кисть внутрь (к противоположному плечу)
  crossed: {
    leftUpperArm:  [1.30, 0, -0.40],
    rightUpperArm: [1.30, 0, 0.40],
    leftLowerArm:  [-1.60, 0, 0.60],
    rightLowerArm: [-1.60, 0, -0.60],
    leftHand:  [0, 0, 0],
    rightHand: [0, 0, 0],
  },
  // Руки в карманах — слегка согнуты, кисти у бёдер.
  'hands-pockets': {
    leftUpperArm:  [0.20, 0, -0.95],
    rightUpperArm: [0.20, 0, 0.95],
    leftLowerArm:  [-0.85, 0.15, 0],
    rightLowerArm: [-0.85, -0.15, 0],
    leftHand:  [0, 0, 0.30],
    rightHand: [0, 0, -0.30],
  },
};

// Helper: Euler XYZ → quaternion array [x, y, z, w]
function eulerToQuat(x: number, y: number, z: number): [number, number, number, number] {
  const e = new THREE.Euler(x, y, z, 'XYZ');
  const q = new THREE.Quaternion().setFromEuler(e);
  return [q.x, q.y, q.z, q.w];
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
// BoneBases — все базовые rotations/positions для костей, которые мы модифицируем.
// Храним как Euler angles (THREE.Euler), потому что применяем позу через
// bone.rotation.set() и сбрасываем через rotation.copy(). Это согласованный
// подход — нет конфликта между quaternion и Euler.
// ============================================================================
type BoneBases = {
  hips: { posX: number; posY: number; rotX: number; rotY: number; rotZ: number };
  spine: { rotX: number; rotY: number; rotZ: number };
  head: { rotX: number; rotY: number; rotZ: number };
  leftShoulder: { rotZ: number };
  rightShoulder: { rotZ: number };
  leftUpperArm: { rotX: number; rotY: number; rotZ: number };
  rightUpperArm: { rotX: number; rotY: number; rotZ: number };
  leftLowerArm: { rotX: number; rotY: number; rotZ: number };
  rightLowerArm: { rotX: number; rotY: number; rotZ: number };
  leftUpperLeg: { rotZ: number };
  rightUpperLeg: { rotZ: number };
};

function createEmptyBases(): BoneBases {
  return {
    hips: { posX: 0, posY: 0, rotX: 0, rotY: 0, rotZ: 0 },
    spine: { rotX: 0, rotY: 0, rotZ: 0 },
    head: { rotX: 0, rotY: 0, rotZ: 0 },
    leftShoulder: { rotZ: 0 },
    rightShoulder: { rotZ: 0 },
    leftUpperArm: { rotX: 0, rotY: 0, rotZ: 0 },
    rightUpperArm: { rotX: 0, rotY: 0, rotZ: 0 },
    leftLowerArm: { rotX: 0, rotY: 0, rotZ: 0 },
    rightLowerArm: { rotX: 0, rotY: 0, rotZ: 0 },
    leftUpperLeg: { rotZ: 0 },
    rightUpperLeg: { rotZ: 0 },
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

        // ── Применяем позу рук напрямую через bone.rotation (Euler) ──
        // Используем прямой доступ к bone.rotation вместо setNormalizedPose,
        // потому что setNormalizedPose устанавливает quaternion, но vrm.update()
        // в useFrame может его перезаписать. Прямой доступ к rotation надёжнее.
        const poseQuat = ARM_POSE_QUATERNIONS[config.body.armPose];
        if (vrm.humanoid) {
          const setBoneRot = (name: string, euler: [number, number, number]) => {
            const node = vrm.humanoid!.getNormalizedBoneNode(name as never);
            if (node) {
              node.rotation.set(euler[0], euler[1], euler[2]);
            }
          };
          setBoneRot('leftUpperArm', poseQuat.leftUpperArm);
          setBoneRot('rightUpperArm', poseQuat.rightUpperArm);
          setBoneRot('leftLowerArm', poseQuat.leftLowerArm);
          setBoneRot('rightLowerArm', poseQuat.rightLowerArm);
          setBoneRot('leftHand', poseQuat.leftHand);
          setBoneRot('rightHand', poseQuat.rightHand);
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

        // ── Сохраняем базы ВСЕХ костей как Euler angles ──
        // Сохраняем ПОСЛЕ применения позы, чтобы базы включали выбранную позу рук.
        // Сброс в useFrame делаем через rotation.set() — точно восстанавливает позу.
        if (vrm.humanoid) {
          const getBone = (name: string) => vrm.humanoid!.getNormalizedBoneNode(name as never);
          const hips = getBone('hips');
          const spine = getBone('spine');
          const head = getBone('head');
          const leftShoulder = getBone('leftShoulder');
          const rightShoulder = getBone('rightShoulder');
          const leftUpperArm = getBone('leftUpperArm');
          const rightUpperArm = getBone('rightUpperArm');
          const leftLowerArm = getBone('leftLowerArm');
          const rightLowerArm = getBone('rightLowerArm');
          const leftUpperLeg = getBone('leftUpperLeg');
          const rightUpperLeg = getBone('rightUpperLeg');

          const b = basesRef.current;
          if (hips) {
            b.hips.posX = hips.position.x;
            b.hips.posY = hips.position.y;
            b.hips.rotX = hips.rotation.x;
            b.hips.rotY = hips.rotation.y;
            b.hips.rotZ = hips.rotation.z;
          }
          if (spine) { b.spine.rotX = spine.rotation.x; b.spine.rotY = spine.rotation.y; b.spine.rotZ = spine.rotation.z; }
          if (head) { b.head.rotX = head.rotation.x; b.head.rotY = head.rotation.y; b.head.rotZ = head.rotation.z; }
          if (leftShoulder) b.leftShoulder.rotZ = leftShoulder.rotation.z;
          if (rightShoulder) b.rightShoulder.rotZ = rightShoulder.rotation.z;
          if (leftUpperArm) { b.leftUpperArm.rotX = leftUpperArm.rotation.x; b.leftUpperArm.rotY = leftUpperArm.rotation.y; b.leftUpperArm.rotZ = leftUpperArm.rotation.z; }
          if (rightUpperArm) { b.rightUpperArm.rotX = rightUpperArm.rotation.x; b.rightUpperArm.rotY = rightUpperArm.rotation.y; b.rightUpperArm.rotZ = rightUpperArm.rotation.z; }
          if (leftLowerArm) { b.leftLowerArm.rotX = leftLowerArm.rotation.x; b.leftLowerArm.rotY = leftLowerArm.rotation.y; b.leftLowerArm.rotZ = leftLowerArm.rotation.z; }
          if (rightLowerArm) { b.rightLowerArm.rotX = rightLowerArm.rotation.x; b.rightLowerArm.rotY = rightLowerArm.rotation.y; b.rightLowerArm.rotZ = rightLowerArm.rotation.z; }
          if (leftUpperLeg) b.leftUpperLeg.rotZ = leftUpperLeg.rotation.z;
          if (rightUpperLeg) b.rightUpperLeg.rotZ = rightUpperLeg.rotation.z;

          console.log('[VRM] pose applied, bases captured:', {
            armPose: config.body.armPose,
            leftUpperArmRotX: b.leftUpperArm.rotX.toFixed(3),
            leftUpperArmRotY: b.leftUpperArm.rotY.toFixed(3),
            leftUpperArmRotZ: b.leftUpperArm.rotZ.toFixed(3),
            leftLowerArmRotX: b.leftLowerArm.rotX.toFixed(3),
            leftLowerArmRotZ: b.leftLowerArm.rotZ.toFixed(3),
            hipsPosY: b.hips.posY.toFixed(3),
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
    current: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 } as Record<string, number>,
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
    const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm' as never);
    const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm' as never);
    const leftUpperLeg = humanoid.getNormalizedBoneNode('leftUpperLeg' as never);
    const rightUpperLeg = humanoid.getNormalizedBoneNode('rightUpperLeg' as never);

    // ── Шаг 1: сброс ВСЕХ модифицируемых костей к базе (Euler) ──
    // Используем rotation.set() / прямое присвоение — точно восстанавливает позу.
    if (hips) {
      hips.position.x = b.hips.posX;
      hips.position.y = b.hips.posY;
      hips.rotation.x = b.hips.rotX;
      hips.rotation.y = b.hips.rotY;
      hips.rotation.z = b.hips.rotZ;
    }
    if (spine) { spine.rotation.x = b.spine.rotX; spine.rotation.y = b.spine.rotY; spine.rotation.z = b.spine.rotZ; }
    if (head) { head.rotation.x = b.head.rotX; head.rotation.y = b.head.rotY; head.rotation.z = b.head.rotZ; }
    if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ;
    if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ;
    if (leftUpperArm) { leftUpperArm.rotation.x = b.leftUpperArm.rotX; leftUpperArm.rotation.y = b.leftUpperArm.rotY; leftUpperArm.rotation.z = b.leftUpperArm.rotZ; }
    if (rightUpperArm) { rightUpperArm.rotation.x = b.rightUpperArm.rotX; rightUpperArm.rotation.y = b.rightUpperArm.rotY; rightUpperArm.rotation.z = b.rightUpperArm.rotZ; }
    if (leftLowerArm) { leftLowerArm.rotation.x = b.leftLowerArm.rotX; leftLowerArm.rotation.y = b.leftLowerArm.rotY; leftLowerArm.rotation.z = b.leftLowerArm.rotZ; }
    if (rightLowerArm) { rightLowerArm.rotation.x = b.rightLowerArm.rotX; rightLowerArm.rotation.y = b.rightLowerArm.rotY; rightLowerArm.rotation.z = b.rightLowerArm.rotZ; }
    if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLeg.rotZ;
    if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLeg.rotZ;

    // ── Шаг 2: дыхание (absolute = base + delta) ──
    if (cfg.breathing) {
      const breath = Math.sin(animState.current.breathPhase);
      if (spine) {
        spine.rotation.x = b.spine.rotX + breath * 0.025;
        spine.rotation.z = b.spine.rotZ + Math.sin(animState.current.breathPhase * 0.5) * 0.008;
      }
      if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ + breath * 0.015;
      if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ - breath * 0.015;
    }

    // ── Шаг 3: покачивание телом (absolute) ──
    if (cfg.bodySway) {
      const sway = Math.sin(animState.current.swayPhase);
      if (hips) {
        hips.rotation.y = b.hips.rotY + sway * 0.04;
        hips.rotation.z = b.hips.rotZ + Math.sin(animState.current.swayPhase * 0.7) * 0.015;
      }
      if (spine) spine.rotation.y = b.spine.rotY + Math.sin(animState.current.swayPhase + Math.PI) * 0.02;
    }

    // ── Шаг 4: перенос веса (absolute) ──
    if (cfg.weightShift) {
      const shift = Math.sin(animState.current.weightPhase);
      if (hips) hips.position.x = b.hips.posX + shift * 0.025;
      if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLeg.rotZ + shift * 0.02;
      if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLeg.rotZ + shift * 0.02;
    }

    // ── Шаг 5: микро-движения рук (absolute = base + delta) ──
    if (cfg.armSway) {
      const armSway1 = Math.sin(animState.current.armPhase) * 0.04;
      const armSway2 = Math.sin(animState.current.armPhase + Math.PI) * 0.04;
      if (leftUpperArm) {
        leftUpperArm.rotation.z = b.leftUpperArm.rotZ + armSway1;
        leftUpperArm.rotation.x = b.leftUpperArm.rotX + Math.sin(animState.current.armPhase * 0.7) * 0.02;
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.z = b.rightUpperArm.rotZ + armSway2;
        rightUpperArm.rotation.x = b.rightUpperArm.rotX + Math.sin(animState.current.armPhase * 0.7 + Math.PI) * 0.02;
      }
      if (leftLowerArm) leftLowerArm.rotation.x = b.leftLowerArm.rotX + Math.sin(animState.current.armPhase * 0.5) * 0.015;
      if (rightLowerArm) rightLowerArm.rotation.x = b.rightLowerArm.rotX + Math.sin(animState.current.armPhase * 0.5 + Math.PI) * 0.015;
    }

    // ── Шаг 6: эмоциональная поза (absolute = base + delta) ──
    if (cfg.emotionPose) {
      // Joy — лёгкое подпрыгивание
      if (emotion.joy > 0.6 && hips) {
        const bounce = Math.sin(t * 2.5) * 0.015 * (emotion.joy - 0.5);
        hips.position.y = b.hips.posY + bounce;
      }
      // Sadness — плечи вперёд, голова вниз
      if (emotion.sadness > 0.4) {
        const intensity = (emotion.sadness - 0.3) * 0.5;
        if (spine) spine.rotation.x = b.spine.rotX + intensity * 0.08;
        if (head) head.rotation.x = b.head.rotX + intensity * 0.1;
        if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ + intensity * 0.05;
        if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ - intensity * 0.05;
      }
      // Irritation — подбородок вверх, руки ближе к корпусу
      if (emotion.irritation > 0.4) {
        const intensity = (emotion.irritation - 0.3) * 0.5;
        if (head) head.rotation.x = b.head.rotX - intensity * 0.06;
        if (leftUpperArm) leftUpperArm.rotation.z = b.leftUpperArm.rotZ + intensity * 0.04;
        if (rightUpperArm) rightUpperArm.rotation.z = b.rightUpperArm.rotZ - intensity * 0.04;
      }
      // Curiosity — наклон головы вбок
      if (emotion.curiosity > 0.6 && head) {
        const intensity = (emotion.curiosity - 0.5) * 0.3;
        head.rotation.z = b.head.rotZ + Math.sin(t * 0.4) * intensity * 0.08;
      }
      // Calm — расслабленные плечи
      if (emotion.calm > 0.6) {
        const intensity = (emotion.calm - 0.5) * 0.2;
        if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ - intensity * 0.03;
        if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ + intensity * 0.03;
      }
    }

    // ── Шаг 7: покачивание головой + gaze follow (absolute) ──
    if (cfg.headSway && head) {
      head.rotation.y = b.head.rotY + Math.sin(animState.current.headPhase) * 0.08;
      head.rotation.x = b.head.rotX + Math.sin(animState.current.headPhase * 0.6) * 0.03;
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
