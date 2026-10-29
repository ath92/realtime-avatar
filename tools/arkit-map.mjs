// ARKit's 52 blendshape names, in the canonical order used by LAM's
// `flame_arkit_bs` basis and by LAM-A2E.
//
// Shared by tools/import-mesh.mjs (mesh morph targets) and tools/import-lam.mjs
// (FLAME-space Gaussians), so both map to the same 16 rig channels.

export const ARKIT_NAMES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

// arkit key -> [rig channel, sign, divisor]
// `div` normalises channels composed from several keys (two eyes, left+right).
export const ARKIT_MAP = [
  ['jawOpen', 'jawOpen', 1, 1],
  ['mouthSmileLeft', 'mouthSmile_L', 1, 1],
  ['mouthSmileRight', 'mouthSmile_R', 1, 1],
  ['mouthFunnel', 'mouthFunnel', 1, 1],
  ['mouthPucker', 'mouthPucker', 1, 1],
  ['browInnerUp', 'browInnerUp', 1, 1],
  ['browOuterUpLeft', 'browOuterUp_L', 1, 1],
  ['browOuterUpRight', 'browOuterUp_R', 1, 1],
  ['browDownLeft', 'browDown_L', 1, 1],
  ['browDownRight', 'browDown_R', 1, 1],
  ['eyeBlinkLeft', 'eyeBlink_L', 1, 1],
  ['eyeBlinkRight', 'eyeBlink_R', 1, 1],
  ['eyeLookOutLeft', 'eyeLookX', 1, 2],
  ['eyeLookOutRight', 'eyeLookX', 1, 2],
  ['eyeLookInLeft', 'eyeLookX', -1, 2],
  ['eyeLookInRight', 'eyeLookX', -1, 2],
  ['eyeLookUpLeft', 'eyeLookY', 1, 2],
  ['eyeLookUpRight', 'eyeLookY', 1, 2],
  ['eyeLookDownLeft', 'eyeLookY', -1, 2],
  ['eyeLookDownRight', 'eyeLookY', -1, 2],
  ['cheekPuff', 'cheekPuff', 1, 1],
  ['noseSneerLeft', 'noseSneer', 1, 2],
  ['noseSneerRight', 'noseSneer', 1, 2],
];

export const arkitIndex = (name) => ARKIT_NAMES.indexOf(name);
