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
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
};

// ============================================================================
// Платформа — диск под аватаром, индикатор эмоции
// ============================================================================
// Форма платформы — расширенный набор геометрий:
//   disc     — классический круглый диск (как раньше 'classic')
//   hexagon  — шестиугольная «техно»-платформа, 6 граней
//   ring     — только кольцо, без диска (парящий вид)
//   pedestal — пьедестал: высокий диск + основание шире
//   off      — без платформы
export type PlatformShape = 'disc' | 'hexagon' | 'ring' | 'pedestal' | 'off';

// Стиль свечения кольца:
//   solid     — постоянное свечение
//   pulse     — пульсация в такт эмоции
//   rotate    — вращение кольца вокруг аватара
//   breathing — медленное «дыхание» (увеличение/уменьшение яркости)
export type RingAnimation = 'solid' | 'pulse' | 'rotate' | 'breathing';

export type AvatarPlatformConfig = {
  shape: PlatformShape;
  radius: number;            // 0.30 - 0.60 — радиус диска
  height: number;            // 0.02 - 0.20 — толщина платформы (для pedestal выше)
  showInnerRing: boolean;
  showHalo: boolean;         // мягкое свечение на полу вокруг платформы
  showShadow: boolean;       // контактная тень под аватаром (имитация)
  ringAnimation: RingAnimation;
  rotateSpeed: number;       // 0 - 2 — скорость вращения (если ringAnimation='rotate')
  opacity: number;           // 0.4 - 1.0 — непрозрачность диска
};

// ============================================================================
// Фон — что за аватаром
// ============================================================================
export type BackgroundStyle = 'transparent' | 'gradient' | 'solid' | 'radial';

export type AvatarBackgroundConfig = {
  style: BackgroundStyle;
  color: string;
  edgeColor: string;
};

// ============================================================================
// Освещение — тёплое / холодное / нейтральное
// ============================================================================
export type LightingPreset = 'warm' | 'cool' | 'neutral' | 'soft' | 'dramatic';

export type AvatarLightingConfig = {
  preset: LightingPreset;
  intensity: number;
};

// ============================================================================
// Анимации — покой и микро-движения
// ============================================================================
export type AvatarAnimationConfig = {
  breathing: boolean;       // дыхание (движение спины)
  blinking: boolean;        // моргание
  headSway: boolean;        // лёгкое покачивание головой
  bodySway: boolean;        // покачивание всем телом (бёдра + плечи)
  armSway: boolean;         // микро-движения рук (как при ходьбе на месте)
  weightShift: boolean;     // перенос веса с ноги на ногу (медленный цикл)
  gazeFollow: boolean;      // взгляд следует за курсором мыши (если в фокусе)
  lipSync: boolean;         // липсинк во время стриминга ответа
  emotionMorph: boolean;    // плавная интерполяция эмоций (happy/sad/angry/...)
  emotionPose: boolean;     // изменения позы под эмоцию (joy → лёгкий наклон, sadness → плечи вниз)
  idleFrequency: number;    // 0.3 - 2.0 — множитель частоты всех idle-анимаций
};

// ============================================================================
// Тело — поза и пропорции
// ============================================================================
export type ArmPose = 'natural' | 'relaxed' | 't-pose' | 'crossed' | 'hands-pockets';

