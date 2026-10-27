import { describe, expect, it } from 'vitest'
import { detectFileType } from './file-type'

const bytes = (...values: (number | string)[]) => new Uint8Array(values.flatMap(v => typeof v === 'string' ? [...v].map(c => c.charCodeAt(0)) : [v]))

describe('upload type detection', () => {
  it('recognises real images and PDFs by content', () => {
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext).toBe('jpg')
    expect(detectFileType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))?.ext).toBe('png')
    expect(detectFileType(bytes('GIF89a'))?.ext).toBe('gif')
    expect(detectFileType(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))?.ext).toBe('webp')
    expect(detectFileType(bytes('%PDF-1.7'))?.ext).toBe('pdf')
    expect(detectFileType(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))?.ext).toBe('heic')
  })

  it('rejects SVG/HTML whatever the browser claims', () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect(detectFileType(svg, 'image/png')).toBeNull()
    expect(detectFileType(svg, 'text/csv')).toBeNull()
    expect(detectFileType(bytes('<html><body>x</body></html>'), 'image/jpeg')).toBeNull()
  })

  it('accepts plain CSV only when declared as CSV', () => {
    expect(detectFileType(bytes('name,qty\nTile,4\n'), 'text/csv')?.ext).toBe('csv')
    expect(detectFileType(bytes('name,qty\nTile,4\n'), 'image/png')).toBeNull()
  })
})
