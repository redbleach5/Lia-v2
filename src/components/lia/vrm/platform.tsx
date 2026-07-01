'use client';

// ============================================================================
// Platform — 3D-платформа под аватаром (4 формы + 4 анимации кольца + halo + shadow).
// ============================================================================

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AvatarConfig, PlatformShape } from '@/lib/avatar-config';

export function Platform({
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
