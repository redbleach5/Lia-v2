'use client';

// ============================================================================
// VrmAvatar — 3D VRM-аватар с эмоциями, дыханием, морганием, lip-sync.
// ============================================================================
//
// Главный компонент. Содержит:
//   - VrmAvatar (thin wrapper: Canvas + BackgroundLayer + Scene)
//   - Scene (lights + VrmModel + Platform + OrbitControls)
//   - VrmModel (загрузка VRM + useFrame animation loop)
//
// Вынесено в подмодули vrm/:
//   - vrm/constants.ts   — EMOTION_COLORS, ARM_POSE_QUATERNIONS, BoneBases, eulerToQuat
//   - vrm/background.tsx — BackgroundLayer
//   - vrm/platform.tsx   — Platform + PlatformGeometry
//   - vrm/blendshapes.ts — setExpr, emotionToBlendshapes
//
// VrmModel остаётся здесь, потому что useFrame animation loop тесно связан
// с refs (vrmRef, basesRef, animState) и не может быть легко вынесен без
// проброса всех refs через props.

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMExpressionPresetName } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useEffect, useRef, useState, Suspense } from 'react';
import type { EmotionVector } from '@/lib/personality';
import { dominantEmotion } from '@/lib/emotion';
import {
  DEFAULT_AVATAR_CONFIG,
  LIGHTING_PRESETS,
  CAMERA_PRESETS,
  type AvatarConfig,
} from '@/lib/avatar-config';
import {
  DEFAULT_VRM_SRC,
  EMOTION_COLORS,
  ARM_POSE_QUATERNIONS,
  createEmptyBases,
  type BoneBases,
} from './vrm/constants';
import { BackgroundLayer } from './vrm/background';
import { Platform } from './vrm/platform';
import { setExpr, emotionToBlendshapes } from './vrm/blendshapes';

export type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string;
  config?: AvatarConfig;
  /** Вызывается когда VRM не удалось загрузить (файл отсутствует/битый).
   *  Родитель может переключиться на Live2D fallback. */
  onLoadError?: () => void;
};

export function VrmAvatar({
  emotion,
  speaking = false,
  size = 280,
  src = DEFAULT_VRM_SRC,
  config = DEFAULT_AVATAR_CONFIG,
  onLoadError,
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
            onLoadError={onLoadError}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

// ============================================================================
// Scene — lights + VrmModel + Platform + OrbitControls
// ============================================================================
function Scene({
  emotion,
  speaking,
  src,
  config,
  cameraTarget,
  onLoadError,
}: {
  emotion: EmotionVector;
  speaking: boolean;
  src: string;
  config: AvatarConfig;
  cameraTarget: [number, number, number];
  onLoadError?: () => void;
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

      <VrmModel emotion={emotion} speaking={speaking} src={src} config={config} onLoadError={onLoadError} />

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
// VrmModel — загрузка VRM + все idle-анимации
// ============================================================================
function VrmModel({
  emotion,
  speaking,
  src,
  config,
  onLoadError,
}: {
  emotion: EmotionVector;
  speaking: boolean;
  src: string;
  config: AvatarConfig;
  onLoadError?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const basesRef = useRef<BoneBases>(createEmptyBases());
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const onLoadErrorCalledRef = useRef(false);

  // ── Загрузка VRM + применение позы + сохранение баз ──
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadFailed(false);
    onLoadErrorCalledRef.current = false;

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
          if (!onLoadErrorCalledRef.current) {
            onLoadErrorCalledRef.current = true;
            onLoadError?.();
          }
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        vrm.scene.rotation.y = 0;

        if (vrm.expressionManager) {
          vrm.expressionManager.resetValues();
        }

        // ── Применяем позу рук напрямую через bone.rotation (Euler) ──
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
        }

        setLoaded(true);
      },
      undefined,
      (err) => {
        if (cancelled) return;
        console.error('[VRM] load failed:', err);
        setLoadFailed(true);
        if (!onLoadErrorCalledRef.current) {
          onLoadErrorCalledRef.current = true;
          onLoadError?.();
        }
      },
    );

    return () => { cancelled = true; };
  }, [src, config.body.armPose, config.body.scale, config.body.yOffset, onLoadError]);

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

    // ── Шаг 2: дыхание ──
    if (cfg.breathing) {
      const breath = Math.sin(animState.current.breathPhase);
      if (spine) {
        spine.rotation.x = b.spine.rotX + breath * 0.025;
        spine.rotation.z = b.spine.rotZ + Math.sin(animState.current.breathPhase * 0.5) * 0.008;
      }
      if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ + breath * 0.015;
      if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ - breath * 0.015;
    }

    // ── Шаг 3: покачивание телом ──
    if (cfg.bodySway) {
      const sway = Math.sin(animState.current.swayPhase);
      if (hips) {
        hips.rotation.y = b.hips.rotY + sway * 0.04;
        hips.rotation.z = b.hips.rotZ + Math.sin(animState.current.swayPhase * 0.7) * 0.015;
      }
      if (spine) spine.rotation.y = b.spine.rotY + Math.sin(animState.current.swayPhase + Math.PI) * 0.02;
    }

    // ── Шаг 4: перенос веса ──
    if (cfg.weightShift) {
      const shift = Math.sin(animState.current.weightPhase);
      if (hips) hips.position.x = b.hips.posX + shift * 0.025;
      if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLeg.rotZ + shift * 0.02;
      if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLeg.rotZ + shift * 0.02;
    }

    // ── Шаг 5: микро-движения рук ──
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

    // ── Шаг 6: эмоциональная поза ──
    if (cfg.emotionPose) {
      if (emotion.joy > 0.6 && hips) {
        const bounce = Math.sin(t * 2.5) * 0.015 * (emotion.joy - 0.5);
        hips.position.y = b.hips.posY + bounce;
      }
      if (emotion.sadness > 0.4) {
        const intensity = (emotion.sadness - 0.3) * 0.5;
        if (spine) spine.rotation.x = b.spine.rotX + intensity * 0.08;
        if (head) head.rotation.x = b.head.rotX + intensity * 0.1;
        if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ + intensity * 0.05;
        if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ - intensity * 0.05;
      }
      if (emotion.irritation > 0.4) {
        const intensity = (emotion.irritation - 0.3) * 0.5;
        if (head) head.rotation.x = b.head.rotX - intensity * 0.06;
        if (leftUpperArm) leftUpperArm.rotation.z = b.leftUpperArm.rotZ + intensity * 0.04;
        if (rightUpperArm) rightUpperArm.rotation.z = b.rightUpperArm.rotZ - intensity * 0.04;
      }
      if (emotion.curiosity > 0.6 && head) {
        const intensity = (emotion.curiosity - 0.5) * 0.3;
        head.rotation.z = b.head.rotZ + Math.sin(t * 0.4) * intensity * 0.08;
      }
      if (emotion.calm > 0.6) {
        const intensity = (emotion.calm - 0.5) * 0.2;
        if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ - intensity * 0.03;
        if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ + intensity * 0.03;
      }
    }

    // ── Шаг 7: покачивание головой + gaze follow ──
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

    try {
      vrm.update(delta);
    } catch (e) {
      console.error('[VRM] vrm.update() failed:', e);
    }
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
