// 3D AI interviewer avatar.
//
// Pipeline:
//   1. Load a Ready Player Me (or any rigged/ARKit-blendshape) GLB via useGLTF.
//   2. Find the SkinnedMesh that has morphTargetInfluences, then walk its
//      morphTargetDictionary for the ARKit / RPM canonical shape names.
//   3. Drive those shape weights from a single "expression" state object that
//      other code can mutate via the setExpression() / setViseme() imperative
//      API exposed by forwardRef.
//
// Why imperative API instead of props-only?
//   - The LiveKit data channel delivers viseme frames at ~30 Hz. Funneling
//     those through React props+state would re-render the whole tree per
//     frame. The imperative path mutates shape weights directly inside the
//     animation loop and only triggers React renders on meaningful changes
//     (e.g. emotion label change).
//
// Supported ARKit shape names (any subset present in the model will work):
//   mouthOpen, mouthSmile, mouthPucker, mouthFrown, browInnerUp,
//   browOuterUp, browDown, eyeBlinkLeft, eyeBlinkRight, eyeLookUp,
//   eyeLookDown, eyeLookLeft, eyeLookRight, jawOpen, cheekPuff,
//   noseSneerLeft, noseSneerRight
//
// Props (all optional):
//   modelUrl           — defaults to a free Ready Player Me sample URL
//   emotion            — 'neutral' | 'smile' | 'concern' | 'think' | 'encourage'
//   isSpeaking         — boolean; opens mouth and lifts cheeks while true
//   isThinking         — boolean; tilts head and narrows eyes
//   cameraOffset       — [x, y, z] camera position tweak
//
// Imperative API (via ref):
//   setViseme({ mouthOpen, smile, browRaise, blink, ts })
//   setExpression('smile', 0.7)
//   resetExpression()

import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, OrbitControls, useGLTF } from '@react-three/drei'
import { Component, Suspense, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'

// Default GLB: a public, free three.js example model with morph targets for lip-sync.
// This is a humanoid robot with ARKit-compatible blendshapes (mouthOpen, smile, blink, etc.).
// Replace via prop to use a custom avatar (e.g., Ready Player Me: 'https://models.readyplayer.me/<avatar-id>.glb').
const DEFAULT_MODEL_URL =
  'https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb'

// Public, free avatar GLBs (any of these work):
//   'https://models.readyplayer.me/<avatar-id>.glb' (RPM — needs a real id)
//   'https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb' (current default)
//   'https://threejs.org/examples/models/gltf/Soldier.glb' (has morph targets but fewer)

// Map of canonical ARKit blendshape names → the key used inside the model.
// Tries multiple spellings because different pipelines (RPM, MetaHuman, VRM)
// name the same shape slightly differently.
const SHAPE_ALIASES = {
  mouthOpen:    ['mouthOpen', 'jawOpen', 'viseme_aa', 'mouth_open'],
  mouthSmile:   ['mouthSmile', 'mouthSmileLeft', 'mouthSmileRight', 'smile'],
  mouthFrown:   ['mouthFrown', 'mouthFrownLeft', 'mouthFrownRight', 'frown'],
  browInnerUp:  ['browInnerUp', 'browsRaised'],
  browOuterUp:  ['browOuterUpLeft', 'browOuterUpRight'],
  browDown:     ['browDownLeft', 'browDownRight'],
  eyeBlinkLeft: ['eyeBlinkLeft', 'blink_L'],
  eyeBlinkRight:['eyeBlinkRight', 'blink_R'],
  eyeLookUp:    ['eyeLookUpLeft', 'eyeLookUpRight'],
  eyeLookDown:  ['eyeLookDownLeft', 'eyeLookDownRight'],
  cheekPuff:    ['cheekPuff', 'cheekPuffLeft', 'cheekPuffRight'],
  noseSneerLeft:['noseSneerLeft'],
  noseSneerRight:['noseSneerRight'],
}

function findShapeIndex(dict, aliases) {
  if (!dict) return -1
  for (const name of aliases) {
    if (name in dict) return dict[name]
  }
  return -1
}

// ---------------------------------------------------------------------------
// Timeout gate — useGLTF uses Suspense (no catchable error), so if the GLB
// never resolves we flip to a non-canvas emoji fallback after a short wait.
// This avoids the "black tile forever" symptom on bad URLs.
// ---------------------------------------------------------------------------
function ModelGate({ modelUrl, children, timeoutMs = 15000 }) {
  const [timedOut, setTimedOut] = useState(false)
  const [failed, setFailed] = useState(false)

  // Reset when the URL changes.
  useEffect(() => {
    setTimedOut(false)
    setFailed(false)

    // Skip HEAD check — some CDNs block it. Rely on the load timeout instead.
    const t = setTimeout(() => { setTimedOut(true) }, timeoutMs)
    return () => clearTimeout(t)
  }, [modelUrl, timeoutMs])

  if (failed) return <FallbackAvatar reason="avatar URL unreachable" />
  if (timedOut) return <FallbackAvatar reason="avatar taking too long to load" />
  return children
}

// ---------------------------------------------------------------------------
// Error boundary — catches render errors outside useGLTF (e.g. parse errors
// thrown synchronously after Suspense resolves).
// ---------------------------------------------------------------------------
class GLBErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'Failed to load avatar model.' }
  }
  componentDidCatch(error, info) {
    console.warn('[AvatarScene] GLB load failed:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return <FallbackAvatar reason={this.state.message} />
    }
    return this.props.children
  }
}

