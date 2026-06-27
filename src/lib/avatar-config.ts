// AvatarConfig — конфигурация внешнего вида и поведения VRM-аватара.
//
// Хранится в DB как JSON-строка в Setting.avatar_config.
// Загружается через /api/settings GET, сохраняется через POST.
// Используется в VrmAvatar (3D) и частично в Live2DAvatar (2D fallback).

// ============================================================================
// Камера — где находится и куда смотрит
// ============================================================================
export type CameraPreset = 'portrait' | 'fullbody' | 'closeup' | 'custom';

export type AvatarCameraConfig = {
  preset: CameraPreset;
  // Если preset === 'custom' — используются эти значения
  position: [number, number, number];   // [x, y, z] — позиция камеры
  target: [number, number, number];     // [x, y, z] — куда смотрит
  fov: number;                          // угол обзора в градусах (20-70)
};

// ============================================================================
// Платформа — диск под аватаром, индикатор эмоции
// ============================================================================
export type PlatformStyle = 'classic' | 'minimal' | 'glow' | 'off';

export type AvatarPlatformConfig = {
  style: PlatformStyle;
  radius: number;          // 0.30 - 0.60 — радиус диска
  showInnerRing: boolean;  // внутреннее светящееся кольцо
  showHalo: boolean;       // мягкое свечение на полу вокруг платформы
  pulse: boolean;          // пульсация в такт интенсивности эмоции
  opacity: number;         // 0.4 - 1.0 — непрозрачность диска
};

// ============================================================================
// Фон — что за аватаром
// ============================================================================
export type BackgroundStyle = 'transparent' | 'gradient' | 'solid' | 'radial';

export type AvatarBackgroundConfig = {
  style: BackgroundStyle;
  // Для 'solid' — заливка одним цветом
  // Для 'gradient' — радиальный градиент от center к edge
  // Для 'radial' — мягкое свечение от центра
  color: string;       // hex, например '#fafafa' или 'transparent'
  edgeColor: string;   // hex — для gradient/radial
};

// ============================================================================
// Освещение — тёплое / холодное / нейтральное
// ============================================================================
export type LightingPreset = 'warm' | 'cool' | 'neutral' | 'soft' | 'dramatic';

export type AvatarLightingConfig = {
  preset: LightingPreset;
  intensity: number;     // 0.5 - 1.5 — общая яркость
};

// ============================================================================
// Анимации — что включено
// ============================================================================
export type AvatarAnimationConfig = {
  breathing: boolean;     // дыхание (движение спины)
  blinking: boolean;      // моргание
  headSway: boolean;      // лёгкое покачивание головой
  lipSync: boolean;       // липсинк во время стриминга ответа
  emotionMorph: boolean;  // плавная интерполяция эмоций (happy/sad/angry/...)
};

// ============================================================================
// Тело — поза и пропорции
// ============================================================================
export type ArmPose = 'natural' | 'relaxed' | 't-pose' | 'crossed' | 'hands-pockets';

export type AvatarBodyConfig = {
  armPose: ArmPose;
  scale: number;          // 0.85 - 1.15 — масштаб модели
  yOffset: number;        // -0.1 - 0.1 — вертикальное смещение (для центрирования на платформе)
};

// ============================================================================
// Полный конфиг
// ============================================================================
export type AvatarConfig = {
  camera: AvatarCameraConfig;
  platform: AvatarPlatformConfig;
  background: AvatarBackgroundConfig;
  lighting: AvatarLightingConfig;
  animation: AvatarAnimationConfig;
  body: AvatarBodyConfig;
};

// ============================================================================
// Пресеты камеры — дефолты для удобного выбора в настройках
// ============================================================================
export const CAMERA_PRESETS: Record<Exclude<CameraPreset, 'custom'>, Omit<AvatarCameraConfig, 'preset'>> = {
  // Голова и плечи — крупный план по грудь.
  // Камера на высоте груди, смотрит горизонтально, FOV 30°.
  portrait: {
    position: [0, 1.45, 0.95],
    target:   [0, 1.40, 0],
    fov: 30,
  },
  // В полный рост — видна вся модель от макушки до стоп + платформа под ней.
  // Габариты sample.vrm: высота 1.58m. Платформа на Y=0, центр модели ≈Y=0.85.
  // При FOV 38° (tan(19°)=0.344): чтобы видеть ~2.0m по вертикали,
  // нужно расстояние d = 2.0 / (2*0.344) ≈ 2.9m.
  fullbody: {
    position: [0, 0.95, 2.9],
    target:   [0, 0.85, 0],
    fov: 38,
  },
  // Крупно лицо — для интимной беседы.
  closeup: {
    position: [0, 1.50, 0.65],
    target:   [0, 1.48, 0],
    fov: 25,
  },
};

