'use client';

import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMExpressionPresetName } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import type { EmotionVector } from '@/lib/personality';

export type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
  src?: string;
};

const DEFAULT_VRM_SRC = '/models/sample.vrm';

export function VrmAvatar({ emotion, speaking = false, size = 280, src = DEFAULT_VRM_SRC }: VrmAvatarProps) {
  return (
    <div style={{ width: size, height: size }} className="relative">
      <Canvas
        camera={{ position: [0, 1.4, 0.9], fov: 35 }}
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
  return (
    <>
      <ambientLight intensity={0.9} color="#ffffff" />
      <directionalLight position={[1, 3, 2]} intensity={1.0} color="#fff5e8" />
      <directionalLight position={[-1, 2, 1]} intensity={0.3} color="#e8d5c0" />

      <VrmModel emotion={emotion} speaking={speaking} src={src} />

      {/* Платформа */}
      <mesh position={[0, 0.005, 0]}>
        <cylinderGeometry args={[0.4, 0.45, 0.03, 48]} />
        <meshStandardMaterial color="#c9a886" transparent opacity={0.3} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <torusGeometry args={[0.42, 0.004, 8, 48]} />
        <meshStandardMaterial color="#8b6f47" transparent opacity={0.4} />
      </mesh>

      <OrbitControls
        target={[0, 1.25, 0]}
        enablePan={false}
        enableZoom={true}
        minDistance={0.6}
        maxDistance={1.5}
        minPolarAngle={Math.PI / 4}
        maxPolarAngle={Math.PI / 2}
        minAzimuthAngle={-Math.PI / 5}
        maxAzimuthAngle={Math.PI / 5}
      />
    </>
  );
}

function VrmModel({ emotion, speaking, src }: { emotion: EmotionVector; speaking: boolean; src: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      src,
      (gltf) => {
        if (cancelled) return;
        const vrm = (gltf as any).userData.vrm as VRM | undefined;
        if (!vrm) {
          console.error('[VRM] No VRM in gltf');
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        vrm.scene.rotation.y = Math.PI;

        // Pose arms down — fix T-pose
        if (vrm.humanoid) {
          const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
          const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
          if (leftUpperArm) leftUpperArm.rotation.z = -0.6;
          if (rightUpperArm) rightUpperArm.rotation.z = 0.6;

          const leftLowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
          const rightLowerArm = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
          if (leftLowerArm) leftLowerArm.rotation.z = -0.3;
          if (rightLowerArm) rightLowerArm.rotation.z = 0.3;
        }

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

    // Breath
    if (vrm.humanoid) {
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      if (spine) spine.rotation.x = Math.sin(t * 0.8) * 0.02;

      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        head.rotation.y = Math.sin(t * 0.3) * 0.05;
        head.rotation.x = Math.sin(t * 0.2) * 0.02;
      }
    }

    // Blink
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

    // Emotions
    const target = emotionToBlendshapes(emotion);
    const lerp = 1 - Math.pow(0.001, delta);
    for (const key of Object.keys(target) as Array<keyof typeof target>) {
      const cur = animState.current.current[key] as number;
      const tgt = target[key];
      animState.current.current[key] = cur + (tgt - cur) * lerp;
      setExpr(vrm, key as VRMExpressionPresetName, animState.current.current[key]);
    }

    // Lip sync
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
