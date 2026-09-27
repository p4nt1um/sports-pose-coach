/**
 * tpc-landmarks.js — BlazePose 33 关键点定义与骨架连接表
 *
 * 索引遵循 MediaPipe Pose Landmarker 官方定义。
 * 重要：LEFT_* / RIGHT_* 指的是**被拍摄者本人的左右**，不是画面上的左右。
 *       在未镜像的自拍视角下，被拍摄者的左手会出现在画面右侧。
 */

export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

/** 关键点英文名（与官方一致，便于对照文档与日志） */
export const LM_NAMES = [
  'nose',
  'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky',
  'left_index', 'right_index',
  'left_thumb', 'right_thumb',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

/** 关键点中文名（调试面板用） */
export const LM_LABELS_CN = [
  '鼻', '左眼内', '左眼', '左眼外', '右眼内', '右眼', '右眼外', '左耳', '右耳',
  '左嘴角', '右嘴角',
  '左肩', '右肩', '左肘', '右肘', '左腕', '右腕',
  '左小指', '右小指', '左食指', '右食指', '左拇指', '右拇指',
  '左髋', '右髋', '左膝', '右膝', '左踝', '右踝',
  '左脚跟', '右脚跟', '左脚掌', '右脚掌',
];

/**
 * 骨架连接表（画线用）。刻意剔除了手掌内部的小三角，
 * 保留到手腕即可 —— 30fps 下手指点噪声大，画出来反而干扰观察。
 */
export const SKELETON = [
  // 面部
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // 肩带与躯干
  [11, 12], [11, 23], [12, 24], [23, 24],
  // 左臂
  [11, 13], [13, 15],
  // 右臂
  [12, 14], [14, 16],
  // 左腿
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  // 右腿
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

/** 分组定义：调试面板按组显示角度，避免一次抛 20 个数字给人看 */
export const JOINT_GROUPS = [
  {
    id: 'arms',
    label: '上肢',
    joints: [
      { id: 'elbowL', label: '左肘', a: 11, b: 13, c: 15 },
      { id: 'elbowR', label: '右肘', a: 12, b: 14, c: 16 },
      { id: 'shoulderL', label: '左肩', a: 13, b: 11, c: 23 },
      { id: 'shoulderR', label: '右肩', a: 14, b: 12, c: 24 },
    ],
  },
  {
    id: 'legs',
    label: '下肢',
    joints: [
      { id: 'kneeL', label: '左膝', a: 23, b: 25, c: 27 },
      { id: 'kneeR', label: '右膝', a: 24, b: 26, c: 28 },
      { id: 'hipL', label: '左髋', a: 11, b: 23, c: 25 },
      { id: 'hipR', label: '右髋', a: 12, b: 24, c: 26 },
    ],
  },
];

/** 单个关键点的合格可见度门槛，低于此值视为不可信 */
export const VIS_THRESHOLD = 0.5;

/** 计算角度所需的关键点一组的整体可见度 */
export function jointVisibility(lm, joint) {
  const a = lm[joint.a], b = lm[joint.b], c = lm[joint.c];
  if (!a || !b || !c) return 0;
  const va = a.visibility == null ? 1 : a.visibility;
  const vb = b.visibility == null ? 1 : b.visibility;
  const vc = c.visibility == null ? 1 : c.visibility;
  return Math.min(va, vb, vc);
}
