import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'node:fs/promises'
import { getUploadFilePath } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  csv: 'text/csv',
}
// Shown in the browser; everything else (including any old .svg) downloads.
const INLINE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf'])

// In standalone Next.js builds, process.cwd() ≠ /app — use UPLOAD_DIR env var
// Serves files from the uploads directory
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params
  const relativePath = segments.join('/')

  // Security: block path traversal
  if (relativePath.includes('..') || relativePath.startsWith('/')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  const filePath = getUploadFilePath(relativePath)

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const buffer = await readFile(filePath)
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Never let the browser guess a type or run anything from an upload.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': INLINE.has(ext) ? 'inline' : 'attachment',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
