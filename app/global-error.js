'use client';

// Last-resort boundary: replaces the whole page when the root layout itself fails.
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#fafafa', color: '#111' }}>
        <div style={{ maxWidth: 420, textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ fontSize: 14, color: '#555', marginBottom: 16 }}>The app hit an unexpected error. Your data is safe.</p>
          {error?.digest && <p style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>Reference: {error.digest}</p>}
          <button onClick={() => reset()} style={{ padding: '8px 16px', borderRadius: 12, border: 0, background: '#111', color: '#fff', cursor: 'pointer' }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
