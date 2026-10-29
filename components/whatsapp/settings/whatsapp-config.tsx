'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  ChevronDown,
  Key,
  Webhook,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmDialog } from '@/components/AlertToastProvider';

const MASKED_TOKEN = '••••••••••••••••';
const DRAFT_STORAGE_KEY = 'wa-config-draft';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

type StoredConfig = {
  id: string;
  phone_number_id: string;
  waba_id?: string | null;
  status: 'connected' | 'disconnected';
  connected_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  has_access_token: boolean;
};

type ConfigResponse = {
  connected: boolean;
  config: StoredConfig | null;
  reason?: string;
  message?: string;
  needs_reset?: boolean;
  phone_info?: { verified_name?: string };
};

/* ─── Collapsible Section ────────────────────────────────────── */
function Section({
  icon: Icon,
  title,
  description,
  defaultOpen = true,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
          {description && (
            <p className="text-xs text-muted mt-0.5 truncate">{description}</p>
          )}
        </div>
        <ChevronDown
          className={`size-4 text-muted transition-transform duration-200 shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-4 sm:px-5 py-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Setup Step ─────────────────────────────────────────────── */
function SetupStep({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface-hover transition-colors"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-white shrink-0">
          {step}
        </span>
        <span className="text-sm font-medium text-foreground flex-1">{title}</span>
        <ChevronDown
          className={`size-3.5 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5 text-sm text-muted">
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────────── */

export function WhatsAppConfig() {
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<StoredConfig | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const isDirtyRef = useRef(false);

  const markDirty = useCallback(() => {
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      setIsDirty(true);
    }
  }, []);

  const saveDraft = useCallback((next: Record<string, unknown>) => {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
      const existing = raw ? JSON.parse(raw) : {};
      const merged = { ...existing, ...next };
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // Best-effort draft storage only.
    }
  }, []);

  const clearDraft = useCallback(() => {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  }, []);

  const notifyConfigUpdated = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event('wa-config-updated'));
  }, []);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'GET',
        cache: 'no-store',
      });
      const payload = (await res.json()) as ConfigResponse;

      if (!res.ok) {
        if (res.status !== 401) {
          toast.error(payload?.message || 'Failed to load WhatsApp configuration');
        }
        setConfig(null);
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
        return;
      }

      const shouldHydrate = !isDirtyRef.current;
      const nextConfig = payload.config ?? null;

      if (nextConfig) {
        setConfig(nextConfig);
        if (shouldHydrate) {
          setPhoneNumberId(nextConfig.phone_number_id || '');
          setWabaId(nextConfig.waba_id || '');
          setAccessToken(nextConfig.has_access_token ? MASKED_TOKEN : '');
          setVerifyToken('');
          setTokenEdited(false);
        }
      } else {
        setConfig(null);
        if (shouldHydrate) {
          setPhoneNumberId('');
          setWabaId('');
          setAccessToken('');
          setVerifyToken('');
          setTokenEdited(false);
        }
      }

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
      } else {
        setConnectionStatus('disconnected');
        setResetReason(
          payload.needs_reset
            ? 'token_corrupted'
            : payload.reason === 'meta_api_error'
              ? 'meta_api_error'
              : null
        );
        setStatusMessage(payload.message || '');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setDraftReady(true);
      return;
    }

    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) {
      setDraftReady(true);
      return;
    }

    try {
      const saved = JSON.parse(raw) as {
        phoneNumberId?: string;
        wabaId?: string;
        accessToken?: string;
        verifyToken?: string;
      };

      if (typeof saved.phoneNumberId === 'string') {
        setPhoneNumberId(saved.phoneNumberId);
      }
      if (typeof saved.wabaId === 'string') {
        setWabaId(saved.wabaId);
      }
      if (typeof saved.verifyToken === 'string') {
        setVerifyToken(saved.verifyToken);
      }
      if (typeof saved.accessToken === 'string' && saved.accessToken) {
        setAccessToken(saved.accessToken);
        setTokenEdited(true);
      }

      if (
        saved.phoneNumberId ||
        saved.wabaId ||
        saved.verifyToken ||
        saved.accessToken
      ) {
        isDirtyRef.current = true;
        setIsDirty(true);
      }
    } catch {
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    } finally {
      setDraftReady(true);
    }
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    if (authLoading) return;
    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    fetchConfig();
  }, [authLoading, user, fetchConfig, draftReady]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config, token not re-entered — require it so API can save
        toast.error('Please re-enter the Access Token to update your configuration.');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      // Config saved — show success. If Meta verification had a warning, show that too.
      if (data.meta_warning) {
        toast.warning(data.meta_warning);
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Connected to ${data.phone_info.verified_name}`
            : 'Configuration saved successfully'
        );
      }

      clearDraft();
      isDirtyRef.current = false;
      setIsDirty(false);

      if (user) await fetchConfig();
      notifyConfigUpdated();
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
      notifyConfigUpdated();
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
      notifyConfigUpdated();
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    if (!await confirmDialog('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      clearDraft();
      isDirtyRef.current = false;
      setIsDirty(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
      notifyConfigUpdated();
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-accent" />
      </div>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <div className="space-y-4 mt-2">
      {/* Connection Status Banner */}
      <div
        className={`glass-card flex items-center gap-3 px-4 sm:px-5 py-3.5 ${connectionStatus === 'connected'
            ? 'border-green-500/30 bg-green-50/50'
            : 'border-red-500/20 bg-red-50/30'
          }`}
        style={{
          borderColor:
            connectionStatus === 'connected'
              ? 'rgba(34,197,94,0.3)'
              : 'rgba(239,68,68,0.2)',
        }}
      >
        {connectionStatus === 'connected' ? (
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
            {connectionStatus === 'connected' ? 'Connected' : 'Not Connected'}
          </p>
          <p className="text-xs text-muted mt-0.5 line-clamp-2">
            {connectionStatus === 'connected'
              ? 'WhatsApp Business API is connected and ready.'
              : statusMessage ||
              'Configure your Meta API credentials below to connect.'}
          </p>
        </div>
      </div>

      {/* Corrupted-token reset banner */}
      {showResetBanner && (
        <div className="glass-card flex flex-col sm:flex-row sm:items-center gap-3 px-4 sm:px-5 py-3.5 border-amber-400/30"
          style={{ borderColor: 'rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.04)' }}
        >
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="flex size-8 items-center justify-center rounded-full bg-amber-100 shrink-0">
              <AlertTriangle className="size-4 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                Stored token can&apos;t be decrypted
              </p>
              <p className="text-xs text-muted mt-0.5">{statusMessage}</p>
            </div>
          </div>
          <Button
            onClick={handleReset}
            disabled={resetting}
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 text-white shrink-0 w-full sm:w-auto"
          >
            {resetting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Resetting...
              </>
            ) : (
              <>
                <RotateCcw className="size-4" />
                Reset Configuration
              </>
            )}
          </Button>
        </div>
      )}

      {/* Two-column layout: form + sidebar (stacks on mobile) */}
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* LEFT — Config form */}
        <div className="space-y-4">
          {/* API Credentials */}
          <Section
            icon={Key}
            title="API Credentials"
            description="Meta WhatsApp Business API credentials"
          >
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Phone Number ID</Label>
                <Input
                  placeholder="e.g. 100234567890123"
                  value={phoneNumberId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setPhoneNumberId(value);
                    markDirty();
                    saveDraft({ phoneNumberId: value });
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">
                  WhatsApp Business Account ID
                </Label>
                <Input
                  placeholder="e.g. 100234567890456"
                  value={wabaId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setWabaId(value);
                    markDirty();
                    saveDraft({ wabaId: value });
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Permanent Access Token</Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder="Enter your access token"
                    value={accessToken}
                    onChange={(e) => {
                      const value = e.target.value;
                      setAccessToken(value);
                      setTokenEdited(true);
                      markDirty();
                      saveDraft({ accessToken: value });
                    }}
                    onFocus={() => {
                      if (accessToken === MASKED_TOKEN) {
                        setAccessToken('');
                        setTokenEdited(true);
                        markDirty();
                        saveDraft({ accessToken: '' });
                      }
                    }}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-colors p-1"
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {config && !tokenEdited && (
                  <p className="text-[11px] text-muted">
                    Token is hidden for security. Re-enter it to update configuration.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground text-xs sm:text-sm">Webhook Verify Token</Label>
                <Input
                  placeholder="Create a custom verify token"
                  value={verifyToken}
                  onChange={(e) => {
                    const value = e.target.value;
                    setVerifyToken(value);
                    markDirty();
                    saveDraft({ verifyToken: value });
                  }}
                />
                <p className="text-[11px] text-muted">
                  A custom string you create. Must match the token in Meta webhook settings.
                </p>
              </div>
            </div>
          </Section>

          {/* Webhook URL */}
          <Section
            icon={Webhook}
            title="Webhook Configuration"
            description="Use this URL as your webhook callback"
            defaultOpen={false}
          >
            <div className="space-y-1.5">
              <Label className="text-foreground text-xs sm:text-sm">Webhook Callback URL</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="font-mono text-xs sm:text-sm flex-1 min-w-0"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-foreground hover:text-foreground hover:bg-surface-light"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </Section>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-2.5">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-accent hover:bg-accent-hover text-white flex-1 sm:flex-none"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Configuration'
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !config}
              className="border-border text-foreground hover:text-foreground hover:bg-surface-light flex-1 sm:flex-none"
            >
              {testing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  Test Connection
                </>
              )}
            </Button>
            {config && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting}
                className="border-red-200 text-red-600 hover:text-red-700 hover:bg-red-50 flex-1 sm:flex-none"
              >
                {resetting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    Reset
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* RIGHT — Setup Instructions Sidebar */}
        <div>
          <Section
            icon={BookOpen}
            title="Setup Guide"
            description="How to connect your WhatsApp API"
            defaultOpen={true}
          >
            <div className="space-y-2">
              <SetupStep step={1} title="Create a Meta App">
                <ol className="list-decimal list-inside space-y-1 text-xs sm:text-sm">
                  <li>Go to <span className="text-accent font-medium">developers.facebook.com</span></li>
                  <li>Click &quot;My Apps&quot; and then &quot;Create App&quot;</li>
                  <li>Select &quot;Business&quot; as the app type</li>
                  <li>Fill in app details and create</li>
                </ol>
              </SetupStep>

              <SetupStep step={2} title="Add WhatsApp Product">
                <ol className="list-decimal list-inside space-y-1 text-xs sm:text-sm">
                  <li>In your app dashboard, click &quot;Add Product&quot;</li>
                  <li>Find &quot;WhatsApp&quot; and click &quot;Set Up&quot;</li>
                  <li>Follow the setup wizard to link your business</li>
                </ol>
              </SetupStep>

              <SetupStep step={3} title="Get API Credentials">
                <ol className="list-decimal list-inside space-y-1 text-xs sm:text-sm">
                  <li>Go to WhatsApp &gt; API Setup</li>
                  <li>Copy your <strong className="text-foreground">Phone Number ID</strong></li>
                  <li>Copy your <strong className="text-foreground">WhatsApp Business Account ID</strong></li>
                  <li>Generate a <strong className="text-foreground">Permanent Access Token</strong> from Business Settings &gt; System Users</li>
                </ol>
              </SetupStep>

              <SetupStep step={4} title="Configure Webhooks">
                <ol className="list-decimal list-inside space-y-1 text-xs sm:text-sm">
                  <li>Go to WhatsApp &gt; Configuration</li>
                  <li>Click &quot;Edit&quot; on the Webhook section</li>
                  <li>Paste the <strong className="text-foreground">Webhook Callback URL</strong> from above</li>
                  <li>Enter the same <strong className="text-foreground">Verify Token</strong> you set here</li>
                  <li>Subscribe to &quot;messages&quot; webhook field</li>
                </ol>
              </SetupStep>
            </div>

            <div className="pt-3 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-accent hover:text-accent-hover transition-colors"
              >
                <ExternalLink className="size-3.5" />
                Meta WhatsApp API Documentation
              </a>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
