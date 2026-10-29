'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2, XCircle, Loader2, ExternalLink,
  Zap, RotateCcw, ChevronDown,
  Key, Webhook, BookOpen, Eye, EyeOff, Copy, Instagram,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { confirmDialog } from '@/components/AlertToastProvider';

const MASKED = '••••••••••••••••'

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown'

type ConfigData = {
  id: string
  ig_account_id: string
  page_id: string
  page_name: string | null
  ig_username: string | null
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
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 sm:px-5 py-3.5 sm:py-4 text-left hover:bg-surface-hover transition-colors">
        <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg shrink-0"
          style={{ background: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)' }}>
          <Icon className="size-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description && <p className="text-xs text-muted mt-0.5 truncate">{description}</p>}
        </div>
        <ChevronDown className={`size-4 text-muted transition-transform duration-200 shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border px-4 sm:px-5 py-4 space-y-4">{children}</div>
      )}
    </div>
  )
}

function SetupStep({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface-hover transition-colors">
        <span className="flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white shrink-0"
          style={{ background: 'linear-gradient(135deg, #833ab4, #fd1d1d)' }}>{step}</span>
        <span className="text-sm font-medium text-foreground flex-1">{title}</span>
        <ChevronDown className={`size-3.5 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5 text-sm text-muted">{children}</div>
      )}
    </div>
  )
}

