// CLIProxy mark: a ">_" prompt drawn on a 5×5 dot grid, lit dots in the accent.

const LIT = new Set(['0,0', '1,1', '2,2', '1,3', '0,4', '3,4', '4,4'])

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-label="CLIProxy">
      {Array.from({ length: 25 }, (_, i) => {
        const col = i % 5
        const row = Math.floor(i / 5)
        const lit = LIT.has(`${col},${row}`)
        return <circle key={i} cx={3 + col * 4.5} cy={3 + row * 4.5} r={lit ? 1.6 : 0.9} className={lit ? 'logo-lit' : 'logo-dim'} />
      })}
    </svg>
  )
}