export type AvatarBodyConfig = {
  armPose: ArmPose;
  scale: number;
  yOffset: number;
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
// Пресеты камеры — подобраны под реальные габариты Lia.vrm
// (высота 1.666m от Y=0 до Y=1.666, ширина в T-pose 1.336m).
// hips на Y≈0.95, голова на Y≈1.55.
// Формула: видимая высота ≈ 2 * d * tan(FOV/2).
// ============================================================================
export const CAMERA_PRESETS: Record<Exclude<CameraPreset, 'custom'>, Omit<AvatarCameraConfig, 'preset'>> = {
  // Голова и плечи — крупный план по грудь.
  // Камера на высоте груди, смотрит горизонтально, FOV 30°.
  portrait: {
    position: [0, 1.45, 1.0],
    target:   [0, 1.42, 0],
    fov: 30,
  },
  // В полный рост — видна вся модель от макушки до стоп + платформа.
  // Габариты Lia.vrm: высота 1.666m. Центр модели ≈ Y=0.83.
  // При FOV 38° (tan(19°)=0.344): чтобы видеть ~2.1m по вертикали
  // (модель + платформа + отступ), нужно d = 2.1 / (2*0.344) ≈ 3.05m.
  fullbody: {
    position: [0, 1.0, 3.05],
    target:   [0, 0.83, 0],
    fov: 38,
  },
  // Крупно лицо — для интимной беседы.
  closeup: {
    position: [0, 1.55, 0.7],
    target:   [0, 1.52, 0],
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
    shape: 'disc',
    radius: 0.42,
    height: 0.04,
    showInnerRing: true,
    showHalo: true,
    showShadow: true,
    ringAnimation: 'pulse',
    rotateSpeed: 0.5,
    opacity: 0.85,
  },
  background: {
    style: 'radial',
    color: '#f5f1e8',
    edgeColor: '#fafafa',
  },
  lighting: {
    preset: 'warm',
    intensity: 1.0,
  },
  animation: {
    breathing: true,
    blinking: true,
    headSway: true,
    bodySway: true,
    armSway: true,
    weightShift: true,
    gazeFollow: true,
    lipSync: true,
    emotionMorph: true,
    emotionPose: true,
    idleFrequency: 1.0,
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
  warm: {
    ambient:     { color: '#ffffff', intensity: 0.85 },
    keyLight:    { color: '#fff5e8', intensity: 1.0, position: [1, 3, 2] },
    fillLight:   { color: '#e8d5c0', intensity: 0.35, position: [-1, 2, 1] },
    hemisphere:  { sky: '#fff5e8', ground: '#c9a886', intensity: 0.25 },
  },
  cool: {
    ambient:     { color: '#f0f4ff', intensity: 0.85 },
    keyLight:    { color: '#e0eaff', intensity: 0.95, position: [1, 3, 2] },
    fillLight:   { color: '#c8d4ff', intensity: 0.4, position: [-1, 2, 1] },
    hemisphere:  { sky: '#e0eaff', ground: '#a8b4c8', intensity: 0.25 },
  },
  neutral: {
    ambient:     { color: '#ffffff', intensity: 0.9 },
    keyLight:    { color: '#ffffff', intensity: 1.0, position: [1, 3, 2] },
    fillLight:   { color: '#f0f0f0', intensity: 0.4, position: [-1, 2, 1] },
    hemisphere:  { sky: '#ffffff', ground: '#d0d0d0', intensity: 0.2 },
  },
  soft: {
    ambient:     { color: '#ffffff', intensity: 1.1 },
    keyLight:    { color: '#fff8ed', intensity: 0.6, position: [1, 3, 2] },
    fillLight:   { color: '#f0e6d2', intensity: 0.6, position: [-1, 2, 1] },
    hemisphere:  { sky: '#fff8ed', ground: '#d8c8a8', intensity: 0.4 },
  },
  dramatic: {
    ambient:     { color: '#ffffff', intensity: 0.4 },
    keyLight:    { color: '#fff0d8', intensity: 1.4, position: [2, 2.5, 1] },
    fillLight:   { color: '#3a2818', intensity: 0.2, position: [-2, 1, -1] },
    hemisphere:  { sky: '#fff0d8', ground: '#2a1810', intensity: 0.1 },
  },
};

// ============================================================================
// Arm pose presets — углы поворота костей рук в радианах.
//
// Координатная система VRM normalized bones (правая, Y-up):
//   upperArm.rotation.z < 0 → опускает левую руку вниз (для правой — > 0)
//   upperArm.rotation.x     → поднимает руку вперёд (сгибание в плече)
//   lowerArm.rotation.x     → сгибает локоть (кисть к плечу)
//   lowerArm.rotation.y     → вращает предплечье внутрь/наружу
//   hand.rotation.z         → наклон кисти
//
// Все углы подобраны визуально на модели Lia.vrm (высота 1.666m).
// ============================================================================
export const ARM_POSES: Record<ArmPose, {
  leftUpperArmZ: number;
  rightUpperArmZ: number;
  leftUpperArmX: number;
  rightUpperArmX: number;
  leftUpperArmY: number;   // приведение к корпусу (adduction) — нужно для crossed
  rightUpperArmY: number;
  leftLowerArmX: number;
  rightLowerArmX: number;
  leftLowerArmY: number;
  rightLowerArmY: number;
  leftLowerArmZ: number;   // Z-вращение предплечья
  rightLowerArmZ: number;
  leftHandZ: number;
  rightHandZ: number;
}> = {
  // Естественная поза — руки опущены вдоль тела.
  natural: {
    leftUpperArmZ: -1.35,
    rightUpperArmZ: 1.35,
    leftUpperArmX: 0.05,
    rightUpperArmX: 0.05,
    leftUpperArmY: 0,
    rightUpperArmY: 0,
    leftLowerArmX: -0.25,
    rightLowerArmX: -0.25,
    leftLowerArmY: 0,
    rightLowerArmY: 0,
    leftLowerArmZ: 0,
    rightLowerArmZ: 0,
    leftHandZ: 0.15,
    rightHandZ: -0.15,
  },
  // Расслабленная — руки чуть согнуты.
  relaxed: {
    leftUpperArmZ: -1.15,
    rightUpperArmZ: 1.15,
    leftUpperArmX: 0.10,
    rightUpperArmX: 0.10,
    leftUpperArmY: 0,
    rightUpperArmY: 0,
    leftLowerArmX: -0.55,
    rightLowerArmX: -0.55,
    leftLowerArmY: 0.05,
    rightLowerArmY: -0.05,
    leftLowerArmZ: 0,
    rightLowerArmZ: 0,
    leftHandZ: 0.20,
    rightHandZ: -0.20,
  },
  't-pose': {
    leftUpperArmZ: 0,
    rightUpperArmZ: 0,
    leftUpperArmX: 0,
    rightUpperArmX: 0,
    leftUpperArmY: 0,
    rightUpperArmY: 0,
    leftLowerArmX: 0,
    rightLowerArmX: 0,
    leftLowerArmY: 0,
    rightLowerArmY: 0,
    leftLowerArmZ: 0,
    rightLowerArmZ: 0,
    leftHandZ: 0,
    rightHandZ: 0,
  },
  // Скрещённые на груди.
  // VRM normalized bones Euler XYZ:
  //   upperArm.X = поднять руку вперёд
  //   upperArm.Y = привести к корпусу (горизонтальная аддукция)
  //   upperArm.Z = опустить вниз (при X≈0)
  //   lowerArm.X = согнуть локоть
  //   lowerArm.Y = вращение предплечья (pronation/supination)
  //   lowerArm.Z = отвести кисть внутрь/наружу
  // Для crossed: поднимаем руки вперёд, приводим к центру, сгибаем локти.
  crossed: {
    leftUpperArmZ: -0.20,
    rightUpperArmZ: 0.20,
    leftUpperArmX: 1.20,
    rightUpperArmX: 1.20,
    // Y — привести руки к центру корпуса (горизонтальная аддукция)
    // Левая рука поворачивается +Y (внутрь), правая -Y (внутрь)
    leftUpperArmY: 0.80,
    rightUpperArmY: -0.80,
    leftLowerArmX: -1.60,
    rightLowerArmX: -1.60,
    leftLowerArmY: 0,
    rightLowerArmY: 0,
    leftLowerArmZ: 0.40,
    rightLowerArmZ: -0.40,
    leftHandZ: 0.10,
    rightHandZ: -0.10,
  },
  'hands-pockets': {
    leftUpperArmZ: -0.95,
    rightUpperArmZ: 0.95,
    leftUpperArmX: 0.20,
    rightUpperArmX: 0.20,
    leftUpperArmY: 0,
    rightUpperArmY: 0,
    leftLowerArmX: -0.85,
    rightLowerArmX: -0.85,
    leftLowerArmY: 0.15,
    rightLowerArmY: -0.15,
    leftLowerArmZ: 0,
    rightLowerArmZ: 0,
    leftHandZ: 0.30,
    rightHandZ: -0.30,
  },
};

// ============================================================================
// Backwards-compat: старый PlatformStyle → новый PlatformShape
// ============================================================================
const LEGACY_PLATFORM_STYLE_MAP: Record<string, PlatformShape> = {
  classic: 'disc',
  minimal: 'disc',   // minimal был тем же диском, просто без колец — управляется showInnerRing
  glow: 'disc',      // glow был диском с мощным свечением — управляется ringAnimation
  off: 'off',
};

// ============================================================================
// Parser — безопасное приведение unknown → AvatarConfig с дефолтами
// ============================================================================
export function parseAvatarConfig(json: string): AvatarConfig {
  try {
    const raw = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_AVATAR_CONFIG };
    const r = raw as Record<string, unknown>;

    // Camera
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

    // Platform — с поддержкой легаси 'style' (classic/minimal/glow)
    const pl = (r.platform ?? {}) as Record<string, unknown>;
    let plShape: PlatformShape;
    if (typeof pl.shape === 'string' && ['disc', 'hexagon', 'ring', 'pedestal', 'off'].includes(pl.shape)) {
      plShape = pl.shape as PlatformShape;
    } else if (typeof pl.style === 'string' && pl.style in LEGACY_PLATFORM_STYLE_MAP) {
      plShape = LEGACY_PLATFORM_STYLE_MAP[pl.style];
    } else {
      plShape = 'disc';
    }
    const ringAnim = (typeof pl.ringAnimation === 'string' && ['solid', 'pulse', 'rotate', 'breathing'].includes(pl.ringAnimation))
      ? pl.ringAnimation as RingAnimation
      : DEFAULT_AVATAR_CONFIG.platform.ringAnimation;
    // Legacy: 'pulse' boolean field → если был false, ставим 'solid'
    const legacyPulseOff = typeof pl.pulse === 'boolean' && pl.pulse === false;
    const platform: AvatarPlatformConfig = {
      shape: plShape,
      radius: typeof pl.radius === 'number' && pl.radius >= 0.25 && pl.radius <= 0.65 ? pl.radius : 0.42,
      height: typeof pl.height === 'number' && pl.height >= 0.02 && pl.height <= 0.25 ? pl.height : 0.04,
      showInnerRing: typeof pl.showInnerRing === 'boolean' ? pl.showInnerRing : true,
      showHalo: typeof pl.showHalo === 'boolean' ? pl.showHalo : true,
      showShadow: typeof pl.showShadow === 'boolean' ? pl.showShadow : true,
      ringAnimation: legacyPulseOff ? 'solid' : ringAnim,
      rotateSpeed: typeof pl.rotateSpeed === 'number' && pl.rotateSpeed >= 0 && pl.rotateSpeed <= 3 ? pl.rotateSpeed : 0.5,
      opacity: typeof pl.opacity === 'number' && pl.opacity >= 0.2 && pl.opacity <= 1 ? pl.opacity : 0.85,
    };

    // Background
    const bg = (r.background ?? {}) as Record<string, unknown>;
    const bgStyle = (bg.style as BackgroundStyle) ?? DEFAULT_AVATAR_CONFIG.background.style;
    const background: AvatarBackgroundConfig = {
      style: ['transparent', 'gradient', 'solid', 'radial'].includes(bgStyle) ? bgStyle : 'radial',
      color: typeof bg.color === 'string' ? bg.color : DEFAULT_AVATAR_CONFIG.background.color,
      edgeColor: typeof bg.edgeColor === 'string' ? bg.edgeColor : DEFAULT_AVATAR_CONFIG.background.edgeColor,
    };

    // Lighting
    const lt = (r.lighting ?? {}) as Record<string, unknown>;
    const ltPreset = (lt.preset as LightingPreset) ?? DEFAULT_AVATAR_CONFIG.lighting.preset;
    const lighting: AvatarLightingConfig = {
      preset: ['warm', 'cool', 'neutral', 'soft', 'dramatic'].includes(ltPreset) ? ltPreset : 'warm',
      intensity: typeof lt.intensity === 'number' && lt.intensity >= 0.4 && lt.intensity <= 1.8
        ? lt.intensity
        : 1.0,
    };

    // Animation — с дефолтами для новых полей
    const an = (r.animation ?? {}) as Record<string, unknown>;
    const animation: AvatarAnimationConfig = {
      breathing: typeof an.breathing === 'boolean' ? an.breathing : true,
      blinking: typeof an.blinking === 'boolean' ? an.blinking : true,
      headSway: typeof an.headSway === 'boolean' ? an.headSway : true,
      bodySway: typeof an.bodySway === 'boolean' ? an.bodySway : true,
      armSway: typeof an.armSway === 'boolean' ? an.armSway : true,
      weightShift: typeof an.weightShift === 'boolean' ? an.weightShift : true,
      gazeFollow: typeof an.gazeFollow === 'boolean' ? an.gazeFollow : true,
      lipSync: typeof an.lipSync === 'boolean' ? an.lipSync : true,
      emotionMorph: typeof an.emotionMorph === 'boolean' ? an.emotionMorph : true,
      emotionPose: typeof an.emotionPose === 'boolean' ? an.emotionPose : true,
      idleFrequency: typeof an.idleFrequency === 'number' && an.idleFrequency >= 0.2 && an.idleFrequency <= 3
        ? an.idleFrequency
        : 1.0,
    };

    // Body
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
