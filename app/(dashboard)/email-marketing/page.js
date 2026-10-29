'use client';

import { useState, useEffect } from 'react';
import {
  Mail, Plus, Send, Eye, MousePointerClick, Users, TrendingUp,
  BarChart3, Clock, Zap, Copy, Trash2, Play, Pause, FlaskConical,
  FileText, Search, Filter, ChevronDown, ChevronRight, ArrowLeft,
  CheckCircle2, XCircle, AlertCircle, RefreshCw, MailOpen, Link2,
  Target, CalendarClock, Bot, Sparkles, LayoutTemplate, PenLine,
} from 'lucide-react';
import Modal from '@/components/Modal';
import {
  getEmailCampaigns, createEmailCampaign, updateEmailCampaign, deleteEmailCampaign,
  sendEmailCampaign, duplicateCampaign, getCampaignAnalytics,
  getEmailTemplates, createEmailTemplate, deleteEmailTemplate,
  getAudienceStats, getEmailConfigStatus,
} from '@/app/actions/email-campaigns';
import Link from 'next/link';
import { getActiveVertical } from '@/lib/brand';
import { confirmDialog } from '@/components/AlertToastProvider';

// ─── Constants ──────────────────────────────────────

const statusConfig = {
  DRAFT: { label: 'Draft', color: 'bg-surface-hover text-muted border border-border', icon: FileText },
  SCHEDULED: { label: 'Scheduled', color: 'bg-amber-500/10 text-amber-500', icon: CalendarClock },
  SENDING: { label: 'Sending', color: 'bg-blue-500/10 text-blue-500', icon: RefreshCw },
  SENT: { label: 'Sent', color: 'bg-success-light text-success', icon: CheckCircle2 },
  PAUSED: { label: 'Paused', color: 'bg-orange-500/10 text-orange-500', icon: Pause },
};

const audienceOptions = [
  { value: 'all', label: 'All Contacts', desc: 'Every subscribed contact with an email', icon: Users },
  { value: 'leads', label: 'Leads Only', desc: 'Contacts who have active leads', icon: Target },
  { value: 'customers', label: 'Customers', desc: 'Contacts who have placed orders', icon: CheckCircle2 },
];

const triggerOptions = [
  { value: 'new_lead', label: 'New Lead Created', desc: 'Send when a new lead is captured', delay: 1 },
  { value: 'post_visit', label: 'After Store Visit', desc: 'Follow-up after walk-in or appointment', delay: 24 },
  { value: 'abandoned_quote', label: 'Abandoned Quote', desc: 'Re-engage when quote has no follow-up (3 days)', delay: 72 },
  { value: 'post_purchase', label: 'Post Purchase', desc: 'Thank you & review request after order delivery', delay: 48 },
];

const templateCategories = ['Promotional', 'Follow-up', 'New Collection', 'Offer', 'Nurture', 'Transactional'];

const FURNITURE_DEFAULT_TEMPLATES = [
  {
    name: 'New Collection Announcement',
    subject: 'Introducing Our Latest {{collectionName}} Collection!',
    category: 'New Collection',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #1a1a1a;">Hello {{customerName}},</h1>
  <p>We're excited to announce our brand new <strong>{{collectionName}}</strong> collection!</p>
  <p>Carefully crafted with premium materials and timeless designs, these pieces are made to transform your living spaces.</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{storeUrl}}" style="background: #8B5CF6; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Explore the Collection</a>
  </div>
  <p style="color: #666;">Visit our showroom or browse online to see what's new.</p>
  <p>Warm regards,<br/>{{storeName}}</p>
</div>`,
    variables: ['customerName', 'collectionName', 'storeUrl', 'storeName'],
  },
  {
    name: 'Exclusive Offer',
    subject: '{{customerName}}, Exclusive {{discountPercent}}% Off Just For You!',
    category: 'Offer',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #1a1a1a;">Special Offer for You, {{customerName}}!</h1>
  <p>As a valued customer, we'd like to offer you an exclusive <strong>{{discountPercent}}% discount</strong> on your next purchase.</p>
  <div style="background: #f8f4ff; border: 2px dashed #8B5CF6; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
    <p style="font-size: 12px; color: #666; margin: 0;">YOUR PROMO CODE</p>
    <p style="font-size: 28px; font-weight: 700; color: #8B5CF6; margin: 8px 0;">{{offerCode}}</p>
    <p style="font-size: 13px; color: #888; margin: 0;">Valid until {{expiryDate}}</p>
  </div>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{storeUrl}}" style="background: #8B5CF6; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Shop Now</a>
  </div>
  <p>Warm regards,<br/>{{storeName}}</p>
</div>`,
    variables: ['customerName', 'discountPercent', 'offerCode', 'expiryDate', 'storeUrl', 'storeName'],
  },
  {
    name: 'Follow-up After Visit',
    subject: 'Great Meeting You, {{customerName}}!',
    category: 'Follow-up',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #1a1a1a;">Thanks for Visiting, {{customerName}}!</h1>
  <p>It was wonderful having you at our showroom. We hope you enjoyed exploring our furniture collection.</p>
  <p>If you have any questions about the pieces you viewed, or need help with measurements and customizations, we're just a call away.</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{storeUrl}}" style="background: #8B5CF6; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Browse Our Catalog</a>
  </div>
  <p style="color: #666;">Need assistance? Call us at {{storePhone}} or reply to this email.</p>
  <p>Best regards,<br/>{{storeName}}</p>
</div>`,
    variables: ['customerName', 'storeUrl', 'storePhone', 'storeName'],
  },
  {
    name: 'Lead Nurture Sequence',
    subject: '{{customerName}}, Still Looking for the Perfect Piece?',
    category: 'Nurture',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #1a1a1a;">Hi {{customerName}},</h1>
  <p>We noticed you were interested in some of our furniture pieces. Finding the right fit for your home is important — we're here to help!</p>
  <h3 style="color: #444;">Why Choose Us?</h3>
  <ul style="color: #555; line-height: 1.8;">
    <li>Handcrafted quality with premium materials</li>
    <li>Custom sizes and finishes available</li>
    <li>Free delivery and professional assembly</li>
    <li>Easy EMI options available</li>
  </ul>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{storeUrl}}" style="background: #8B5CF6; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">View Our Bestsellers</a>
  </div>
  <p>Cheers,<br/>{{storeName}}</p>
</div>`,
    variables: ['customerName', 'storeUrl', 'storeName'],
  },
];