export function InstagramConfig() {
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

  const [igAccountId, setIgAccountId] = useState('')
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
      const res = await fetch('/api/social/config/instagram', { cache: 'no-store' })
      if (res.status === 401) { setLoading(false); return }
      const data = await res.json()
      setStatus(data.connected ? 'connected' : 'disconnected')
      setStatusMessage(data.reason ?? '')
      const cfg = data.config ?? null
      setConfig(cfg)
      if (cfg && !isDirtyRef.current) {
        setIgAccountId(cfg.ig_account_id ?? '')
        setPageId(cfg.page_id ?? '')
        setAccessToken(cfg.has_access_token ? MASKED : '')
        setAppSecret(cfg.has_app_secret ? MASKED : '')
        setVerifyToken(cfg.verify_token ?? '')
        setTokenEdited(false)
        setSecretEdited(false)
      }
    } catch {
      toast.error('Failed to load Instagram configuration')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading && user) fetchConfig()
    else if (!authLoading) setLoading(false)
  }, [authLoading, user, fetchConfig])

  async function handleSave() {
    if (!igAccountId.trim()) { toast.error('Instagram Business Account ID is required'); return }
    if (!pageId.trim()) { toast.error('Linked Facebook Page ID is required'); return }
    if (!tokenEdited || accessToken === MASKED) { toast.error('Please enter the Page Access Token'); return }

    try {
      setSaving(true)
      const payload: Record<string, unknown> = {
        ig_account_id: igAccountId.trim(),
        page_id: pageId.trim(),
        verify_token: verifyToken.trim() || null,
      }
      if (tokenEdited && accessToken !== MASKED && accessToken.trim()) {
        payload.page_access_token = accessToken.trim()
      } else {
        toast.error('Access Token is required'); setSaving(false); return
      }
      if (secretEdited && appSecret !== MASKED && appSecret.trim()) {
        payload.app_secret = appSecret.trim()
      }

      const res = await fetch('/api/social/config/instagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? 'Save failed'); return }
      toast.success(data.message ?? 'Instagram configuration saved!')
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
      const res = await fetch('/api/social/config/instagram')
      const data = await res.json()
      if (data.connected) {
        setStatus('connected'); setStatusMessage('')
        toast.success(data.config?.ig_username ? `Connected to @${data.config.ig_username}` : 'Connection OK')
      } else {
        setStatus('disconnected'); setStatusMessage(data.reason ?? '')
        toast.error(data.reason ?? 'Connection failed')
      }
    } catch { toast.error('Test failed') } finally { setTesting(false) }
  }

  async function handleReset() {
    if (!await confirmDialog('Delete Instagram configuration?')) return
    try {
      setResetting(true)
      await fetch('/api/social/config/instagram', { method: 'DELETE' })
      toast.success('Configuration cleared')
      setConfig(null); setIgAccountId(''); setPageId('')
      setAccessToken(''); setAppSecret(''); setVerifyToken('')
      setTokenEdited(false); setSecretEdited(false)
      setStatus('disconnected'); setStatusMessage('')
    } catch { toast.error('Reset failed') } finally { setResetting(false) }
  }

  const igGradient = 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)'

  if (loading) {
    return <div className="flex items-center justify-center py-12">
      <Loader2 className="size-6 animate-spin" style={{ color: '#fd1d1d' }} />
    </div>
  }

  return (
    <div className="space-y-4 mt-2">
      {/* Status banner */}
      <div className="glass-card flex items-center gap-3 px-4 sm:px-5 py-3.5"
        style={{ borderColor: status === 'connected' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.2)' }}>
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
            {status === 'connected'
              ? `Connected — ${config?.ig_username ? `@${config.ig_username}` : 'Instagram Business Account'}`
              : 'Not Connected'}
          </p>
          <p className="text-xs text-muted mt-0.5">
            {status === 'connected'
              ? 'Instagram DMs are active. Your AI chatbot will reply to messages.'
              : statusMessage || 'Enter your Instagram Business credentials below to connect.'}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* Form */}
        <div className="space-y-4">
          <Section icon={Key} title="API Credentials" description="Instagram Business credentials from Meta Developer Portal">
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Instagram Business Account ID</Label>
                <Input placeholder="e.g. 17841400000000000" value={igAccountId}
                  onChange={(e) => { setIgAccountId(e.target.value); isDirtyRef.current = true }} />
                <p className="text-[11px] text-muted">Found in Meta Business Suite → Instagram Account → About.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Linked Facebook Page ID</Label>
                <Input placeholder="e.g. 123456789012345" value={pageId}
                  onChange={(e) => { setPageId(e.target.value); isDirtyRef.current = true }} />
                <p className="text-[11px] text-muted">The Facebook Page linked to your Instagram Business Account.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Page Access Token</Label>
                <div className="relative">
                  <Input type={showToken ? 'text' : 'password'}
                    placeholder="Enter permanent Page Access Token"
                    value={accessToken}
                    onChange={(e) => { setAccessToken(e.target.value); setTokenEdited(true); isDirtyRef.current = true }}
                    onFocus={() => { if (accessToken === MASKED) { setAccessToken(''); setTokenEdited(true) } }}
                    className="pr-10" />
                  <button type="button" onClick={() => setShowToken(!showToken)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1">
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted">Same as your Facebook Page token — used for sending Instagram DMs.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">App Secret <span className="text-muted">(optional)</span></Label>
                <div className="relative">
                  <Input type={showSecret ? 'text' : 'password'}
                    placeholder="Recommended for webhook signature verification"
                    value={appSecret}
                    onChange={(e) => { setAppSecret(e.target.value); setSecretEdited(true); isDirtyRef.current = true }}
                    onFocus={() => { if (appSecret === MASKED) { setAppSecret(''); setSecretEdited(true) } }}
                    className="pr-10" />
                  <button type="button" onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1">
                    {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Webhook Verify Token</Label>
                <Input placeholder="e.g. kosmic_ig_2024" value={verifyToken}
                  onChange={(e) => { setVerifyToken(e.target.value); isDirtyRef.current = true }} />
              </div>
            </div>
          </Section>

          <Section icon={Webhook} title="Webhook URL" description="Use this URL in Meta webhook settings" defaultOpen={false}>
            <div className="space-y-1.5">
              <Label className="text-foreground text-xs sm:text-sm">Callback URL</Label>
              <div className="flex gap-2">
                <Input readOnly value={webhookUrl} className="font-mono text-xs flex-1" />
                <Button variant="outline" size="icon"
                  onClick={() => { navigator.clipboard.writeText(webhookUrl); toast.success('Copied!') }}
                  className="shrink-0 border-border text-foreground hover:bg-surface-light">
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-[11px] text-muted">Subscribe to the <strong>messages</strong> field for the Instagram product.</p>
            </div>
          </Section>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <Button onClick={handleSave} disabled={saving} className="text-white flex-1 sm:flex-none"
              style={{ background: igGradient }}>
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
          <Section icon={Instagram} title="Setup Guide" description="How to connect Instagram DMs">
            <div className="space-y-2">
              <SetupStep step={1} title="Link Instagram to Facebook Page">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Go to Meta Business Suite</li>
                  <li>Link your Instagram Business Account to a Facebook Page</li>
                  <li>You need a Business (not personal) IG account</li>
                </ol>
              </SetupStep>
              <SetupStep step={2} title="Create a Meta App">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Go to <span className="font-medium">developers.facebook.com</span></li>
                  <li>Create a Business type app</li>
                  <li>Add the <strong>Instagram</strong> product</li>
                </ol>
              </SetupStep>
              <SetupStep step={3} title="Get Your IDs">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>IG Account ID: Meta Business Suite → Instagram → About</li>
                  <li>Page ID: Facebook Page Settings → About → Page Transparency</li>
                  <li>Page Access Token: Business Settings → System Users → Generate Token</li>
                </ol>
              </SetupStep>
              <SetupStep step={4} title="Configure Webhooks">
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>In your app, go to Instagram → Webhooks</li>
                  <li>Paste the Webhook URL from above</li>
                  <li>Subscribe to <strong>messages</strong> field</li>
                  <li>Grant <code>instagram_manage_messages</code> permission</li>
                </ol>
              </SetupStep>
            </div>
            <div className="pt-3 border-t border-border">
              <a href="https://developers.facebook.com/docs/messenger-platform/instagram"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs hover:underline"
                style={{ color: '#833ab4' }}>
                <ExternalLink className="size-3.5" />
                Instagram Messenger Platform Docs
              </a>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