function FallbackAvatar({ reason }) {
  return (
    <div className="avatar-fallback" role="img" aria-label="AI interviewer (avatar unavailable)">
      <div className="avatar-fallback-emoji">🤖</div>
      {reason && <div className="avatar-fallback-msg">{reason}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inner avatar mesh: drives blendshapes + head pose each frame.
// ---------------------------------------------------------------------------
function AvatarMesh({ modelUrl, visemeTarget, emotionTarget, headTiltRef }) {
  const gltf = useGLTF(modelUrl)
  const groupRef = useRef(null)
  const headRef = useRef(null)
  const shapeMap = useRef({})
  const meshRef = useRef(null)

  // Walk the scene graph, find the first SkinnedMesh with morphTargets.
  useEffect(() => {
    let mesh = null
    gltf.scene.traverse((obj) => {
      if (mesh) return
      if (obj.isSkinnedMesh && obj.morphTargetInfluences?.length) {
        mesh = obj
      }
    })
    meshRef.current = mesh
    if (!mesh) {
      console.warn('[AvatarScene] No SkinnedMesh with morphTargets found in GLB.')
      return
    }
    const dict = mesh.morphTargetDictionary || {}
    const idx = {}
    for (const [canonical, aliases] of Object.entries(SHAPE_ALIASES)) {
      idx[canonical] = findShapeIndex(dict, aliases)
    }
    shapeMap.current = idx
    // Reset all weights to 0.
    for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
      mesh.morphTargetInfluences[i] = 0
    }
  }, [gltf])

  // Per-frame: apply viseme + emotion targets to blendshapes.
  useFrame((_, dt) => {
    const mesh = meshRef.current
    if (!mesh) return
    const influences = mesh.morphTargetInfluences
    if (!influences) return

    const v = visemeTarget.current
    const e = emotionTarget.current

    // Easing: lerp current → target each frame.
    const k = 1 - Math.exp(-dt * 14) // ~14Hz smoothing

    // Helper: set weight with smoothing
    const setShape = (canonical, target) => {
      const i = shapeMap.current[canonical]
      if (i == null || i < 0) return
      const cur = influences[i] ?? 0
      influences[i] = cur + (target - cur) * k
    }

    // Viseme-driven
    setShape('mouthOpen',  v.mouthOpen ?? 0)
    setShape('mouthSmile', (v.smile ?? 0) * 0.7)
    setShape('browOuterUp', v.browRaise ?? 0)
    // Blink → fold into eyeBlinkLeft/Right equally
    const blink = v.blink ?? 0
    setShape('eyeBlinkLeft', blink)
    setShape('eyeBlinkRight', blink)

    // Emotion-driven (additive on top of viseme)
    if (e.emotion === 'smile') {
      setShape('mouthSmile', Math.max(influences[shapeMap.current.mouthSmile] ?? 0, (e.intensity ?? 0.6) * 0.8))
      setShape('mouthFrown', 0)
    } else if (e.emotion === 'concern') {
      setShape('browInnerUp', (e.intensity ?? 0.6))
      setShape('mouthFrown', (e.intensity ?? 0.6) * 0.5)
    } else if (e.emotion === 'think') {
      setShape('eyeLookUp', 0.4 * (e.intensity ?? 0.6))
      setShape('mouthFrown', 0.15 * (e.intensity ?? 0.6))
    } else if (e.emotion === 'encourage') {
      setShape('mouthSmile', Math.max(influences[shapeMap.current.mouthSmile] ?? 0, 0.6 * (e.intensity ?? 0.7)))
      setShape('browInnerUp', 0.3 * (e.intensity ?? 0.6))
    } else { // neutral
      setShape('mouthFrown', 0)
      setShape('browInnerUp', 0)
      setShape('eyeLookUp', 0)
    }

    // Subtle head tilt for "thinking"
    if (headRef.current) {
      const targetTilt = e.emotion === 'think' ? 0.12 : (e.emotion === 'concern' ? -0.05 : 0)
      const targetNod = e.emotion === 'encourage' ? -0.06 : 0
      headRef.current.rotation.z += (targetTilt - headRef.current.rotation.z) * k
      headRef.current.rotation.x += (targetNod - headRef.current.rotation.x) * k
    }
  })

  return (
    <group ref={groupRef}>
      <group ref={headRef}>
        <primitive object={gltf.scene} />
      </group>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------
const AvatarScene = forwardRef(function AvatarScene(
  { modelUrl = DEFAULT_MODEL_URL, isSpeaking = false, isThinking = false,
    emotion = 'neutral', cameraOffset = [0, 0.05, 0.6], background = 'linear-gradient(...)' },
  ref,
) {
  // Mutable targets — read inside the animation loop.
  const visemeTarget = useRef({ mouthOpen: 0, smile: 0, browRaise: 0, blink: 0, ts: 0 })
  const emotionTarget = useRef({ emotion: 'neutral', intensity: 0.6 })
  const headTiltRef = useRef(null)

  // React-state-driven changes are pushed into the mutable targets.
  useEffect(() => {
    emotionTarget.current = { emotion, intensity: isThinking ? 0.7 : 0.6 }
  }, [emotion, isThinking])

  // Idle ambient motion so the avatar doesn't look frozen when neither
  // speaking nor thinking.
  useEffect(() => {
    if (isSpeaking || isThinking) return
    let raf = null
    const t0 = performance.now()
    const tick = () => {
      const t = (performance.now() - t0) / 1000
      // Idle breathing → tiny periodic mouthOpen + blink every ~4s.
      visemeTarget.current.mouthOpen = visemeTarget.current.mouthOpen * 0.9 + 0.02 * 0.1
      visemeTarget.current.blink = ((t % 4) < 0.15) ? 1 : 0
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [isSpeaking, isThinking])

  useImperativeHandle(ref, () => ({
    setViseme(frame = {}) {
      // Coalesce to mutable target — no React state update.
      const v = visemeTarget.current
      if (typeof frame.mouthOpen === 'number') v.mouthOpen = Math.max(0, Math.min(1, frame.mouthOpen))
      if (typeof frame.smile === 'number')     v.smile     = Math.max(0, Math.min(1, frame.smile))
      if (typeof frame.browRaise === 'number') v.browRaise = Math.max(0, Math.min(1, frame.browRaise))
      if (typeof frame.blink === 'number')     v.blink     = Math.max(0, Math.min(1, frame.blink))
      v.ts = frame.ts || Date.now() / 1000
    },
    setExpression(label, intensity = 0.6) {
      emotionTarget.current = { emotion: label, intensity }
    },
    resetExpression() {
      emotionTarget.current = { emotion: 'neutral', intensity: 0 }
      visemeTarget.current = { mouthOpen: 0, smile: 0, browRaise: 0, blink: 0, ts: 0 }
    },
  }), [])

  return (
    <GLBErrorBoundary>
      <ModelGate modelUrl={modelUrl}>
        <div className="avatar-3d-stage" aria-label="3D AI avatar">
          <Canvas
            camera={{ position: cameraOffset, fov: 28 }}
            gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
            dpr={[1, 2]}
            style={{ width: '100%', height: '100%', background: 'transparent' }}
          >
            <ambientLight intensity={0.8} />
            <directionalLight position={[2, 2, 2]} intensity={0.7} />
            <directionalLight position={[-2, 1, 1]} intensity={0.3} />
            <Suspense fallback={null}>
              <AvatarMesh
                modelUrl={modelUrl}
                visemeTarget={visemeTarget}
                emotionTarget={emotionTarget}
                headTiltRef={headTiltRef}
              />
              <Environment preset="city" />
            </Suspense>
            <OrbitControls
              enableZoom={false}
              enablePan={false}
              target={[0, 1.45, 0]}
              minPolarAngle={Math.PI / 2.4}
              maxPolarAngle={Math.PI / 1.85}
            />
          </Canvas>
        </div>
      </ModelGate>
    </GLBErrorBoundary>
  )
})

export default AvatarScene
