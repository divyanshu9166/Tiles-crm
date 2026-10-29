'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2, XCircle, Loader2, ExternalLink,
  Zap, AlertTriangle, RotateCcw, ChevronDown,
  Key, Webhook, BookOpen, Eye, EyeOff, Copy,
  Facebook,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { confirmDialog } from '@/components/AlertToastProvider';

const MASKED = '••••••••••••••••'
const DRAFT_KEY = 'fb-config-draft'

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown'

type ConfigData = {
  id: string
  page_id: string
  page_name: string | null
  status: string
  has_access_token: boolean
  has_app_secret: boolean
  verify_token: string | null
  connected_at: string | null
}

function Section({
  icon: Icon, title, description, defaultOpen = true, children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="glass-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 sm:px-5 py-3.5 sm:py-4 text-left hover:bg-surface-hover transition-colors"
      >
        <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg bg-accent-light shrink-0">
          <Icon className="size-4 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description && <p className="text-xs text-muted mt-0.5 truncate">{description}</p>}
        </div>
        <ChevronDown className={`size-4 text-muted transition-transform duration-200 shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border px-4 sm:px-5 py-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  )
}

function SetupStep({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface-hover transition-colors"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-[#1877f2] text-[10px] font-bold text-white shrink-0">{step}</span>
        <span className="text-sm font-medium text-foreground flex-1">{title}</span>
        <ChevronDown className={`size-3.5 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5 text-sm text-muted">{children}</div>
      )}
    </div>
  )
}