const TGM_DEFAULT_TEMPLATES = [
  {
    name: 'New Surface Collection', subject: 'Explore our latest {{collectionName}} surfaces', category: 'New Collection',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;"><h1>Hello {{customerName}},</h1><p>Our latest <strong>{{collectionName}}</strong> collection of tiles, granite, marble and quartz is now available to view.</p><p>Visit the showroom to compare finish, shade and book-matched slabs in person.</p><p><a href="{{storeUrl}}">Explore the Collection</a></p><p>Warm regards,<br/>{{storeName}}</p></div>`,
    variables: ['customerName', 'collectionName', 'storeUrl', 'storeName'],
  },
  {
    name: 'Surface Selection Offer', subject: '{{customerName}}, an exclusive {{discountPercent}}% offer on your surface selection', category: 'Offer',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;"><h1>Special offer for you, {{customerName}}</h1><p>Use code <strong>{{offerCode}}</strong> for {{discountPercent}}% off eligible tiles and stone selections until {{expiryDate}}.</p><p>Our team can help calculate area, wastage and fabrication requirements before you confirm.</p><p><a href="{{storeUrl}}">Plan Your Visit</a></p><p>{{storeName}}</p></div>`,
    variables: ['customerName', 'discountPercent', 'offerCode', 'expiryDate', 'storeUrl', 'storeName'],
  },
  {
    name: 'Follow-up After Showroom Visit', subject: 'Your tile and stone selections, {{customerName}}', category: 'Follow-up',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;"><h1>Thanks for visiting, {{customerName}}</h1><p>We hope the tile, granite and marble samples helped with your selection. Reply with your approximate area or drawing and we can prepare a measured quotation.</p><p>For natural stone, final shade and vein approval is always from the actual reserved slab.</p><p><a href="{{storeUrl}}">Browse Our Catalog</a></p><p>Best regards,<br/>{{storeName}}</p></div>`,
    variables: ['customerName', 'storeUrl', 'storeName'],
  },
  {
    name: 'Fabrication Lead Follow-up', subject: '{{customerName}}, ready to plan your countertop or cladding?', category: 'Nurture',
    body: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;"><h1>Hi {{customerName}},</h1><p>Our stone team can help with site measurement, slab selection, edge profile, cutouts and installation planning.</p><ul><li>Measured area and wastage guidance</li><li>Lot and shade matching</li><li>Fabrication and installation coordination</li></ul><p><a href="{{storeUrl}}">Book a Surface Consultation</a></p><p>{{storeName}}</p></div>`,
    variables: ['customerName', 'storeUrl', 'storeName'],
  },
];

const defaultTemplates = getActiveVertical() === 'tiles' ? TGM_DEFAULT_TEMPLATES : FURNITURE_DEFAULT_TEMPLATES;

// ─── Main Page Component ────────────────────────────