// ============================================================================
// Значения по умолчанию — подобраны под тему «тёплый лён»
// ============================================================================
export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  camera: {
    preset: 'fullbody',
    position: CAMERA_PRESETS.fullbody.position,
    target: CAMERA_PRESETS.fullbody.target,
    fov: CAMERA_PRESETS.fullbody.fov,
  },
  platform: {
    style: 'classic',
    radius: 0.42,
    showInnerRing: true,
    showHalo: true,
    pulse: true,
    opacity: 0.85,
  },
  background: {
    style: 'radial',
    color: '#f5f1e8',     // тёплый кремовый, как в .lia-glass
    edgeColor: '#fafafa', // сливается с фоном страницы
  },
  lighting: {
    preset: 'warm',
    intensity: 1.0,
  },
  animation: {
    breathing: true,
    blinking: true,
    headSway: true,
    lipSync: true,
    emotionMorph: true,
  },
  body: {
    armPose: 'natural',
    scale: 1.0,
    yOffset: 0,
  },
};

// ============================================================================
// Lighting presets — конкретные параметры освещения
// ============================================================================
export const LIGHTING_PRESETS: Record<LightingPreset, {
  ambient: { color: string; intensity: number };
  keyLight: { color: string; intensity: number; position: [number, number, number] };
  fillLight: { color: string; intensity: number; position: [number, number, number] };
  hemisphere?: { sky: string; ground: string; intensity: number };
}> = {
  // Тёплый мягкий свет — как утреннее солнце через окно (по умолчанию)
  warm: {
    ambient:     { color: '#ffffff', intensity: 0.85 },
    keyLight:    { color: '#fff5e8', intensity: 1.0, position: [1, 3, 2] },
    fillLight:   { color: '#e8d5c0', intensity: 0.35, position: [-1, 2, 1] },
    hemisphere:  { sky: '#fff5e8', ground: '#c9a886', intensity: 0.25 },
  },
  // Холодный — голубоватый, под «спокойствие»
  cool: {
    ambient:     { color: '#f0f4ff', intensity: 0.85 },
    keyLight:    { color: '#e0eaff', intensity: 0.95, position: [1, 3, 2] },
    fillLight:   { color: '#c8d4ff', intensity: 0.4, position: [-1, 2, 1] },
    hemisphere:  { sky: '#e0eaff', ground: '#a8b4c8', intensity: 0.25 },
  },
  // Нейтральный — белый, без оттенка
  neutral: {
    ambient:     { color: '#ffffff', intensity: 0.9 },
    keyLight:    { color: '#ffffff', intensity: 1.0, position: [1, 3, 2] },
    fillLight:   { color: '#f0f0f0', intensity: 0.4, position: [-1, 2, 1] },
    hemisphere:  { sky: '#ffffff', ground: '#d0d0d0', intensity: 0.2 },
  },
  // Очень мягкий, рассеянный — минимум теней
  soft: {
    ambient:     { color: '#ffffff', intensity: 1.1 },
    keyLight:    { color: '#fff8ed', intensity: 0.6, position: [1, 3, 2] },
    fillLight:   { color: '#f0e6d2', intensity: 0.6, position: [-1, 2, 1] },
    hemisphere:  { sky: '#fff8ed', ground: '#d8c8a8', intensity: 0.4 },
  },
  // Драматичный — контрастный, с одного бока
  dramatic: {
    ambient:     { color: '#ffffff', intensity: 0.4 },
    keyLight:    { color: '#fff0d8', intensity: 1.4, position: [2, 2.5, 1] },
    fillLight:   { color: '#3a2818', intensity: 0.2, position: [-2, 1, -1] },
    hemisphere:  { sky: '#fff0d8', ground: '#2a1810', intensity: 0.1 },
  },
};

// ============================================================================
// Arm pose presets — углы поворота плечевых костей в радианах
// ============================================================================
export const ARM_POSES: Record<ArmPose, {
  leftUpperArmZ: number;
  rightUpperArmZ: number;
  leftLowerArmX: number;
  rightLowerArmX: number;
  leftHandZ: number;
  rightHandZ: number;
}> = {
  // Естественная поза — руки опущены вдоль тела (по умолчанию)
  natural: {
    leftUpperArmZ: -1.35,
    rightUpperArmZ: 1.35,
    leftLowerArmX: -0.25,
    rightLowerArmX: -0.25,
    leftHandZ: 0.15,
    rightHandZ: -0.15,
  },
  // Расслабленная — руки чуть согнуты, кисти ближе к бёдрам
  relaxed: {
    leftUpperArmZ: -1.15,
    rightUpperArmZ: 1.15,
    leftLowerArmX: -0.55,
    rightLowerArmX: -0.55,
    leftHandZ: 0.2,
    rightHandZ: -0.2,
  },
  // T-pose — руки в стороны (для дебага и калибровки)
  't-pose': {
    leftUpperArmZ: 0,
    rightUpperArmZ: 0,
    leftLowerArmX: 0,
    rightLowerArmX: 0,
    leftHandZ: 0,
    rightHandZ: 0,
  },
  // Скрещённые на груди
  crossed: {
    leftUpperArmZ: -0.85,
    rightUpperArmZ: 0.85,
    leftLowerArmX: -1.1,
    rightLowerArmX: -1.1,
    leftHandZ: 0.6,
    rightHandZ: -0.6,
  },
  // Руки в карманах (неLiteralно, но визуально похоже)
  'hands-pockets': {
    leftUpperArmZ: -0.95,
    rightUpperArmZ: 0.95,
    leftLowerArmX: -0.75,
    rightLowerArmX: -0.75,
    leftHandZ: 0.3,
    rightHandZ: -0.3,
  },
};