export function FacebookConfig() {
  const { user, loading: authLoading } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [config, setConfig] = useState<ConfigData | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('unknown')
  const [statusMessage, setStatusMessage] = useState('')

  const [pageId, setPageId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [verifyToken, setVerifyToken] = useState('')
  const [tokenEdited, setTokenEdited] = useState(false)
  const [secretEdited, setSecretEdited] = useState(false)
  const isDirtyRef = useRef(false)

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/social/webhook`
    : ''

  const fetchConfig = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/social/config/facebook', { cache: 'no-store' })
      if (res.status === 401) { setLoading(false); return }
      const data = await res.json()
      setStatus(data.connected ? 'connected' : 'disconnected')
      setStatusMessage(data.reason ?? '')
      const cfg = data.config ?? null
      setConfig(cfg)
      if (cfg && !isDirtyRef.current) {
        setPageId(cfg.page_id ?? '')
        setAccessToken(cfg.has_access_token ? MASKED : '')
        setAppSecret(cfg.has_app_secret ? MASKED : '')
        setVerifyToken(cfg.verify_token ?? '')
        setTokenEdited(false)
        setSecretEdited(false)
      }
    } catch {
      toast.error('Failed to load Facebook configuration')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading && user) fetchConfig()
    else if (!authLoading) setLoading(false)
  }, [authLoading, user, fetchConfig])

  async function handleSave() {
    if (!pageId.trim()) { toast.error('Page ID is required'); return }
    if (!config && !tokenEdited) { toast.error('Page Access Token is required'); return }
    if (!tokenEdited && config) {
      toast.error('Please re-enter the Access Token to update'); return
    }

    try {
      setSaving(true)
      const payload: Record<string, unknown> = {
        page_id: pageId.trim(),
        verify_token: verifyToken.trim() || null,
      }
      if (tokenEdited && accessToken !== MASKED && accessToken.trim()) {
        payload.page_access_token = accessToken.trim()
      } else if (!config) {
        toast.error('Access Token is required'); setSaving(false); return
      }
      if (secretEdited && appSecret !== MASKED && appSecret.trim()) {
        payload.app_secret = appSecret.trim()
      }

      const res = await fetch('/api/social/config/facebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? 'Failed to save'); return }
      toast.success(data.message ?? 'Facebook configuration saved!')
      isDirtyRef.current = false
      await fetchConfig()
    } catch {
      toast.error('Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const res = await fetch('/api/social/config/facebook')
      const data = await res.json()
      if (data.connected) {
        setStatus('connected'); setStatusMessage('')
        toast.success(data.config?.page_name ? `Connected to "${data.config.page_name}"` : 'Connection OK')
      } else {
        setStatus('disconnected'); setStatusMessage(data.reason ?? '')
        toast.error(data.reason ?? 'Connection failed')
      }
    } catch { toast.error('Test failed') } finally { setTesting(false) }
  }

  async function handleReset() {
    if (!await confirmDialog('Delete Facebook configuration? This cannot be undone.')) return
    try {
      setResetting(true)
      await fetch('/api/social/config/facebook', { method: 'DELETE' })
      toast.success('Configuration cleared')
      setConfig(null); setPageId(''); setAccessToken(''); setAppSecret('')
      setVerifyToken(''); setTokenEdited(false); setSecretEdited(false)
      setStatus('disconnected'); setStatusMessage('')
    } catch { toast.error('Reset failed') } finally { setResetting(false) }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="size-6 animate-spin text-[#1877f2]" /></div>
  }

  return (
    <div className="space-y-4 mt-2">
      {/* Status banner */}
      <div
        className="glass-card flex items-center gap-3 px-4 sm:px-5 py-3.5"
        style={{ borderColor: status === 'connected' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.2)' }}
      >
        {status === 'connected' ? (
          <div className="flex size-8 items-center justify-center rounded-full bg-green-100 shrink-0">
            <CheckCircle2 className="size-4 text-green-600" />
          </div>
        ) : (
          <div className="flex size-8 items-center justify-center rounded-full bg-red-100 shrink-0">
            <XCircle className="size-4 text-red-500" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {status === 'connected' ? `Connected — ${config?.page_name ?? 'Facebook Page'}` : 'Not Connected'}
          </p>
          <p className="text-xs text-muted mt-0.5">
            {status === 'connected'
              ? 'Facebook Page messaging is active. Your AI chatbot will reply to DMs.'
              : statusMessage || 'Enter your Facebook Page credentials below to connect.'}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* Form */}
        <div className="space-y-4">
          <Section icon={Key} title="API Credentials" description="Facebook Page credentials from Meta Developer Portal">
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Facebook Page ID</Label>
                <Input
                  placeholder="e.g. 123456789012345"
                  value={pageId}
                  onChange={(e) => { setPageId(e.target.value); isDirtyRef.current = true }}
                />
                <p className="text-[11px] text-muted">Found in your Facebook Page settings or Meta Business Suite.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Page Access Token</Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder="Enter permanent Page Access Token"
                    value={accessToken}
                    onChange={(e) => { setAccessToken(e.target.value); setTokenEdited(true); isDirtyRef.current = true }}
                    onFocus={() => { if (accessToken === MASKED) { setAccessToken(''); setTokenEdited(true) } }}
                    className="pr-10"
                  />
                  <button type="button" onClick={() => setShowToken(!showToken)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1">
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted">Generate a permanent token via Meta Business Settings → System Users.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">App Secret <span className="text-muted">(optional but recommended)</span></Label>
                <div className="relative">
                  <Input
                    type={showSecret ? 'text' : 'password'}
                    placeholder="Enter App Secret for webhook signature verification"
                    value={appSecret}
                    onChange={(e) => { setAppSecret(e.target.value); setSecretEdited(true); isDirtyRef.current = true }}
                    onFocus={() => { if (appSecret === MASKED) { setAppSecret(''); setSecretEdited(true) } }}
                    className="pr-10"
                  />
                  <button type="button" onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1">
                    {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Webhook Verify Token</Label>
                <Input
                  placeholder="Create a custom verify token (e.g. kosmic_fb_2024)"
                  value={verifyToken}
                  onChange={(e) => { setVerifyToken(e.target.value); isDirtyRef.current = true }}
                />
                <p className="text-[11px] text-muted">Must match exactly what you enter in Meta webhook settings.</p>
              </div>
            </div>
          </Section>

          <Section icon={Webhook} title="Webhook URL" description="Paste this in Meta webhook settings" defaultOpen={false}>
            <div className="space-y-1.5">
              <Label className="text-foreground text-xs sm:text-sm">Callback URL</Label>
              <div className="flex gap-2">
                <Input readOnly value={webhookUrl} className="font-mono text-xs flex-1" />
                <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(webhookUrl); toast.success('Copied!') }}
                  className="shrink-0 border-border text-foreground hover:bg-surface-light">
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-[11px] text-muted">Subscribe to the <strong>messages</strong> webhook field.</p>
            </div>
          </Section>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <Button onClick={handleSave} disabled={saving}
              className="text-white flex-1 sm:flex-none"
              style={{ backgroundColor: '#1877f2' }}>
              {saving ? <><Loader2 className="size-4 animate-spin" /> Saving...</> : 'Save Configuration'}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !config}
              className="border-border text-foreground hover:bg-surface-light flex-1 sm:flex-none">
              {testing ? <><Loader2 className="size-4 animate-spin" /> Testing...</> : <><Zap className="size-4" /> Test Connection</>}
            </Button>
            {config && (
              <Button variant="outline" onClick={handleReset} disabled={resetting}
                className="border-red-200 text-red-600 hover:bg-red-50 flex-1 sm:flex-none">
                {resetting ? <><Loader2 className="size-4 animate-spin" /> Resetting...</> : <><RotateCcw className="size-4" /> Reset</>}
              </Button>
            )}
          </div>
        </div>

        {/* Setup guide */}
        <div>
          <Section icon={BookOpen} title="Setup Guide" description="How to connect your Facebook Page">
            <div className="space-y-2">
              <SetupStep step={1} title="Create a Meta App">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Go to <span className="text-[#1877f2] font-medium">developers.facebook.com</span></li>
                  <li>Click "My Apps" → "Create App"</li>
                  <li>Choose "Business" type and complete setup</li>
                </ol>
              </SetupStep>
              <SetupStep step={2} title="Add Messenger Product">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>In your app dashboard, click "Add Product"</li>
                  <li>Find "Messenger" and click "Set Up"</li>
                  <li>Link your Facebook Page</li>
                </ol>
              </SetupStep>
              <SetupStep step={3} title="Generate Page Access Token">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Go to Business Settings → System Users</li>
                  <li>Create a System User and assign it to your Page</li>
                  <li>Generate a <strong>Never Expires</strong> token with <code>pages_messaging</code> permission</li>
                </ol>
              </SetupStep>
              <SetupStep step={4} title="Configure Webhooks">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Go to Messenger → Webhooks</li>
                  <li>Paste the Webhook URL from above</li>
                  <li>Enter the same Verify Token</li>
                  <li>Subscribe to <strong>messages</strong> field</li>
                </ol>
              </SetupStep>
            </div>
            <div className="pt-3 border-t border-border">
              <a href="https://developers.facebook.com/docs/messenger-platform/get-started"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[#1877f2] hover:underline">
                <ExternalLink className="size-3.5" />
                Messenger Platform Documentation
              </a>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
