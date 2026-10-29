'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { confirmDialog } from '@/components/AlertToastProvider';
import {
  BookOpen, Plus, Trash2, RefreshCw, Loader2, Upload,
  CheckCircle2, Clock, XCircle, FileText, ChevronDown, ChevronRight,
  AlertCircle,
} from 'lucide-react'

interface KnowledgeDoc {
  id: string
  title: string
  source_type: string
  char_count: number
  chunk_count: number
  status: 'pending' | 'indexed' | 'error'
  error?: string | null
  created_at: string
}

const STATUS_CONFIG = {
  pending:  { icon: Clock,         color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200', label: 'Indexing…' },
  indexed:  { icon: CheckCircle2,  color: 'text-green-600',  bg: 'bg-green-50 border-green-200',   label: 'Indexed' },
  error:    { icon: XCircle,       color: 'text-red-500',    bg: 'bg-red-50 border-red-200',        label: 'Error' },
}

function DocRow({
  doc,
  onDelete,
  onReindex,
}: {
  doc: KnowledgeDoc
  onDelete: (id: string) => void
  onReindex: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const sc = STATUS_CONFIG[doc.status]
  const StatusIcon = sc.icon

  const handleDelete = async () => {
    if (!await confirmDialog(`Delete "${doc.title}"? This cannot be undone.`)) return
    setDeleting(true)
    onDelete(doc.id)
  }

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${doc.status === 'error' ? 'border-red-200' : 'border-border'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="text-muted shrink-0">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        <FileText className="w-4 h-4 text-accent shrink-0" />

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{doc.title}</p>
          <p className="text-[11px] text-muted mt-0.5">
            {doc.char_count.toLocaleString()} chars · {doc.chunk_count} chunks ·{' '}
            {new Date(doc.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>
        </div>

        {/* Status badge */}
        <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border shrink-0 ${sc.bg} ${sc.color}`}>
          <StatusIcon className={`w-3.5 h-3.5 ${doc.status === 'pending' ? 'animate-spin' : ''}`} />
          {sc.label}
        </span>

        {doc.status === 'error' && (
          <button
            onClick={() => onReindex(doc.id)}
            title="Retry indexing"
            className="text-xs px-2.5 py-1 rounded-lg border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100 transition-colors shrink-0"
          >
            Retry
          </button>
        )}

        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
          title="Delete document"
        >
          {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      </div>

      {open && doc.error && (
        <div className="border-t border-red-100 px-4 py-3 bg-red-50">
          <p className="text-xs font-semibold text-red-700 mb-0.5">Indexing error</p>
          <p className="text-xs text-red-600 font-mono">{doc.error}</p>
        </div>
      )}
    </div>
  )
}

const TEMPLATE = `COMPANY: [Your Brand Name]
LOCATION: [City] | Pan India Delivery
CONTACT: +91-XXXXXXXXXX | email@domain.com

ABOUT US:
[2-3 sentences about your company, what you sell, and what makes you unique.]

PRODUCTS & PRICING:
- [Category 1]: ₹X,XXX – ₹XX,XXX
- [Category 2]: ₹X,XXX – ₹XX,XXX

DELIVERY:
- Standard: X–Y business days
- Free shipping above: ₹XX,XXX

PAYMENT TERMS:
- [e.g. 50% advance, balance on delivery]

WARRANTY:
- [e.g. 1-year manufacturing warranty]

FREQUENTLY ASKED QUESTIONS:
Q: [Most common question]
A: [Answer]

Q: [Second common question]
A: [Answer]`

export function KnowledgeBase() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [title, setTitle] = useState('')
  const [rawText, setRawText] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/agent/knowledge')
      if (res.ok) setDocs(await res.json())
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  // Poll every 3s if any doc is in 'pending' state
  useEffect(() => {
    const hasPending = docs.some(d => d.status === 'pending')
    if (hasPending) {
      pollRef.current = setInterval(fetchDocs, 3000)
    } else {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [docs, fetchDocs])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''))
    const reader = new FileReader()
    reader.onload = (ev) => setRawText(ev.target?.result as string ?? '')
    reader.readAsText(file)
  }

  const handleUpload = async () => {
    setError(null)
    if (!title.trim()) { setError('Please enter a document title.'); return }
    if (!rawText.trim()) { setError('Please paste text or upload a file.'); return }

    setUploading(true)
    try {
      const res = await fetch('/api/whatsapp/agent/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), raw_text: rawText }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Upload failed')
      }
      setTitle('')
      setRawText('')
      setShowUpload(false)
      await fetchDocs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/whatsapp/agent/knowledge/${id}`, { method: 'DELETE' })
      setDocs(prev => prev.filter(d => d.id !== id))
    } catch {
      alert('Failed to delete document.')
    }
  }

  const handleReindex = async (id: string) => {
    try {
      await fetch(`/api/whatsapp/agent/knowledge/${id}`, { method: 'POST' })
      setDocs(prev => prev.map(d => d.id === id ? { ...d, status: 'pending' } : d))
    } catch {
      // ignore
    }
  }

  const indexedCount = docs.filter(d => d.status === 'indexed').length
  const pendingCount = docs.filter(d => d.status === 'pending').length
  const totalChars   = docs.reduce((s, d) => s + d.char_count, 0)

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-accent" />
            Knowledge Base
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Upload your company info, FAQs, and product catalogue. The AI answers only from this content.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchDocs}
            className="p-1.5 rounded-lg border border-border text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowUpload(v => !v)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent text-white text-sm font-semibold hover:bg-accent/90 active:scale-[0.98] transition-all"
          >
            <Plus className="w-4 h-4" />
            Add Document
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-xl bg-surface border border-border text-center">
          <p className="text-2xl font-bold text-accent">{indexedCount}</p>
          <p className="text-[11px] text-muted mt-0.5">Indexed Docs</p>
        </div>
        <div className="p-3 rounded-xl bg-surface border border-border text-center">
          <p className={`text-2xl font-bold ${pendingCount > 0 ? 'text-yellow-600' : 'text-foreground'}`}>{pendingCount}</p>
          <p className="text-[11px] text-muted mt-0.5">Processing</p>
        </div>
        <div className="p-3 rounded-xl bg-surface border border-border text-center">
          <p className="text-2xl font-bold text-foreground">{(totalChars / 1000).toFixed(1)}k</p>
          <p className="text-[11px] text-muted mt-0.5">Total Chars</p>
        </div>
      </div>

      {/* Upload panel */}
      {showUpload && (
        <div className="p-4 rounded-xl border border-accent/30 bg-accent/5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Upload className="w-4 h-4 text-accent" />
              Add New Knowledge Document
            </p>
            <button
              onClick={() => setShowUpload(false)}
              className="text-xs text-muted hover:text-foreground px-2 py-1 rounded-lg hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">
              Document Title
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Company Info, Product Catalogue, FAQ"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
            />
          </div>

          {/* File upload */}
          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">
              Upload File (optional)
            </label>
            <div
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-dashed border-border hover:border-accent/50 cursor-pointer transition-colors bg-surface"
            >
              <Upload className="w-5 h-5 text-muted" />
              <span className="text-sm text-muted">Click to upload .txt file</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.csv"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Text area */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-muted uppercase tracking-wider">
                Knowledge Text
              </label>
              {!rawText && (
                <button
                  onClick={() => setRawText(TEMPLATE)}
                  className="text-xs text-accent hover:underline"
                >
                  Use template
                </button>
              )}
            </div>
            <textarea
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              rows={12}
              placeholder="Paste your company info, FAQs, product details…"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors resize-y font-mono text-xs leading-relaxed"
            />
            <p className="text-[11px] text-muted mt-1">
              {rawText.length.toLocaleString()} / 500,000 chars · ~{Math.ceil(rawText.length / 512)} chunks estimated
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-semibold hover:bg-accent/90 active:scale-[0.98] transition-all disabled:opacity-60"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />}
              {uploading ? 'Uploading & Indexing…' : 'Upload & Index'}
            </button>
          </div>
        </div>
      )}

      {/* Document list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading documents…
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-14 text-muted border border-dashed border-border rounded-xl">
          <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">No knowledge documents yet</p>
          <p className="text-xs mt-1">Add your company info so the AI can answer customer questions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map(doc => (
            <DocRow
              key={doc.id}
              doc={doc}
              onDelete={handleDelete}
              onReindex={handleReindex}
            />
          ))}
        </div>
      )}

      {/* Tip */}
      <div className="flex items-start gap-2 p-3 rounded-xl bg-surface border border-border text-xs text-muted">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-accent" />
        <span>
          <strong className="text-foreground">Tip:</strong> Keep each document focused on one topic.
          Separate your product catalogue, FAQ, and delivery policy into different docs for better retrieval accuracy.
        </span>
      </div>
    </div>
  )
}