export default function EmailMarketingPage() {
  const [tab, setTab] = useState('campaigns'); // campaigns | templates | automation | analytics
  const [campaigns, setCampaigns] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [audienceStats, setAudienceStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [emailConfig, setEmailConfig] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Modals
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [campaignAnalytics, setCampaignAnalytics] = useState(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  // Form state
  const [campaignForm, setCampaignForm] = useState({
    name: '', subject: '', body: '', templateId: '', audience: 'all',
    scheduledAt: '', isABTest: false, variantBSubject: '', variantBBody: '',
    abSplitPercent: 50, isAutomated: false, triggerType: '', triggerDelay: '',
  });
  const [templateForm, setTemplateForm] = useState({ name: '', subject: '', body: '', category: 'Promotional', variables: '' });
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    const [cRes, tRes, aRes, ecRes] = await Promise.all([
      getEmailCampaigns(), getEmailTemplates(), getAudienceStats(), getEmailConfigStatus(),
    ]);
    if (cRes.success) setCampaigns(cRes.data);
    if (tRes.success) setTemplates(tRes.data);
    if (aRes.success) setAudienceStats(aRes.data);
    if (ecRes.success) setEmailConfig(ecRes);
  };

  useEffect(() => {
    const timer = setTimeout(() => { void refresh().then(() => setLoading(false)); }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Computed stats
  const sentCampaigns = campaigns.filter(c => c.status === 'SENT');
  const totalSent = sentCampaigns.reduce((s, c) => s + c.sent, 0);
  const totalOpened = sentCampaigns.reduce((s, c) => s + c.opened, 0);
  const totalClicked = sentCampaigns.reduce((s, c) => s + c.clicked, 0);
  const totalBounced = sentCampaigns.reduce((s, c) => s + c.bounced, 0);
  const avgOpenRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0;
  const avgClickRate = totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0;

  // Filtered campaigns
  const filtered = campaigns.filter(c => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.subject.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // ─── Handlers ───────────────────────────────────

  const handleCreateCampaign = async (asDraft) => {
    if (!campaignForm.name || !campaignForm.subject || !campaignForm.body) return;
    setSubmitting(true);
    try {
      const payload = {
        ...campaignForm,
        templateId: campaignForm.templateId ? parseInt(campaignForm.templateId) : undefined,
        triggerDelay: campaignForm.triggerDelay ? parseInt(campaignForm.triggerDelay) : undefined,
        scheduledAt: asDraft ? undefined : campaignForm.scheduledAt || undefined,
      };
      const res = await createEmailCampaign(payload);
      if (res.success) {
        setShowCreateCampaign(false);
        setCampaignForm({ name: '', subject: '', body: '', templateId: '', audience: 'all', scheduledAt: '', isABTest: false, variantBSubject: '', variantBBody: '', abSplitPercent: 50, isAutomated: false, triggerType: '', triggerDelay: '' });
        await refresh();
      } else alert(res.error);
    } finally { setSubmitting(false); }
  };

  const handleCreateTemplate = async () => {
    if (!templateForm.name || !templateForm.subject || !templateForm.body) return;
    setSubmitting(true);
    try {
      const res = await createEmailTemplate({
        ...templateForm,
        variables: templateForm.variables ? templateForm.variables.split(',').map(v => v.trim()).filter(Boolean) : [],
      });
      if (res.success) {
        setShowCreateTemplate(false);
        setTemplateForm({ name: '', subject: '', body: '', category: 'Promotional', variables: '' });
        await refresh();
      } else alert(res.error);
    } finally { setSubmitting(false); }
  };

  const handleSendCampaign = async (id) => {
    if (!await confirmDialog('This will send the campaign to all eligible recipients. Continue?')) return;
    setSubmitting(true);
    const res = await sendEmailCampaign(id);
    if (res.success) {
      alert(`Campaign sent to ${res.data.recipientCount} recipients!`);
      await refresh();
    } else alert(res.error);
    setSubmitting(false);
  };

  const handleDeleteCampaign = async (id) => {
    if (!await confirmDialog('Delete this campaign permanently?')) return;
    await deleteEmailCampaign(id);
    setSelectedCampaign(null);
    await refresh();
  };

  const handleDuplicate = async (id) => {
    await duplicateCampaign(id);
    await refresh();
  };

  const handleDeleteTemplate = async (id) => {
    if (!await confirmDialog('Delete this template?')) return;
    const res = await deleteEmailTemplate(id);
    if (!res.success) alert(res.error);
    await refresh();
  };

  const handleViewAnalytics = async (campaign) => {
    const res = await getCampaignAnalytics(campaign.id);
    if (res.success) {
      setCampaignAnalytics(res.data);
      setShowAnalytics(true);
    }
  };

  const handleUseTemplate = (template) => {
    setCampaignForm(f => ({
      ...f,
      subject: template.subject,
      body: template.body,
      templateId: String(template.id),
    }));
    setShowCreateCampaign(true);
  };

  const handleLoadDefault = (tpl) => {
    setTemplateForm({
      name: tpl.name,
      subject: tpl.subject,
      body: tpl.body,
      category: tpl.category,
      variables: tpl.variables.join(', '),
    });
  };

  // ─── Loading State ─────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-72 bg-surface rounded-lg" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-24 bg-surface rounded-2xl" />)}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">{[1,2,3].map(i => <div key={i} className="h-52 bg-surface rounded-2xl" />)}</div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Mail className="w-6 h-6 text-accent" /> Email Marketing
          </h1>
          <p className="text-sm text-muted mt-1">
            {campaigns.length} campaigns · {totalSent.toLocaleString()} emails sent · {audienceStats?.subscribed || 0} subscribers
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'templates' ? (
            <button onClick={() => setShowCreateTemplate(true)} className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
              <Plus className="w-4 h-4" /> New Template
            </button>
          ) : tab === 'campaigns' ? (
            <button onClick={() => setShowCreateCampaign(true)} className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
              <Plus className="w-4 h-4" /> Create Campaign
            </button>
          ) : null}
        </div>
      </div>

      {/* Email Config Status Banner */}
      {emailConfig && !emailConfig.configured && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">Email not configured yet</p>
            <p className="text-xs text-muted">Set up your business email (SMTP) to start sending campaigns to customers.</p>
          </div>
          <Link href="/settings" className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all whitespace-nowrap">
            Configure Email →
          </Link>
        </div>
      )}
      {emailConfig?.configured && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-success-light/50 text-success text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Sending from <strong>{emailConfig.fromName}</strong> ({emailConfig.smtpUser})
        </div>
      )}

      {/* Top Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Sent', value: totalSent.toLocaleString(), icon: Send, iconColor: 'text-accent', bgColor: 'bg-accent-light' },
          { label: 'Opened', value: totalOpened.toLocaleString(), icon: MailOpen, iconColor: 'text-info', bgColor: 'bg-info-light' },
          { label: 'Clicked', value: totalClicked.toLocaleString(), icon: MousePointerClick, iconColor: 'text-success', bgColor: 'bg-success-light' },
          { label: 'Open Rate', value: `${avgOpenRate}%`, icon: Eye, iconColor: 'text-purple', bgColor: 'bg-purple-light' },
          { label: 'Click Rate', value: `${avgClickRate}%`, icon: TrendingUp, iconColor: 'text-amber-500', bgColor: 'bg-amber-500/10' },
          { label: 'Subscribers', value: (audienceStats?.subscribed || 0).toLocaleString(), icon: Users, iconColor: 'text-emerald-500', bgColor: 'bg-emerald-500/10' },
        ].map((stat, i) => (
          <div key={i} className="glass-card p-4 flex items-center gap-3">
            <div className={`p-2 rounded-xl ${stat.bgColor}`}>
              <stat.icon className={`w-4 h-4 ${stat.iconColor}`} />
            </div>
            <div>
              <p className="text-[11px] text-muted">{stat.label}</p>
              <p className="text-lg font-bold text-foreground">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-surface rounded-xl w-fit">
        {[
          { key: 'campaigns', label: 'Campaigns', icon: Mail },
          { key: 'templates', label: 'Templates', icon: LayoutTemplate },
          { key: 'automation', label: 'Automation', icon: Zap },
          { key: 'tracking', label: 'Email Tracking', icon: BarChart3 },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.key ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-foreground hover:bg-surface-hover'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* ═══════════════ CAMPAIGNS TAB ═══════════════ */}
      {tab === 'campaigns' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input type="text" placeholder="Search campaigns..." value={search} onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div className="flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-muted" />
              {['all', 'DRAFT', 'SCHEDULED', 'SENT'].map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === s ? 'bg-accent text-white' : 'bg-surface-hover text-muted hover:text-foreground'}`}>
                  {s === 'all' ? 'All' : statusConfig[s]?.label}
                </button>
              ))}
            </div>
          </div>

          {/* Campaign Cards */}
          {filtered.length === 0 ? (
            <div className="glass-card py-16 text-center text-muted">
              <Mail className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No campaigns found</p>
              <p className="text-sm mt-1">{campaigns.length === 0 ? 'Create your first email campaign' : 'Try adjusting your filters'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map(c => {
                const st = statusConfig[c.status] || statusConfig.DRAFT;
                const StIcon = st.icon;
                const openRate = c.sent > 0 ? Math.round((c.opened / c.sent) * 100) : 0;
                const clickRate = c.sent > 0 ? Math.round((c.clicked / c.sent) * 100) : 0;
                return (
                  <div key={c.id} className="glass-card overflow-hidden hover:scale-[1.01] transition-transform cursor-pointer" onClick={() => setSelectedCampaign(c)}>
                    <div className="p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold text-foreground truncate">{c.name}</h3>
                          <p className="text-xs text-muted mt-0.5 truncate">{c.subject}</p>
                        </div>
                        <span className={`badge text-[10px] ml-2 flex items-center gap-1 ${st.color}`}>
                          <StIcon className="w-3 h-3" /> {st.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-muted mb-3">
                        <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {c.audience}</span>
                        {c.isABTest && <span className="flex items-center gap-1 text-purple"><FlaskConical className="w-3 h-3" /> A/B</span>}
                        {c.isAutomated && <span className="flex items-center gap-1 text-amber-500"><Zap className="w-3 h-3" /> Auto</span>}
                      </div>

                      {c.sent > 0 ? (
                        <div className="space-y-2 pt-3 border-t border-border">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted">Open Rate</span>
                            <span className="font-semibold text-foreground">{openRate}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-surface-hover rounded-full overflow-hidden">
                            <div className="h-full bg-info rounded-full transition-all" style={{ width: `${Math.min(openRate, 100)}%` }} />
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted">Click Rate</span>
                            <span className="font-semibold text-foreground">{clickRate}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-surface-hover rounded-full overflow-hidden">
                            <div className="h-full bg-success rounded-full transition-all" style={{ width: `${Math.min(clickRate, 100)}%` }} />
                          </div>
                          <div className="grid grid-cols-3 gap-2 pt-2">
                            <div className="text-center"><p className="text-[10px] text-muted">Sent</p><p className="text-xs font-bold">{c.sent}</p></div>
                            <div className="text-center"><p className="text-[10px] text-muted">Opened</p><p className="text-xs font-bold text-info">{c.opened}</p></div>
                            <div className="text-center"><p className="text-[10px] text-muted">Clicked</p><p className="text-xs font-bold text-success">{c.clicked}</p></div>
                          </div>
                        </div>
                      ) : (
                        <div className="pt-3 border-t border-border text-center">
                          <p className="text-xs text-muted">Not sent yet</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TEMPLATES TAB ═══════════════ */}
      {tab === 'templates' && (
        <div className="space-y-5">
          {/* Starter Templates */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500" /> Starter Templates
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {defaultTemplates.map((tpl, i) => (
                <div key={i} className="glass-card p-4 hover:scale-[1.01] transition-transform">
                  <p className="text-xs font-medium text-accent mb-1">{tpl.category}</p>
                  <h4 className="text-sm font-semibold text-foreground mb-2">{tpl.name}</h4>
                  <p className="text-xs text-muted mb-3 line-clamp-2">{tpl.subject}</p>
                  <button onClick={() => handleLoadDefault(tpl)}
                    className="text-xs text-accent hover:text-accent-hover font-medium flex items-center gap-1">
                    <Copy className="w-3 h-3" /> Use as Template
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Saved Templates */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">Your Templates</h3>
            {templates.length === 0 ? (
              <div className="glass-card py-12 text-center text-muted">
                <LayoutTemplate className="w-10 h-10 mx-auto mb-2 opacity-20" />
                <p className="text-sm">No saved templates yet</p>
                <p className="text-xs mt-1">Create a template or start from a starter above</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {templates.map(t => (
                  <div key={t.id} className="glass-card p-5">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <span className="text-[10px] font-medium text-accent bg-accent-light px-2 py-0.5 rounded-full">{t.category}</span>
                        <h4 className="text-sm font-semibold text-foreground mt-1.5">{t.name}</h4>
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => handleUseTemplate(t)} className="p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-accent transition-colors" title="Use in campaign">
                          <Mail className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDeleteTemplate(t.id)} className="p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-red-500 transition-colors" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-muted mb-2 truncate">Subject: {t.subject}</p>
                    {t.variables.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {t.variables.map(v => (
                          <span key={v} className="text-[10px] px-1.5 py-0.5 bg-surface-hover rounded text-muted">{`{{${v}}}`}</span>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-muted mt-2">Used in {t.campaignCount} campaign(s)</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════ AUTOMATION TAB ═══════════════ */}
      {tab === 'automation' && (
        <div className="space-y-5">
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground flex items-center gap-2 mb-1">
              <Bot className="w-5 h-5 text-accent" /> Automated Follow-up Campaigns
            </h3>
            <p className="text-sm text-muted mb-5">Set up campaigns that trigger automatically based on customer actions. Keep buyers engaged without manual effort.</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {triggerOptions.map(trigger => {
                const existing = campaigns.find(c => c.isAutomated && c.triggerType === trigger.value);
                return (
                  <div key={trigger.value} className="p-4 rounded-xl border border-border bg-surface/50 hover:bg-surface-hover/50 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-accent-light mt-0.5">
                          <Zap className="w-4 h-4 text-accent" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-foreground">{trigger.label}</h4>
                          <p className="text-xs text-muted mt-0.5">{trigger.desc}</p>
                          <p className="text-xs text-muted mt-1 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Sends {trigger.delay}h after trigger
                          </p>
                        </div>
                      </div>
                      {existing ? (
                        <span className="badge text-[10px] bg-success-light text-success">Active</span>
                      ) : (
                        <button
                          onClick={() => {
                            setCampaignForm(f => ({ ...f, isAutomated: true, triggerType: trigger.value, triggerDelay: String(trigger.delay) }));
                            setShowCreateCampaign(true);
                          }}
                          className="text-xs text-accent hover:text-accent-hover font-medium flex items-center gap-1 whitespace-nowrap"
                        >
                          <Plus className="w-3 h-3" /> Set Up
                        </button>
                      )}
                    </div>
                    {existing && (
                      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                        <div className="flex items-center gap-4 text-xs text-muted">
                          <span>Sent: <strong className="text-foreground">{existing.sent}</strong></span>
                          <span>Opened: <strong className="text-info">{existing.opened}</strong></span>
                          <span>Clicked: <strong className="text-success">{existing.clicked}</strong></span>
                        </div>
                        <button onClick={() => handleViewAnalytics(existing)} className="text-xs text-accent hover:underline">View Stats</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Automation Tips */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-semibold text-foreground mb-3">Automation Best Practices</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { title: 'Timing Matters', desc: 'Follow-ups within 24 hours have 3x higher engagement than delayed ones.', icon: Clock },
                { title: 'Personalize Content', desc: 'Use {{customerName}} and product details to make emails feel personal.', icon: Target },
                { title: 'Test & Iterate', desc: 'Use A/B testing to find what subject lines and content drive the most opens.', icon: FlaskConical },
              ].map((tip, i) => (
                <div key={i} className="p-4 rounded-xl bg-surface/50 border border-border">
                  <tip.icon className="w-5 h-5 text-accent mb-2" />
                  <h4 className="text-sm font-semibold text-foreground">{tip.title}</h4>
                  <p className="text-xs text-muted mt-1">{tip.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ TRACKING TAB ═══════════════ */}
      {tab === 'tracking' && (
        <div className="space-y-5">
          {/* Tracking Overview */}
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground flex items-center gap-2 mb-1">
              <BarChart3 className="w-5 h-5 text-accent" /> Email Tracking Dashboard
            </h3>
            <p className="text-sm text-muted mb-5">Real-time insights into email engagement. Know when your emails are opened and links are clicked.</p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="p-4 rounded-xl bg-surface text-center">
                <MailOpen className="w-6 h-6 text-info mx-auto mb-1" />
                <p className="text-2xl font-bold text-foreground">{avgOpenRate}%</p>
                <p className="text-xs text-muted">Avg Open Rate</p>
              </div>
              <div className="p-4 rounded-xl bg-surface text-center">
                <Link2 className="w-6 h-6 text-success mx-auto mb-1" />
                <p className="text-2xl font-bold text-foreground">{avgClickRate}%</p>
                <p className="text-xs text-muted">Avg Click Rate</p>
              </div>
              <div className="p-4 rounded-xl bg-surface text-center">
                <XCircle className="w-6 h-6 text-red-400 mx-auto mb-1" />
                <p className="text-2xl font-bold text-foreground">{totalBounced}</p>
                <p className="text-xs text-muted">Total Bounced</p>
              </div>
              <div className="p-4 rounded-xl bg-surface text-center">
                <AlertCircle className="w-6 h-6 text-amber-500 mx-auto mb-1" />
                <p className="text-2xl font-bold text-foreground">{sentCampaigns.reduce((s, c) => s + c.unsubscribed, 0)}</p>
                <p className="text-xs text-muted">Unsubscribed</p>
              </div>
            </div>

            {/* How It Works */}
            <div className="p-4 rounded-xl bg-accent-light/50 border border-accent/10">
              <h4 className="text-sm font-semibold text-foreground mb-2">How Email Tracking Works</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-muted">
                <div className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
                  <div><strong className="text-foreground">Open Tracking</strong><br/>An invisible 1x1 pixel is embedded in emails. When a recipient opens the email, the pixel loads and registers an open event.</div>
                </div>
                <div className="flex items-start gap-2">
                  <MousePointerClick className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
                  <div><strong className="text-foreground">Click Tracking</strong><br/>Links in your emails are wrapped with tracking URLs. When clicked, the click is logged before redirecting to the destination.</div>
                </div>
                <div className="flex items-start gap-2">
                  <TrendingUp className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
                  <div><strong className="text-foreground">Real-time Metrics</strong><br/>All events update in real-time. View per-recipient engagement on any sent campaign to optimize follow-ups.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Per-Campaign Tracking */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">Campaign Performance</h3>
            {sentCampaigns.length === 0 ? (
              <div className="glass-card py-12 text-center text-muted">
                <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-20" />
                <p className="text-sm">No sent campaigns to track yet</p>
              </div>
            ) : (
              <div className="glass-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-5 py-3 text-xs font-medium text-muted">Campaign</th>
                      <th className="text-center px-3 py-3 text-xs font-medium text-muted">Sent</th>
                      <th className="text-center px-3 py-3 text-xs font-medium text-muted">Opened</th>
                      <th className="text-center px-3 py-3 text-xs font-medium text-muted">Clicked</th>
                      <th className="text-center px-3 py-3 text-xs font-medium text-muted">Open %</th>
                      <th className="text-center px-3 py-3 text-xs font-medium text-muted">Click %</th>
                      <th className="text-center px-3 py-3 text-xs font-medium text-muted">Bounced</th>
                      <th className="text-right px-5 py-3 text-xs font-medium text-muted">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sentCampaigns.map(c => {
                      const or = c.sent > 0 ? Math.round((c.opened / c.sent) * 100) : 0;
                      const cr = c.sent > 0 ? Math.round((c.clicked / c.sent) * 100) : 0;
                      return (
                        <tr key={c.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                          <td className="px-5 py-3">
                            <p className="font-medium text-foreground">{c.name}</p>
                            <p className="text-xs text-muted">{c.subject}</p>
                          </td>
                          <td className="text-center px-3 py-3 font-medium">{c.sent}</td>
                          <td className="text-center px-3 py-3 text-info font-medium">{c.opened}</td>
                          <td className="text-center px-3 py-3 text-success font-medium">{c.clicked}</td>
                          <td className="text-center px-3 py-3">
                            <div className="inline-flex items-center gap-1">
                              <div className="w-12 h-1.5 bg-surface-hover rounded-full overflow-hidden">
                                <div className="h-full bg-info rounded-full" style={{ width: `${or}%` }} />
                              </div>
                              <span className="text-xs font-medium">{or}%</span>
                            </div>
                          </td>
                          <td className="text-center px-3 py-3">
                            <div className="inline-flex items-center gap-1">
                              <div className="w-12 h-1.5 bg-surface-hover rounded-full overflow-hidden">
                                <div className="h-full bg-success rounded-full" style={{ width: `${cr}%` }} />
                              </div>
                              <span className="text-xs font-medium">{cr}%</span>
                            </div>
                          </td>
                          <td className="text-center px-3 py-3 text-red-400">{c.bounced}</td>
                          <td className="text-right px-5 py-3">
                            <button onClick={() => handleViewAnalytics(c)} className="text-xs text-accent hover:text-accent-hover font-medium">
                              View Details →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════ CAMPAIGN DETAIL MODAL ═══════════════ */}
      <Modal isOpen={!!selectedCampaign} onClose={() => setSelectedCampaign(null)} title="Campaign Details" size="xl">
        {selectedCampaign && (() => {
          const c = selectedCampaign;
          const st = statusConfig[c.status] || statusConfig.DRAFT;
          const StIcon = st.icon;
          const openRate = c.sent > 0 ? Math.round((c.opened / c.sent) * 100) : 0;
          const clickRate = c.sent > 0 ? Math.round((c.clicked / c.sent) * 100) : 0;
          return (
            <div className="space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">{c.name}</h3>
                  <p className="text-sm text-muted">{c.subject}</p>
                </div>
                <span className={`badge flex items-center gap-1 ${st.color}`}>
                  <StIcon className="w-3.5 h-3.5" /> {st.label}
                </span>
              </div>

              {/* Quick Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: 'Recipients', value: c.totalRecipients || c.recipientCount, icon: Users },
                  { label: 'Sent', value: c.sent, icon: Send },
                  { label: 'Opened', value: `${c.opened} (${openRate}%)`, icon: MailOpen },
                  { label: 'Clicked', value: `${c.clicked} (${clickRate}%)`, icon: MousePointerClick },
                  { label: 'Bounced', value: c.bounced, icon: XCircle },
                ].map((s, i) => (
                  <div key={i} className="p-3 rounded-xl bg-surface text-center">
                    <s.icon className="w-4 h-4 mx-auto mb-1 text-muted" />
                    <p className="text-sm font-bold text-foreground">{s.value}</p>
                    <p className="text-[10px] text-muted">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Features Badges */}
              <div className="flex flex-wrap gap-2">
                <span className="text-xs px-2.5 py-1 rounded-lg bg-surface-hover text-muted">Audience: {c.audience}</span>
                {c.isABTest && <span className="text-xs px-2.5 py-1 rounded-lg bg-purple-light text-purple">A/B Test ({c.abSplitPercent}% / {100 - c.abSplitPercent}%)</span>}
                {c.isAutomated && <span className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-500">Automated: {c.triggerType}</span>}
                {c.scheduledAt && <span className="text-xs px-2.5 py-1 rounded-lg bg-info-light text-info">Scheduled: {new Date(c.scheduledAt).toLocaleDateString()}</span>}
              </div>

              {/* Email Preview */}
              <div>
                <p className="text-xs font-medium text-muted mb-2">Email Preview</p>
                <div className="p-4 rounded-xl bg-white border border-border max-h-[300px] overflow-y-auto">
                  <div dangerouslySetInnerHTML={{ __html: c.body }} />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-3 border-t border-border">
                <div className="flex gap-2">
                  <button onClick={() => handleDeleteCampaign(c.id)} className="px-3 py-2 text-xs text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex items-center gap-1">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                  <button onClick={() => handleDuplicate(c.id)} className="px-3 py-2 text-xs text-muted hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors flex items-center gap-1">
                    <Copy className="w-3.5 h-3.5" /> Duplicate
                  </button>
                </div>
                <div className="flex gap-2">
                  {c.status === 'SENT' && (
                    <button onClick={() => { setSelectedCampaign(null); handleViewAnalytics(c); }}
                      className="px-4 py-2 text-xs bg-accent/10 text-accent rounded-lg font-medium flex items-center gap-1">
                      <BarChart3 className="w-3.5 h-3.5" /> View Analytics
                    </button>
                  )}
                  {(c.status === 'DRAFT' || c.status === 'SCHEDULED') && (
                    <button onClick={() => handleSendCampaign(c.id)} disabled={submitting}
                      className="px-4 py-2 text-xs bg-accent hover:bg-accent-hover text-white rounded-lg font-semibold flex items-center gap-1 disabled:opacity-50">
                      <Send className="w-3.5 h-3.5" /> Send Now
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* ═══════════════ ANALYTICS MODAL ═══════════════ */}
      <Modal isOpen={showAnalytics} onClose={() => { setShowAnalytics(false); setCampaignAnalytics(null); }} title="Campaign Analytics" size="xl">
        {campaignAnalytics && (() => {
          const { campaign: ca, recipients, abStats, timeline } = campaignAnalytics;
          return (
            <div className="space-y-5">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{ca.name}</h3>
                <p className="text-xs text-muted">{ca.subject}</p>
              </div>

              {/* Funnel */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-surface text-center">
                  <p className="text-2xl font-bold text-foreground">{ca.sent}</p>
                  <p className="text-xs text-muted">Delivered</p>
                </div>
                <div className="p-3 rounded-xl bg-surface text-center">
                  <p className="text-2xl font-bold text-info">{ca.openRate}%</p>
                  <p className="text-xs text-muted">Open Rate</p>
                </div>
                <div className="p-3 rounded-xl bg-surface text-center">
                  <p className="text-2xl font-bold text-success">{ca.clickRate}%</p>
                  <p className="text-xs text-muted">Click Rate</p>
                </div>
                <div className="p-3 rounded-xl bg-surface text-center">
                  <p className="text-2xl font-bold text-red-400">{ca.bounceRate}%</p>
                  <p className="text-xs text-muted">Bounce Rate</p>
                </div>
              </div>

              {/* Engagement Timeline (simple bar chart) */}
              {timeline.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3">7-Day Engagement</h4>
                  <div className="flex items-end gap-2 h-32">
                    {timeline.map((d, i) => {
                      const maxVal = Math.max(...timeline.map(t => t.opens + t.clicks), 1);
                      const h = ((d.opens + d.clicks) / maxVal) * 100;
                      const openH = maxVal > 0 ? (d.opens / maxVal) * 100 : 0;
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1">
                          <div className="w-full flex flex-col justify-end" style={{ height: '100px' }}>
                            <div className="w-full bg-success/60 rounded-t" style={{ height: `${h - openH}%`, minHeight: d.clicks > 0 ? '3px' : 0 }} />
                            <div className="w-full bg-info/60 rounded-t" style={{ height: `${openH}%`, minHeight: d.opens > 0 ? '3px' : 0 }} />
                          </div>
                          <p className="text-[9px] text-muted">{d.date.slice(5)}</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[10px] text-muted">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-info/60" /> Opens</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-success/60" /> Clicks</span>
                  </div>
                </div>
              )}

              {/* A/B Test Results */}
              {abStats && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                    <FlaskConical className="w-4 h-4 text-purple" /> A/B Test Results
                  </h4>
                  <div className="grid grid-cols-2 gap-4">
                    {['A', 'B'].map(v => (
                      <div key={v} className={`p-4 rounded-xl border ${ca.abWinner === v ? 'border-success bg-success-light/30' : 'border-border bg-surface'}`}>
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-semibold text-foreground">Variant {v}</span>
                          {ca.abWinner === v && <span className="badge text-[10px] bg-success-light text-success">Winner</span>}
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-center">
                          <div><p className="text-lg font-bold text-info">{abStats[v].openRate}%</p><p className="text-[10px] text-muted">Open Rate</p></div>
                          <div><p className="text-lg font-bold text-success">{abStats[v].clickRate}%</p><p className="text-[10px] text-muted">Click Rate</p></div>
                        </div>
                        <p className="text-xs text-muted mt-2 text-center">{abStats[v].sent} recipients</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recipient List */}
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">Recipient Activity (latest 200)</h4>
                <div className="max-h-[250px] overflow-y-auto rounded-xl border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-surface">
                      <tr className="border-b border-border">
                        <th className="text-left px-3 py-2 text-muted">Recipient</th>
                        <th className="text-left px-3 py-2 text-muted">Email</th>
                        <th className="text-center px-3 py-2 text-muted">Status</th>
                        <th className="text-center px-3 py-2 text-muted">Opens</th>
                        <th className="text-center px-3 py-2 text-muted">Clicks</th>
                        <th className="text-left px-3 py-2 text-muted">Last Activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipients.map(r => (
                        <tr key={r.id} className="border-b border-border/50">
                          <td className="px-3 py-2 font-medium text-foreground">{r.name}</td>
                          <td className="px-3 py-2 text-muted">{r.email}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              r.status === 'clicked' ? 'bg-success-light text-success' :
                              r.status === 'opened' ? 'bg-info-light text-info' :
                              r.status === 'bounced' ? 'bg-red-500/10 text-red-400' :
                              r.status === 'unsubscribed' ? 'bg-amber-500/10 text-amber-500' :
                              'bg-surface-hover text-muted'
                            }`}>{r.status}</span>
                          </td>
                          <td className="px-3 py-2 text-center">{r.opens}</td>
                          <td className="px-3 py-2 text-center">{r.clicks}</td>
                          <td className="px-3 py-2 text-muted">
                            {r.clickedAt ? new Date(r.clickedAt).toLocaleString() :
                             r.openedAt ? new Date(r.openedAt).toLocaleString() :
                             r.sentAt ? new Date(r.sentAt).toLocaleString() : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* ═══════════════ CREATE CAMPAIGN MODAL ═══════════════ */}
      <Modal isOpen={showCreateCampaign} onClose={() => { setShowCreateCampaign(false); setCampaignForm({ name: '', subject: '', body: '', templateId: '', audience: 'all', scheduledAt: '', isABTest: false, variantBSubject: '', variantBBody: '', abSplitPercent: 50, isAutomated: false, triggerType: '', triggerDelay: '' }); }} title="Create Email Campaign" size="xl">
        <div className="space-y-5">
          {/* Basic Info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted mb-1.5">Campaign Name *</label>
              <input type="text" placeholder="e.g., Summer Collection Launch" value={campaignForm.name}
                onChange={e => setCampaignForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Email Subject *</label>
              <input type="text" placeholder="The subject line recipients will see" value={campaignForm.subject}
                onChange={e => setCampaignForm(f => ({ ...f, subject: e.target.value }))}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Use Template</label>
              <select value={campaignForm.templateId} onChange={e => {
                const tid = e.target.value;
                setCampaignForm(f => ({ ...f, templateId: tid }));
                if (tid) {
                  const tpl = templates.find(t => t.id === parseInt(tid));
                  if (tpl) setCampaignForm(f => ({ ...f, templateId: tid, subject: tpl.subject, body: tpl.body }));
                }
              }}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                <option value="">No template (custom)</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          {/* Body */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Email Body (HTML) *</label>
            <textarea rows={8} placeholder="Write your email HTML content..." value={campaignForm.body}
              onChange={e => setCampaignForm(f => ({ ...f, body: e.target.value }))}
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm resize-none focus:outline-none focus:border-accent/50 font-mono text-xs" />
          </div>

          {/* Audience */}
          <div>
            <label className="block text-xs font-medium text-muted mb-2">Target Audience</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {audienceOptions.map(opt => (
                <button key={opt.value} type="button" onClick={() => setCampaignForm(f => ({ ...f, audience: opt.value }))}
                  className={`p-3 rounded-xl border text-left transition-all ${campaignForm.audience === opt.value ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/30'}`}>
                  <opt.icon className={`w-4 h-4 mb-1 ${campaignForm.audience === opt.value ? 'text-accent' : 'text-muted'}`} />
                  <p className="text-sm font-medium text-foreground">{opt.label}</p>
                  <p className="text-[10px] text-muted">{opt.desc}</p>
                  {audienceStats && (
                    <p className="text-[10px] text-accent mt-1 font-medium">
                      {opt.value === 'all' ? audienceStats.subscribed : opt.value === 'leads' ? audienceStats.leads : audienceStats.customers} contacts
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Schedule Date & Time (optional)</label>
              <input type="datetime-local" value={campaignForm.scheduledAt}
                onChange={e => setCampaignForm(f => ({ ...f, scheduledAt: e.target.value }))}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
          </div>

          {/* A/B Testing Toggle */}
          <div className="p-4 rounded-xl border border-border">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={campaignForm.isABTest}
                onChange={e => setCampaignForm(f => ({ ...f, isABTest: e.target.checked }))}
                className="w-4 h-4 rounded border-border accent-accent" />
              <div>
                <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <FlaskConical className="w-3.5 h-3.5 text-purple" /> Enable A/B Testing
                </span>
                <p className="text-[10px] text-muted">Test two versions to find which performs better</p>
              </div>
            </label>
            {campaignForm.isABTest && (
              <div className="mt-4 space-y-3 pl-7">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Variant B Subject</label>
                  <input type="text" placeholder="Alternative subject line" value={campaignForm.variantBSubject}
                    onChange={e => setCampaignForm(f => ({ ...f, variantBSubject: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Variant B Body</label>
                  <textarea rows={4} placeholder="Alternative email body..." value={campaignForm.variantBBody}
                    onChange={e => setCampaignForm(f => ({ ...f, variantBBody: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm resize-none focus:outline-none focus:border-accent/50 font-mono text-xs" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Split: {campaignForm.abSplitPercent}% A / {100 - campaignForm.abSplitPercent}% B</label>
                  <input type="range" min={10} max={90} step={5} value={campaignForm.abSplitPercent}
                    onChange={e => setCampaignForm(f => ({ ...f, abSplitPercent: parseInt(e.target.value) }))}
                    className="w-full accent-accent" />
                </div>
              </div>
            )}
          </div>

          {/* Automation Toggle */}
          <div className="p-4 rounded-xl border border-border">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={campaignForm.isAutomated}
                onChange={e => setCampaignForm(f => ({ ...f, isAutomated: e.target.checked }))}
                className="w-4 h-4 rounded border-border accent-accent" />
              <div>
                <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-amber-500" /> Automated Campaign
                </span>
                <p className="text-[10px] text-muted">Auto-trigger this campaign on customer events</p>
              </div>
            </label>
            {campaignForm.isAutomated && (
              <div className="mt-4 space-y-3 pl-7">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Trigger Event</label>
                  <select value={campaignForm.triggerType} onChange={e => {
                    const tr = triggerOptions.find(t => t.value === e.target.value);
                    setCampaignForm(f => ({ ...f, triggerType: e.target.value, triggerDelay: tr ? String(tr.delay) : '' }));
                  }}
                    className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                    <option value="">Select trigger...</option>
                    {triggerOptions.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Delay (hours after event)</label>
                  <input type="number" min={0} value={campaignForm.triggerDelay}
                    onChange={e => setCampaignForm(f => ({ ...f, triggerDelay: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2 border-t border-border">
            <button onClick={() => setShowCreateCampaign(false)}
              className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
            <button onClick={() => handleCreateCampaign(true)} disabled={submitting || !campaignForm.name || !campaignForm.subject || !campaignForm.body}
              className="px-5 py-2.5 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50">
              Save as Draft
            </button>
            <button onClick={() => handleCreateCampaign(false)} disabled={submitting || !campaignForm.name || !campaignForm.subject || !campaignForm.body}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50 flex items-center gap-2">
              <Send className="w-3.5 h-3.5" /> {campaignForm.scheduledAt ? 'Schedule' : 'Create Campaign'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ═══════════════ CREATE TEMPLATE MODAL ═══════════════ */}
      <Modal isOpen={showCreateTemplate} onClose={() => { setShowCreateTemplate(false); setTemplateForm({ name: '', subject: '', body: '', category: 'Promotional', variables: '' }); }} title="Create Email Template" size="lg">
        <div className="space-y-4">
          {/* Default template quick-fill */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Start from a Starter Template</label>
            <div className="flex flex-wrap gap-2">
              {defaultTemplates.map((tpl, i) => (
                <button key={i} type="button" onClick={() => handleLoadDefault(tpl)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-surface-hover text-muted hover:text-accent hover:bg-accent-light transition-colors">
                  {tpl.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Template Name *</label>
              <input type="text" placeholder="e.g., Diwali Sale Template" value={templateForm.name}
                onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Category</label>
              <select value={templateForm.category} onChange={e => setTemplateForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                {templateCategories.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Subject Line *</label>
            <input type="text" placeholder="e.g., Hello {{customerName}}, check out our new arrivals!" value={templateForm.subject}
              onChange={e => setTemplateForm(f => ({ ...f, subject: e.target.value }))}
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Email Body (HTML) *</label>
            <textarea rows={10} placeholder="<div>Your email HTML content...</div>" value={templateForm.body}
              onChange={e => setTemplateForm(f => ({ ...f, body: e.target.value }))}
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm resize-none focus:outline-none focus:border-accent/50 font-mono text-xs" />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Variables (comma separated)</label>
            <input type="text" placeholder="e.g., customerName, storeName, offerCode" value={templateForm.variables}
              onChange={e => setTemplateForm(f => ({ ...f, variables: e.target.value }))}
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            <p className="text-[10px] text-muted mt-1">Use {`{{variableName}}`} syntax in subject and body</p>
          </div>

          {/* Preview */}
          {templateForm.body && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Preview</label>
              <div className="p-4 rounded-xl bg-white border border-border max-h-[200px] overflow-y-auto">
                <div dangerouslySetInnerHTML={{ __html: templateForm.body }} />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowCreateTemplate(false)}
              className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
            <button onClick={handleCreateTemplate} disabled={submitting || !templateForm.name || !templateForm.subject || !templateForm.body}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50 flex items-center gap-2">
              <PenLine className="w-3.5 h-3.5" /> Save Template
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