// ============================================================================
// Parser — безопасное приведение unknown → AvatarConfig с дефолтами
// ============================================================================
export function parseAvatarConfig(json: string): AvatarConfig {
  try {
    const raw = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_AVATAR_CONFIG };
    const r = raw as Record<string, unknown>;

    const cam = (r.camera ?? {}) as Record<string, unknown>;
    const camPreset = (cam.preset as CameraPreset) ?? DEFAULT_AVATAR_CONFIG.camera.preset;
    const camera: AvatarCameraConfig = {
      preset: ['portrait', 'fullbody', 'closeup', 'custom'].includes(camPreset) ? camPreset : 'fullbody',
      position: Array.isArray(cam.position) && cam.position.length === 3
        ? (cam.position as [number, number, number])
        : (camPreset !== 'custom' ? CAMERA_PRESETS[camPreset].position : DEFAULT_AVATAR_CONFIG.camera.position),
      target: Array.isArray(cam.target) && cam.target.length === 3
        ? (cam.target as [number, number, number])
        : (camPreset !== 'custom' ? CAMERA_PRESETS[camPreset].target : DEFAULT_AVATAR_CONFIG.camera.target),
      fov: typeof cam.fov === 'number' && cam.fov >= 15 && cam.fov <= 75
        ? cam.fov
        : DEFAULT_AVATAR_CONFIG.camera.fov,
    };

    const pl = (r.platform ?? {}) as Record<string, unknown>;
    const plStyle = (pl.style as PlatformStyle) ?? DEFAULT_AVATAR_CONFIG.platform.style;
    const platform: AvatarPlatformConfig = {
      style: ['classic', 'minimal', 'glow', 'off'].includes(plStyle) ? plStyle : 'classic',
      radius: typeof pl.radius === 'number' && pl.radius >= 0.25 && pl.radius <= 0.65 ? pl.radius : 0.42,
      showInnerRing: typeof pl.showInnerRing === 'boolean' ? pl.showInnerRing : true,
      showHalo: typeof pl.showHalo === 'boolean' ? pl.showHalo : true,
      pulse: typeof pl.pulse === 'boolean' ? pl.pulse : true,
      opacity: typeof pl.opacity === 'number' && pl.opacity >= 0.2 && pl.opacity <= 1 ? pl.opacity : 0.85,
    };

    const bg = (r.background ?? {}) as Record<string, unknown>;
    const bgStyle = (bg.style as BackgroundStyle) ?? DEFAULT_AVATAR_CONFIG.background.style;
    const background: AvatarBackgroundConfig = {
      style: ['transparent', 'gradient', 'solid', 'radial'].includes(bgStyle) ? bgStyle : 'radial',
      color: typeof bg.color === 'string' ? bg.color : DEFAULT_AVATAR_CONFIG.background.color,
      edgeColor: typeof bg.edgeColor === 'string' ? bg.edgeColor : DEFAULT_AVATAR_CONFIG.background.edgeColor,
    };

    const lt = (r.lighting ?? {}) as Record<string, unknown>;
    const ltPreset = (lt.preset as LightingPreset) ?? DEFAULT_AVATAR_CONFIG.lighting.preset;
    const lighting: AvatarLightingConfig = {
      preset: ['warm', 'cool', 'neutral', 'soft', 'dramatic'].includes(ltPreset) ? ltPreset : 'warm',
      intensity: typeof lt.intensity === 'number' && lt.intensity >= 0.4 && lt.intensity <= 1.8
        ? lt.intensity
        : 1.0,
    };

    const an = (r.animation ?? {}) as Record<string, unknown>;
    const animation: AvatarAnimationConfig = {
      breathing: typeof an.breathing === 'boolean' ? an.breathing : true,
      blinking: typeof an.blinking === 'boolean' ? an.blinking : true,
      headSway: typeof an.headSway === 'boolean' ? an.headSway : true,
      lipSync: typeof an.lipSync === 'boolean' ? an.lipSync : true,
      emotionMorph: typeof an.emotionMorph === 'boolean' ? an.emotionMorph : true,
    };

    const bd = (r.body ?? {}) as Record<string, unknown>;
    const bdPose = (bd.armPose as ArmPose) ?? DEFAULT_AVATAR_CONFIG.body.armPose;
    const body: AvatarBodyConfig = {
      armPose: ['natural', 'relaxed', 't-pose', 'crossed', 'hands-pockets'].includes(bdPose) ? bdPose : 'natural',
      scale: typeof bd.scale === 'number' && bd.scale >= 0.7 && bd.scale <= 1.3 ? bd.scale : 1.0,
      yOffset: typeof bd.yOffset === 'number' && bd.yOffset >= -0.3 && bd.yOffset <= 0.3 ? bd.yOffset : 0,
    };

    return { camera, platform, background, lighting, animation, body };
  } catch {
    return { ...DEFAULT_AVATAR_CONFIG };
  }
}
