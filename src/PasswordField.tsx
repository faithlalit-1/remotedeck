import { useState } from 'react'

type PasswordFieldProps = {
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  placeholder?: string
  id?: string
}

export function PasswordField({
  value,
  onChange,
  autoComplete = 'current-password',
  placeholder,
  id,
}: PasswordFieldProps) {
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="password-field">
      <input
        id={id}
        autoComplete={autoComplete}
        type={revealed ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={revealed ? 'Hide password' : 'Show password'}
        title={revealed ? 'Hide password' : 'Show password'}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.7 10.7 0 0 1 12 5c5 0 9.3 3.1 11 7-.6 1.3-1.4 2.4-2.4 3.4M6.6 6.6C4.6 8 3.1 9.9 2 12c1.7 3.9 6 7 11 7 1.7 0 3.3-.4 4.8-1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle
              cx="12"
              cy="12"
              r="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
        )}
      </button>
    </div>
  )
}
