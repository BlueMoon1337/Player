/** Playback's loop symbols: a partial loop repeats a section once; infinity repeats it until turned off. */
export const LoopOnceIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="loop-icon">
    <path d="M9.5 6.5H17a5.5 5.5 0 0 1 0 11H7a5.5 5.5 0 0 1-5.5-5.5" />
  </svg>
)
export const LoopForeverIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="loop-icon">
    <path d="M12 12c-2.2-3-3.8-4.5-6-4.5a4.5 4.5 0 0 0 0 9c2.2 0 3.8-1.5 6-4.5s3.8-4.5 6-4.5a4.5 4.5 0 0 1 0 9c-2.2 0-3.8-1.5-6-4.5z" />
  </svg>
)
