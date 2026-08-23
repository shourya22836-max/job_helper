// Pure-SVG AI avatar. Two animated eyes + morphing mouth arc.
// Props: isSpeaking, isThinking, size.
export default function AvatarOrb({ isSpeaking = false, isThinking = false, size = 240 }) {
  const s = size
  const cx = s / 2
  const cy = s / 2
  const r = s / 2 - 6
  const eyeY = cy - 18
  const mouthY = cy + 36

  return (
    <svg
      className={`avatar-orb ${isSpeaking ? 'speaking' : ''} ${isThinking ? 'thinking' : ''}`}
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      role="img"
      aria-label="AI interviewer avatar"
    >
      <defs>
        <radialGradient id="avatarGrad" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="60%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#1e293b" />
        </radialGradient>
        <radialGradient id="avatarGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r + 14} fill="url(#avatarGlow)" />
      <circle cx={cx} cy={cy} r={r} fill="url(#avatarGrad)" stroke="#a5b4fc" strokeWidth="2" />

      {/* Eyes */}
      <ellipse cx={cx - 36} cy={eyeY} rx="10" ry="12" fill="#f8fafc" />
      <ellipse cx={cx + 36} cy={eyeY} rx="10" ry="12" fill="#f8fafc" />
      <circle cx={cx - 34} cy={eyeY + 2} r="5" fill="#0f172a" />
      <circle cx={cx + 38} cy={eyeY + 2} r="5" fill="#0f172a" />

      {/* Mouth — morphs when speaking */}
      <path
        className="avatar-mouth"
        d={
          isSpeaking
            ? `M ${cx - 30} ${mouthY} q 30 22 60 0`
            : isThinking
              ? `M ${cx - 14} ${mouthY} q 14 -6 28 0`
              : `M ${cx - 22} ${mouthY} q 22 8 44 0`
        }
        stroke="#f8fafc"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}