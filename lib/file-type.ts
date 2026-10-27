// Detects an upload's real type from its first bytes. The browser-declared
// MIME type and the file name are attacker-controlled (e.g. an SVG with a
// script, sent as "image/png" named "x.svg"), so the stored extension must
// come from the content.

export type DetectedFile = { ext: string; mime: string }

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end))
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'])

export function detectFileType(bytes: Uint8Array, declaredMime = ''): DetectedFile | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', mime: 'image/png' }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  if (ascii(bytes, 0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' }
  if (ascii(bytes, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 12))) return { ext: 'heic', mime: 'image/heic' }
  // CSV has no signature: accept declared CSV only if it is plain text with no markup.
  if (declaredMime === 'text/csv' && isPlainText(bytes)) return { ext: 'csv', mime: 'text/csv' }
  return null
}

function isPlainText(bytes: Uint8Array) {
  const sample = bytes.slice(0, 4096)
  for (const byte of sample) {
    if (byte === 0) return false // binary
    if (byte === 0x3c) return false // '<' — refuse anything HTML/SVG-like
  }
  return true
}
