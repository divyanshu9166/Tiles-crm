'use client';

import { useState, useEffect, useRef } from 'react';
import { Store, Users, Link2, Bell, Bot, Save, Plus, MapPin, Crosshair, ChevronDown, ChevronUp, Copy, Check, Eye, EyeOff, Upload, Loader2, Mail, Send, CheckCircle2, XCircle, Package, RefreshCw, User, FileText } from 'lucide-react';
import Image from 'next/image';
import { getStoreSettings, updateStoreSettings } from '@/app/actions/settings';
import { getStaff, createStaff, assignStaffLogin, updateStaffMember } from '@/app/actions/staff';
import { getChannelConfigs, upsertChannelConfig } from '@/app/actions/channels';
import { testSmtp, sendSmtpTestEmail } from '@/app/actions/email-campaigns';
import { runStockCheck } from '@/app/actions/notifications';
import { updateAccountCredentials } from '@/app/actions/auth';
import { useSession } from '@/components/AuthProvider';
import { getBrand } from '@/lib/brand';
import IndiaMartIntegrationSettings from './IndiaMartIntegrationSettings';
import ErpPoliciesSettings from './ErpPoliciesSettings';

const channelDefinitions = [
  {
    channel: 'WhatsApp',
    name: 'WhatsApp Business',
    description: 'Connect WhatsApp Business API for automated messaging',
    icon: '💬',
    fields: [
      { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'From Meta Business Suite', type: 'text' },
      { key: 'apiToken', label: 'Permanent API Token', placeholder: 'Meta Graph API token', type: 'password' },
      { key: 'verifyToken', label: 'Webhook Verify Token', placeholder: 'Any string you choose', type: 'text' },
      { key: 'templateName', label: 'Notification Template Name', placeholder: 'e.g. furniture_order_update (approved template)', type: 'text' },
      { key: 'templateLanguage', label: 'Template Language Code', placeholder: 'en (default)', type: 'text' },
    ],
    docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  },
  {
    channel: 'Instagram',
    name: 'Instagram',
    description: 'Receive and reply to Instagram DMs via the unified social webhook',
    icon: '📸',
    fields: [
      { key: 'igAccountId', label: 'Instagram Business Account ID', placeholder: 'From Meta Business Suite → Instagram → About', type: 'text' },
      { key: 'pageId', label: 'Linked Facebook Page ID', placeholder: 'The Facebook Page linked to this Instagram account', type: 'text' },
      { key: 'accessToken', label: 'Page Access Token', placeholder: 'Long-lived token from Graph API', type: 'password' },
      { key: 'appSecret', label: 'App Secret (optional)', placeholder: 'For webhook signature verification', type: 'password' },
      { key: 'verifyToken', label: 'Webhook Verify Token', placeholder: 'Any string you choose', type: 'text' },
    ],
    docs: 'https://developers.facebook.com/docs/messenger-platform/instagram',
  },
  {
    channel: 'Facebook',
    name: 'Facebook Messenger',
    description: 'Connect a Facebook Page for messaging via the unified social webhook',
    icon: '👥',
    fields: [
      { key: 'pageId', label: 'Facebook Page ID', placeholder: 'From Page settings → About', type: 'text' },
      { key: 'accessToken', label: 'Page Access Token', placeholder: 'Long-lived token from Graph API', type: 'password' },
      { key: 'appSecret', label: 'App Secret (optional)', placeholder: 'For webhook signature verification', type: 'password' },
      { key: 'verifyToken', label: 'Webhook Verify Token', placeholder: 'Any string you choose', type: 'text' },
    ],
    docs: 'https://developers.facebook.com/docs/messenger-platform/getting-started',
  },
  {
    channel: 'Website',
    name: 'Website Chat',
    description: 'Embed a live chat widget on your website',
    icon: '🌐',
    fields: [
      { key: 'widgetColor', label: 'Widget Color', placeholder: '#4f46e5', type: 'text' },
      { key: 'welcomeMessage', label: 'Welcome Message', placeholder: 'Hello! How can we help you?', type: 'text' },
    ],
    docs: null,
  },
];

const nonChannelIntegrations = [
  { name: 'Google Calendar', description: 'Sync appointments with Google Calendar', connected: true, icon: '📅' },
  { name: 'Google My Business', description: 'Manage Google reviews and listings', connected: true, icon: '⭐' },
  { name: 'Razorpay', description: 'Accept online payments and track transactions', connected: false, icon: '💳' },
];

const staffRoleOptions = [
  'Senior Sales Executive',
  'Sales Executive',
  'Junior Sales Executive',
  'Design Consultant',
  'Warehouse Manager',
];

const getInitialInviteForm = () => ({
  name: '',
  role: 'Sales Executive',
  phone: '',
  email: '',
  joinDate: new Date().toISOString().split('T')[0],
  loginUsername: '',
  loginPassword: '',
});

const getInitialEditForm = () => ({
  id: '',
  name: '',
  role: 'Sales Executive',
  phone: '',
  email: '',
  status: 'Active',
  joinDate: new Date().toISOString().split('T')[0],
  loginUsername: '',
  loginPassword: '',
});

export default function SettingsPage() {
  const { data: session, update: refreshSession } = useSession();
  // Active_Vertical brand identity (resolved from NEXT_PUBLIC_BUSINESS_TYPE on
  // the client). Used for vertical-aware fallbacks like the logo placeholder.
  const brand = getBrand();
  const [activeTab, setActiveTab] = useState('store');
  const [loading, setLoading] = useState(true);
  const [storeSettings, setStoreSettings] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [inviteForm, setInviteForm] = useState(getInitialInviteForm());
  const [showLoginSetupForm, setShowLoginSetupForm] = useState(false);
  const [loginSetupForm, setLoginSetupForm] = useState({ staffId: '', loginUsername: '', loginPassword: '' });
  const [assigningLogin, setAssigningLogin] = useState(false);
  const [assignLoginError, setAssignLoginError] = useState('');
  const [assignLoginSuccess, setAssignLoginSuccess] = useState('');
  const [showEditForm, setShowEditForm] = useState(false);
  const [editForm, setEditForm] = useState(getInitialEditForm());
  const [editingMember, setEditingMember] = useState(false);
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [detectingGps, setDetectingGps] = useState(false);
  const [gpsDetected, setGpsDetected] = useState(null); // { lat, lng, address }
  const [stockCheckRunning, setStockCheckRunning] = useState(false);
  const [stockCheckResult, setStockCheckResult] = useState(null);

  const [accountForm, setAccountForm] = useState({
    currentPassword: '',
    newUsername: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [accountSuccess, setAccountSuccess] = useState('');
  const [showAccountPasswords, setShowAccountPasswords] = useState({
    current: false,
    new: false,
    confirm: false,
  });

  // Channel integration state
  const [channelConfigs, setChannelConfigs] = useState({});
  const [expandedChannel, setExpandedChannel] = useState(null);
  const [channelForms, setChannelForms] = useState({});
  const [channelSaving, setChannelSaving] = useState(null);
  const [channelSaved, setChannelSaved] = useState(null);
  const [copiedWebhook, setCopiedWebhook] = useState(null);
  const [showSecrets, setShowSecrets] = useState({});

  // Logo upload
  const logoInputRef = useRef(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // SMTP email state
  const [smtpForm, setSmtpForm] = useState({ smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', smtpFromName: '', smtpSecure: false });
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState(null);
  const [smtpSending, setSmtpSending] = useState(false);
  const [smtpSendResult, setSmtpSendResult] = useState(null);
  const [smtpTestEmail, setSmtpTestEmail] = useState('');
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  const mapTeamMember = (s) => ({
    id: s.id,
    name: s.name,
    phone: s.phone || '',
    email: s.email || '',
    role: s.role || 'Staff',
    status: s.status || 'Active',
    joinDate: s.joinDate || new Date().toISOString().split('T')[0],
    loginUsername: s.loginUsername || '',
    hasLogin: !!s.hasLogin,
    loginActive: !!s.loginActive,
  });

  const refreshTeamMembers = async () => {
    const staffRes = await getStaff();
    if (staffRes.success) setTeamMembers(staffRes.data.map(mapTeamMember));
  };

  const handleInviteMember = async (e) => {
    e.preventDefault();
    setInviting(true);
    setInviteError('');
    setInviteSuccess('');
    try {
      const payload = {
        ...inviteForm,
        loginUsername: inviteForm.loginUsername.trim(),
        loginPassword: inviteForm.loginPassword,
      };

      const res = await createStaff(payload);
      if (!res.success) {
        setInviteError(res.error || 'Failed to add team member');
        return;
      }

      await refreshTeamMembers();
      setInviteSuccess('Team member added successfully');
      setInviteForm(getInitialInviteForm());
      setShowInviteForm(false);
    } catch (err) {
      console.error('Invite member error:', err);
      setInviteError('Failed to add team member. Please try again.');
    } finally {
      setInviting(false);
    }
  };

  const openAssignLoginForm = (member) => {
    setShowLoginSetupForm(true);
    setAssignLoginError('');
    setAssignLoginSuccess('');
    setLoginSetupForm({
      staffId: String(member.id),
      loginUsername: member.email || '',
      loginPassword: '',
    });
  };

  const handleAssignLogin = async (e) => {
    e.preventDefault();
    if (!loginSetupForm.staffId) return;

    setAssigningLogin(true);
    setAssignLoginError('');
    setAssignLoginSuccess('');

    try {
      const res = await assignStaffLogin(
        Number(loginSetupForm.staffId),
        loginSetupForm.loginUsername,
        loginSetupForm.loginPassword
      );

      if (!res.success) {
        setAssignLoginError(res.error || 'Failed to assign login credentials');
        return;
      }

      await refreshTeamMembers();
      setAssignLoginSuccess('Login credentials assigned successfully');
      setShowLoginSetupForm(false);
      setLoginSetupForm({ staffId: '', loginUsername: '', loginPassword: '' });
    } catch (err) {
      console.error('Assign login error:', err);
      setAssignLoginError('Failed to assign login credentials. Please try again.');
    } finally {
      setAssigningLogin(false);
    }
  };

  const openEditMemberForm = (member) => {
    setShowEditForm(true);
    setEditError('');
    setEditSuccess('');
    setEditForm({
      id: String(member.id),
      name: member.name,
      role: member.role,
      phone: member.phone || '',
      email: member.email || '',
      status: member.status || 'Active',
      joinDate: member.joinDate || new Date().toISOString().split('T')[0],
      loginUsername: member.loginUsername || '',
      loginPassword: '',
    });
  };

  const handleUpdateMember = async (e) => {
    e.preventDefault();
    if (!editForm.id) return;

    setEditingMember(true);
    setEditError('');
    setEditSuccess('');

    try {
      const payload = {
        id: Number(editForm.id),
        name: editForm.name,
        role: editForm.role,
        phone: editForm.phone,
        email: editForm.email,
        status: editForm.status,
        joinDate: editForm.joinDate,
        loginUsername: editForm.loginUsername.trim(),
        loginPassword: editForm.loginPassword,
      };

      const res = await updateStaffMember(payload);
      if (!res.success) {
        setEditError(res.error || 'Failed to update team member');
        return;
      }

      await refreshTeamMembers();
      setEditSuccess('Team member updated successfully');
      setShowEditForm(false);
      setEditForm(getInitialEditForm());
    } catch (err) {
      console.error('Update team member error:', err);
      setEditError('Failed to update team member. Please try again.');
    } finally {
      setEditingMember(false);
    }
  };

  const handleDetectLocation = async () => {
    setDetectingGps(true);
    setGpsDetected(null);
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
      });
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      // Reverse geocode via Nominatim (free, no API key)
      let address = '';
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`);
        const data = await res.json();
        address = data.display_name || '';
      } catch { address = ''; }

      setGpsDetected({ lat, lng, address });

      // Auto-fill the form fields
      const form = document.querySelector('form[data-settings-form]');
      if (form) {
        form.storeLat.value = lat;
        form.storeLng.value = lng;
      }
    } catch (err) {
      alert('Could not detect location. Please enable GPS/location services and try again.');
    } finally {
      setDetectingGps(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      alert('Please upload a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('File too large. Maximum 5MB.');
      return;
    }

    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.set('folder', 'logos');
      formData.append('files', file);

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.success && data.urls?.[0]) {
        const logoUrl = data.urls[0];
        // Save to store settings
        const saveRes = await updateStoreSettings({ logo: logoUrl });
        if (saveRes.success) {
          setStoreSettings(prev => ({ ...prev, logo: logoUrl }));
          window.dispatchEvent(new CustomEvent('logo-updated', { detail: logoUrl }));
        }
      } else {
        alert(data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Logo upload error:', err);
      alert('Upload failed. Please try again.');
    } finally {
      setUploadingLogo(false);
      // Reset input so same file can be re-selected
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  useEffect(() => {
    Promise.all([
      getStoreSettings(),
      getStaff(),
      getChannelConfigs(),
    ]).then(([settingsRes, staffRes, channelsRes]) => {
      if (settingsRes.success) {
        setStoreSettings(settingsRes.data);
        // Load SMTP form from saved settings
        setSmtpForm({
          smtpHost: settingsRes.data.smtpHost || '',
          smtpPort: settingsRes.data.smtpPort || 587,
          smtpUser: settingsRes.data.smtpUser || '',
          smtpPass: settingsRes.data.smtpPass || '',
          smtpFromName: settingsRes.data.smtpFromName || settingsRes.data.storeName || '',
          smtpSecure: settingsRes.data.smtpSecure || false,
        });
      }
      if (staffRes.success) setTeamMembers(staffRes.data.map(mapTeamMember));
      if (channelsRes.success) {
        const configMap = {};
        const formMap = {};
        channelsRes.data.forEach(c => {
          configMap[c.channel] = c;
          formMap[c.channel] = { ...c.config };
        });
        setChannelConfigs(configMap);
        setChannelForms(formMap);
      }
      setLoading(false);
    });
  }, []);

  const handleSaveStore = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveSuccess(false);
    setSaveError('');
    try {
      const form = e.target;
      const data = {
        storeName: form.storeName.value,
        phone: form.phone.value,
        whatsappNumber: form.whatsappNumber.value,
        email: form.email.value,
        address: form.address.value,
        paymentQr: form.paymentQr.value,
        invoicePrefix: form.invoicePrefix.value,
        invoicePadding: form.invoicePadding.value ? parseInt(form.invoicePadding.value) : undefined,
        invoiceTerms: form.invoiceTerms.value,
        bankName: form.bankName.value,
        bankAccountName: form.bankAccountName.value,
        bankAccountNumber: form.bankAccountNumber.value,
        bankIfsc: form.bankIfsc.value,
        bankUpiId: form.bankUpiId.value,
        gstNumber: form.gstNumber.value,
        storeLat: form.storeLat.value ? parseFloat(form.storeLat.value) : undefined,
        storeLng: form.storeLng.value ? parseFloat(form.storeLng.value) : undefined,
        geofenceRadius: form.geofenceRadius.value ? parseInt(form.geofenceRadius.value) : undefined,
        shiftStartTime: form.shiftStartTime.value || undefined,
        shiftEndTime: form.shiftEndTime.value || undefined,
      };
      const res = await updateStoreSettings(data);
      if (res.success) {
        setStoreSettings({ ...storeSettings, ...data });
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        setSaveError(res.error || 'Failed to save settings. Please try again.');
      }
    } catch (err) {
      console.error('Save error:', err);
      setSaveError('An unexpected error occurred. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleAccountUpdate = async (e) => {
    e.preventDefault();
    setAccountError('');
    setAccountSuccess('');

    const currentPassword = accountForm.currentPassword.trim();
    const newUsername = accountForm.newUsername.trim();
    const newPassword = accountForm.newPassword;
    const confirmPassword = accountForm.confirmPassword;

    if (!currentPassword) {
      setAccountError('Current password is required');
      return;
    }

    if (!newUsername && !newPassword) {
      setAccountError('Enter a new username or a new password');
      return;
    }

    if (newPassword && newPassword.length < 6) {
      setAccountError('New password must be at least 6 characters');
      return;
    }

    if (newPassword && newPassword !== confirmPassword) {
      setAccountError('New passwords do not match');
      return;
    }

    setAccountSaving(true);
    try {
      const res = await updateAccountCredentials({
        currentPassword,
        newUsername,
        newPassword,
      });

      if (!res.success) {
        setAccountError(res.error || 'Failed to update credentials');
        return;
      }

      setAccountSuccess('Account updated successfully');
      setAccountForm({ currentPassword: '', newUsername: '', newPassword: '', confirmPassword: '' });
      await refreshSession();
    } catch (err) {
      console.error('Account update error:', err);
      setAccountError('Failed to update credentials. Please try again.');
    } finally {
      setAccountSaving(false);
    }
  };

  const tabs = [
    { key: 'store', label: 'Store Profile', icon: Store },
    { key: 'account', label: 'Account', icon: User },
    { key: 'team', label: 'Team', icon: Users },
    { key: 'integrations', label: 'Integrations', icon: Link2 },
    { key: 'email', label: 'Email Setup', icon: Mail },
    { key: 'notifications', label: 'Notifications', icon: Bell },
    { key: 'ai', label: 'AI Settings', icon: Bot },
    { key: 'erp', label: 'ERP Policies', icon: Package },
  ];

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="flex gap-6">
          <div className="hidden sm:block w-56 space-y-2">{[1, 2, 3, 4, 5].map(i => <div key={i} className="h-10 bg-surface rounded-xl" />)}</div>
          <div className="flex-1 h-96 bg-surface rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 animate-[fade-in_0.5s_ease-out]">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted mt-1">Manage your store configuration and integrations</p>
      </div>

      {/* Mobile Tab Nav - horizontal scroll */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1 sm:hidden no-scrollbar">
        {tabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${activeTab === tab.key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground bg-surface'}`}>
              <Icon className="w-4 h-4" /> {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex gap-6">
        {/* Desktop Tab Nav - vertical sidebar */}
        <div className="hidden sm:block w-56 flex-shrink-0 space-y-1">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeTab === tab.key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground hover:bg-surface-hover'}`}>
                <Icon className="w-4 h-4" /> {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="flex-1 min-w-0">
          {activeTab === 'store' && (
            <div className="glass-card p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4 sm:mb-5">Store Profile</h2>
              <form onSubmit={handleSaveStore} data-settings-form className="space-y-4 max-w-2xl">
                <div className="flex items-center gap-4 sm:gap-5 mb-4 sm:mb-6">
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-accent/10 flex items-center justify-center text-2xl sm:text-3xl flex-shrink-0 overflow-hidden relative">
                    {storeSettings?.logo ? (
                      <Image src={storeSettings.logo} alt="Store Logo" fill className="object-cover" />
                    ) : brand.vertical === 'tiles' ? (
                      <Image src={brand.logo} alt="Store Logo" fill className="object-cover" />
                    ) : (
                      '🪑'
                    )}
                  </div>
                  <div>
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleLogoUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={uploadingLogo}
                      className="flex items-center gap-2 px-4 py-2 border border-border rounded-xl text-sm text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                    >
                      {uploadingLogo ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</>
                      ) : (
                        <><Upload className="w-4 h-4" /> {storeSettings?.logo ? 'Change Logo' : 'Upload Logo'}</>
                      )}
                    </button>
                    <p className="text-xs text-muted mt-1">Recommended: 200x200px, PNG or JPG</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div><label className="block text-xs font-medium text-muted mb-1.5">Store Name</label><input type="text" name="storeName" defaultValue={storeSettings?.storeName || ''} className="w-full" /></div>
                  <div><label className="block text-xs font-medium text-muted mb-1.5">Phone</label><input type="tel" name="phone" defaultValue={storeSettings?.phone || ''} className="w-full" /></div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">WhatsApp Number</label>
                    <input type="tel" name="whatsappNumber" defaultValue={storeSettings?.whatsappNumber || ''} className="w-full" />
                    <p className="text-[10px] text-muted mt-1">Use full number with country code if possible (e.g. +91XXXXXXXXXX).</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Email</label>
                    <input type="email" name="email" defaultValue={storeSettings?.email || ''} className="w-full" />
                  </div>
                </div>
                <div><label className="block text-xs font-medium text-muted mb-1.5">Address</label><textarea rows={2} name="address" defaultValue={storeSettings?.address || ''} className="w-full" /></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div><label className="block text-xs font-medium text-muted mb-1.5">GST Number</label><input type="text" name="gstNumber" defaultValue={storeSettings?.gstNumber || ''} className="w-full" /></div>
                  <div><label className="block text-xs font-medium text-muted mb-1.5">Shift Start Time</label><input type="time" name="shiftStartTime" defaultValue={storeSettings?.shiftStartTime || '09:00'} className="w-full" /></div>
                  <div><label className="block text-xs font-medium text-muted mb-1.5">Shift End Time</label><input type="time" name="shiftEndTime" defaultValue={storeSettings?.shiftEndTime || '20:00'} className="w-full" /></div>
                </div>
                <div className="border-t border-border pt-4 mt-2">
                  <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><FileText className="w-4 h-4 text-accent" /> Invoice & Payment Settings</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Invoice Prefix</label>
                      <input type="text" name="invoicePrefix" defaultValue={storeSettings?.invoicePrefix || 'INV-'} className="w-full" placeholder="e.g. INV-" />
                      <p className="text-[10px] text-muted mt-1">Used for new invoice numbers. Example: INV-0001</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Number Padding</label>
                      <input type="number" name="invoicePadding" min="2" max="8" defaultValue={storeSettings?.invoicePadding || 4} className="w-full" />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-muted mb-1.5">Payment QR URL (optional)</label>
                      <input type="text" name="paymentQr" defaultValue={storeSettings?.paymentQr || ''} className="w-full" placeholder="https://..." />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                    <div><label className="block text-xs font-medium text-muted mb-1.5">Bank Name</label><input type="text" name="bankName" defaultValue={storeSettings?.bankName || ''} className="w-full" /></div>
                    <div><label className="block text-xs font-medium text-muted mb-1.5">Account Holder Name</label><input type="text" name="bankAccountName" defaultValue={storeSettings?.bankAccountName || ''} className="w-full" /></div>
                    <div><label className="block text-xs font-medium text-muted mb-1.5">Account Number</label><input type="text" name="bankAccountNumber" defaultValue={storeSettings?.bankAccountNumber || ''} className="w-full" /></div>
                    <div><label className="block text-xs font-medium text-muted mb-1.5">IFSC Code</label><input type="text" name="bankIfsc" defaultValue={storeSettings?.bankIfsc || ''} className="w-full" /></div>
                    <div><label className="block text-xs font-medium text-muted mb-1.5">UPI ID</label><input type="text" name="bankUpiId" defaultValue={storeSettings?.bankUpiId || ''} className="w-full" placeholder="name@bank" /></div>
                  </div>
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-muted mb-1.5">Invoice Terms</label>
                    <textarea rows={2} name="invoiceTerms" defaultValue={storeSettings?.invoiceTerms || ''} className="w-full" placeholder="e.g. Goods once sold will not be taken back." />
                  </div>
                </div>
                {/* GPS Attendance Settings */}
                <div className="border-t border-border pt-4 mt-2">
                  <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2"><MapPin className="w-4 h-4 text-accent" /> GPS Attendance Settings</h3>
                  <p className="text-xs text-muted mb-4">Staff must be within the geofence radius to clock in. Open this page at your store and click the button below.</p>

                  {/* Detect Location Button */}
                  <button type="button" onClick={handleDetectLocation} disabled={detectingGps}
                    className="flex items-center gap-2 px-4 py-2.5 mb-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-xl text-sm font-semibold transition-all">
                    {detectingGps ? (
                      <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Detecting Location...</>
                    ) : (
                      <><Crosshair className="w-4 h-4" /> Detect Store Location</>
                    )}
                  </button>

                  {/* Detected Location Info */}
                  {gpsDetected && (
                    <div className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl">
                      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 mb-1">Location detected successfully</p>
                      <p className="text-xs text-emerald-600 dark:text-emerald-500">
                        {gpsDetected.lat.toFixed(6)}, {gpsDetected.lng.toFixed(6)}
                      </p>
                      {gpsDetected.address && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-500 mt-1">{gpsDetected.address}</p>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Store Latitude</label>
                      <input type="number" step="any" name="storeLat" defaultValue={storeSettings?.storeLat || ''} placeholder="Auto-detected or enter manually" className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Store Longitude</label>
                      <input type="number" step="any" name="storeLng" defaultValue={storeSettings?.storeLng || ''} placeholder="Auto-detected or enter manually" className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Geofence Radius (meters)</label>
                      <input type="number" name="geofenceRadius" defaultValue={storeSettings?.geofenceRadius || 100} min="10" max="5000" className="w-full" />
                      <p className="text-[10px] text-muted mt-1">Staff must be within this distance to clock in</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap mt-2">
                  <button type="submit" disabled={saving} className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"><Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Changes'}</button>
                  {saveSuccess && (
                    <span className="flex items-center gap-1.5 text-sm font-medium text-green-600">
                      <CheckCircle2 className="w-4 h-4" /> Settings saved successfully
                    </span>
                  )}
                  {saveError && (
                    <span className="flex items-center gap-1.5 text-sm font-medium text-red-600">
                      <XCircle className="w-4 h-4" /> {saveError}
                    </span>
                  )}
                </div>
              </form>
            </div>
          )}

          {activeTab === 'account' && (
            <div className="glass-card p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Account Security</h2>
              <p className="text-xs text-muted mb-4">Update your login username and password. Current password is required for any changes.</p>

              <form onSubmit={handleAccountUpdate} className="space-y-4 max-w-lg">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Current Username</label>
                  <input
                    type="text"
                    value={session?.user?.email || ''}
                    disabled
                    className="w-full bg-surface-hover text-muted"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">New Username (optional)</label>
                  <input
                    type="text"
                    value={accountForm.newUsername}
                    onChange={(e) => setAccountForm(prev => ({ ...prev, newUsername: e.target.value }))}
                    placeholder="e.g. admin123 or name@example.com"
                    autoComplete="username"
                    className="w-full"
                  />
                  <p className="text-[11px] text-muted mt-1">Usernames can be a valid email or a simple handle like <strong>admin123</strong>.</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Current Password</label>
                  <div className="relative">
                    <input
                      type={showAccountPasswords.current ? 'text' : 'password'}
                      value={accountForm.currentPassword}
                      onChange={(e) => setAccountForm(prev => ({ ...prev, currentPassword: e.target.value }))}
                      autoComplete="current-password"
                      required
                      className="w-full pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAccountPasswords(prev => ({ ...prev, current: !prev.current }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground"
                    >
                      {showAccountPasswords.current ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">New Password (optional)</label>
                    <div className="relative">
                      <input
                        type={showAccountPasswords.new ? 'text' : 'password'}
                        value={accountForm.newPassword}
                        onChange={(e) => setAccountForm(prev => ({ ...prev, newPassword: e.target.value }))}
                        autoComplete="new-password"
                        placeholder="Minimum 6 characters"
                        className="w-full pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAccountPasswords(prev => ({ ...prev, new: !prev.new }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground"
                      >
                        {showAccountPasswords.new ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Confirm New Password</label>
                    <div className="relative">
                      <input
                        type={showAccountPasswords.confirm ? 'text' : 'password'}
                        value={accountForm.confirmPassword}
                        onChange={(e) => setAccountForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                        autoComplete="new-password"
                        placeholder="Re-enter new password"
                        className="w-full pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAccountPasswords(prev => ({ ...prev, confirm: !prev.confirm }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground"
                      >
                        {showAccountPasswords.confirm ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>

                {accountError && (
                  <p className="text-xs text-danger">{accountError}</p>
                )}
                {accountSuccess && (
                  <p className="text-xs text-success">{accountSuccess}</p>
                )}

                <button
                  type="submit"
                  disabled={accountSaving}
                  className="flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                >
                  {accountSaving ? 'Updating...' : 'Update Account'}
                </button>
              </form>
            </div>
          )}

          {activeTab === 'team' && (
            <div className="glass-card p-4 sm:p-6">
              <div className="flex items-center justify-between mb-4 sm:mb-5">
                <h2 className="text-lg font-semibold text-foreground">Team Members</h2>
                <button
                  onClick={() => {
                    setShowInviteForm(prev => !prev);
                    setInviteError('');
                    setInviteSuccess('');
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"
                >
                  <Plus className="w-4 h-4" /> {showInviteForm ? 'Close' : 'Invite'}
                </button>
              </div>

              {inviteSuccess && <p className="mb-3 text-xs text-success">{inviteSuccess}</p>}
              {inviteError && <p className="mb-3 text-xs text-danger">{inviteError}</p>}

              {showInviteForm && (
                <form onSubmit={handleInviteMember} className="mb-5 p-4 rounded-xl bg-surface border border-border space-y-3">
                  <p className="text-xs text-muted">Add a team member and optionally assign login credentials. Username can be anything unique (e.g. <strong>rahul123</strong>) — no email required.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Full Name</label>
                      <input
                        type="text"
                        value={inviteForm.name}
                        onChange={e => setInviteForm(prev => ({ ...prev, name: e.target.value }))}
                        required
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Role</label>
                      <input
                        list="staff-role-options"
                        value={inviteForm.role}
                        onChange={e => setInviteForm(prev => ({ ...prev, role: e.target.value }))}
                        placeholder="e.g. Sales Executive"
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Phone</label>
                      <input
                        type="tel"
                        value={inviteForm.phone}
                        onChange={e => setInviteForm(prev => ({ ...prev, phone: e.target.value }))}
                        required
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Staff Email</label>
                      <input
                        type="email"
                        value={inviteForm.email}
                        onChange={e => setInviteForm(prev => ({ ...prev, email: e.target.value }))}
                        required
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Login Username <span className="text-muted font-normal">(optional, e.g. rahul123)</span></label>
                      <input
                        type="text"
                        value={inviteForm.loginUsername}
                        onChange={e => setInviteForm(prev => ({ ...prev, loginUsername: e.target.value }))}
                        placeholder="e.g. rahul123 or john.doe"
                        autoComplete="off"
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Login Password</label>
                      <input
                        type="password"
                        value={inviteForm.loginPassword}
                        onChange={e => setInviteForm(prev => ({ ...prev, loginPassword: e.target.value }))}
                        placeholder="Minimum 4 characters"
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Join Date</label>
                      <input
                        type="date"
                        value={inviteForm.joinDate}
                        onChange={e => setInviteForm(prev => ({ ...prev, joinDate: e.target.value }))}
                        required
                        className="w-full"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={inviting}
                      className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white rounded-xl text-sm font-semibold transition-all"
                    >
                      {inviting ? 'Adding...' : 'Add Team Member'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInviteForm(getInitialInviteForm());
                        setInviteError('');
                        setInviteSuccess('');
                      }}
                      className="px-3 py-2 border border-border rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-all"
                    >
                      Reset
                    </button>
                  </div>
                </form>
              )}

              {assignLoginSuccess && <p className="mb-3 text-xs text-success">{assignLoginSuccess}</p>}
              {assignLoginError && <p className="mb-3 text-xs text-danger">{assignLoginError}</p>}

              {showLoginSetupForm && (
                <form onSubmit={handleAssignLogin} className="mb-5 p-4 rounded-xl bg-surface border border-border space-y-3">
                  <p className="text-xs text-muted">Assign login credentials for an existing team member.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Team Member</label>
                      <select
                        value={loginSetupForm.staffId}
                        onChange={e => setLoginSetupForm(prev => ({ ...prev, staffId: e.target.value }))}
                        required
                        className="w-full"
                      >
                        <option value="">Select member</option>
                        {teamMembers.filter(m => !m.hasLogin).map(m => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Login Username</label>
                      <input
                        type="text"
                        value={loginSetupForm.loginUsername}
                        onChange={e => setLoginSetupForm(prev => ({ ...prev, loginUsername: e.target.value }))}
                        placeholder="e.g. rahul123 or john.doe"
                        autoComplete="off"
                        required
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Login Password</label>
                      <input
                        type="password"
                        value={loginSetupForm.loginPassword}
                        onChange={e => setLoginSetupForm(prev => ({ ...prev, loginPassword: e.target.value }))}
                        required
                        minLength={4}
                        className="w-full"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={assigningLogin}
                      className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white rounded-xl text-sm font-semibold transition-all"
                    >
                      {assigningLogin ? 'Assigning...' : 'Assign Login'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowLoginSetupForm(false);
                        setAssignLoginError('');
                        setAssignLoginSuccess('');
                        setLoginSetupForm({ staffId: '', loginUsername: '', loginPassword: '' });
                      }}
                      className="px-3 py-2 border border-border rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {editSuccess && <p className="mb-3 text-xs text-success">{editSuccess}</p>}
              {editError && <p className="mb-3 text-xs text-danger">{editError}</p>}

              {showEditForm && (
                <form onSubmit={handleUpdateMember} className="mb-5 p-4 rounded-xl bg-surface border border-border space-y-3">
                  <p className="text-xs text-muted">Update team member profile and optionally reset login password.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Full Name</label>
                      <input type="text" value={editForm.name} onChange={e => setEditForm(prev => ({ ...prev, name: e.target.value }))} required className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Role</label>
                      <input
                        list="staff-role-options"
                        value={editForm.role}
                        onChange={e => setEditForm(prev => ({ ...prev, role: e.target.value }))}
                        placeholder="e.g. Sales Executive"
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Status</label>
                      <select value={editForm.status} onChange={e => setEditForm(prev => ({ ...prev, status: e.target.value }))} className="w-full">
                        <option value="Active">Active</option>
                        <option value="Off Duty">Off Duty</option>
                        <option value="Inactive">Inactive</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Phone</label>
                      <input type="tel" value={editForm.phone} onChange={e => setEditForm(prev => ({ ...prev, phone: e.target.value }))} required className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Staff Email</label>
                      <input type="email" value={editForm.email} onChange={e => setEditForm(prev => ({ ...prev, email: e.target.value }))} required className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Join Date</label>
                      <input type="date" value={editForm.joinDate} onChange={e => setEditForm(prev => ({ ...prev, joinDate: e.target.value }))} required className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Login Username</label>
                      <input type="text" value={editForm.loginUsername} onChange={e => setEditForm(prev => ({ ...prev, loginUsername: e.target.value }))} placeholder="e.g. rahul123" autoComplete="off" className="w-full" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">New Password (optional)</label>
                      <input type="password" value={editForm.loginPassword} onChange={e => setEditForm(prev => ({ ...prev, loginPassword: e.target.value }))} placeholder="Leave blank to keep current" className="w-full" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="submit" disabled={editingMember} className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white rounded-xl text-sm font-semibold transition-all">
                      {editingMember ? 'Saving...' : 'Save Member'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowEditForm(false);
                        setEditError('');
                        setEditSuccess('');
                        setEditForm(getInitialEditForm());
                      }}
                      className="px-3 py-2 border border-border rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              <datalist id="staff-role-options">
                {staffRoleOptions.map(role => (
                  <option key={role} value={role} />
                ))}
              </datalist>

              {/* Desktop table */}
              <table className="crm-table hidden sm:table">
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Login</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  {teamMembers.map((m) => (
                    <tr key={m.id}>
                      <td className="font-medium text-foreground">{m.name}</td>
                      <td className="text-muted">{m.email}</td>
                      <td><span className="badge bg-accent-light text-accent">{m.role}</span></td>
                      <td>
                        {m.hasLogin ? (
                          <div className="flex flex-col">
                            <span className="text-xs text-foreground">{m.loginUsername}</span>
                            <span className={`text-[10px] ${m.loginActive ? 'text-success' : 'text-muted'}`}>{m.loginActive ? 'Active login' : 'Login disabled'}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted">Not assigned</span>
                            <button
                              onClick={() => openAssignLoginForm(m)}
                              className="text-[10px] px-2 py-0.5 rounded border border-border text-accent hover:bg-accent/10 transition-colors"
                            >
                              Set Login
                            </button>
                          </div>
                        )}
                      </td>
                      <td><span className={`badge ${m.status === 'Active' ? 'bg-success-light text-success' : 'bg-info-light text-info'}`}>{m.status}</span></td>
                      <td>
                        <button
                          onClick={() => openEditMemberForm(m)}
                          className="text-[10px] px-2 py-0.5 rounded border border-border text-accent hover:bg-accent/10 transition-colors"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Mobile cards */}
              <div className="space-y-3 sm:hidden">
                {teamMembers.map((m) => (
                  <div key={m.id} className="p-3 rounded-xl bg-surface border border-border">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">{m.name}</p>
                        <p className="text-xs text-muted mt-0.5">{m.email}</p>
                        <p className="text-[11px] text-muted mt-1">Login: {m.hasLogin ? m.loginUsername : 'Not assigned'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="badge bg-accent-light text-accent">{m.role}</span>
                      <span className={`badge ${m.status === 'Active' ? 'bg-success-light text-success' : 'bg-info-light text-info'}`}>{m.status}</span>
                      <button
                        onClick={() => openEditMemberForm(m)}
                        className="text-[10px] px-2 py-0.5 rounded border border-border text-accent hover:bg-accent/10 transition-colors"
                      >
                        Edit
                      </button>
                      {!m.hasLogin && (
                        <button
                          onClick={() => openAssignLoginForm(m)}
                          className="text-[10px] px-2 py-0.5 rounded border border-border text-accent hover:bg-accent/10 transition-colors"
                        >
                          Set Login
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-1">Social Media Channels</h2>
                <p className="text-xs text-muted">Connect platforms to receive and send messages from the Conversations page</p>
              </div>

              {channelDefinitions.map(def => {
                const config = channelConfigs[def.channel];
                const isExpanded = expandedChannel === def.channel;
                const isConnected = config?.enabled;
                const formData = channelForms[def.channel] || {};
                const isSaving = channelSaving === def.channel;
                const justSaved = channelSaved === def.channel;

                return (
                  <div key={def.channel} className="glass-card overflow-hidden">
                    <div
                      className="p-4 sm:p-5 flex items-center justify-between cursor-pointer hover:bg-surface-hover/50 transition-colors"
                      onClick={() => setExpandedChannel(isExpanded ? null : def.channel)}
                    >
                      <div className="flex items-center gap-3 sm:gap-4">
                        <span className="text-2xl sm:text-3xl flex-shrink-0">{def.icon}</span>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{def.name}</p>
                          <p className="text-xs text-muted">{def.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-medium ${isConnected ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/20' : 'bg-surface-hover text-muted border border-border'}`}>
                          {isConnected ? 'Connected' : 'Not Connected'}
                        </span>
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-muted" /> : <ChevronDown className="w-4 h-4 text-muted" />}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-4 sm:px-5 pb-5 border-t border-border pt-4 space-y-4">
                        {/* Webhook URL */}
                        {config?.webhookUrl && (
                          <div className="p-3 rounded-xl bg-surface border border-border">
                            <p className="text-[10px] text-muted uppercase tracking-wide mb-1.5">Webhook URL — paste this in your {def.name} settings</p>
                            <div className="flex items-center gap-2">
                              <code className="flex-1 text-xs text-foreground bg-surface-hover px-3 py-2 rounded-lg font-mono overflow-x-auto">{config.webhookUrl}</code>
                              <button
                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(config.webhookUrl); setCopiedWebhook(def.channel); setTimeout(() => setCopiedWebhook(null), 2000); }}
                                className="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-foreground transition-colors flex-shrink-0"
                              >
                                {copiedWebhook === def.channel ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Config Fields */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {def.fields.map(field => (
                            <div key={field.key}>
                              <label className="block text-xs font-medium text-muted mb-1.5">{field.label}</label>
                              <div className="relative">
                                <input
                                  type={field.type === 'password' && !showSecrets[`${def.channel}-${field.key}`] ? 'password' : 'text'}
                                  placeholder={field.placeholder}
                                  value={formData[field.key] || ''}
                                  onChange={(e) => setChannelForms(prev => ({ ...prev, [def.channel]: { ...prev[def.channel], [field.key]: e.target.value } }))}
                                  className="w-full pr-10"
                                />
                                {field.type === 'password' && (
                                  <button
                                    type="button"
                                    onClick={() => setShowSecrets(prev => ({ ...prev, [`${def.channel}-${field.key}`]: !prev[`${def.channel}-${field.key}`] }))}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground"
                                  >
                                    {showSecrets[`${def.channel}-${field.key}`] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Docs link */}
                        {def.docs && (
                          <p className="text-xs text-muted">
                            Need help? <a href={def.docs} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">View setup documentation</a>
                          </p>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-3 pt-1">
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              setChannelSaving(def.channel);
                              const res = await upsertChannelConfig({
                                channel: def.channel,
                                enabled: true,
                                config: channelForms[def.channel] || {},
                              });
                              if (res.success) {
                                const refreshed = await getChannelConfigs();
                                if (refreshed.success) {
                                  const configMap = {};
                                  refreshed.data.forEach(c => { configMap[c.channel] = c; });
                                  setChannelConfigs(configMap);
                                }
                                setChannelSaved(def.channel);
                                setTimeout(() => setChannelSaved(null), 2000);
                              }
                              setChannelSaving(null);
                            }}
                            disabled={isSaving}
                            className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                          >
                            {isSaving ? 'Saving...' : justSaved ? <><Check className="w-4 h-4" /> Saved!</> : <><Save className="w-4 h-4" /> Save & Enable</>}
                          </button>

                          {isConnected && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                setChannelSaving(def.channel);
                                await upsertChannelConfig({
                                  channel: def.channel,
                                  enabled: false,
                                  config: channelForms[def.channel] || {},
                                });
                                const refreshed = await getChannelConfigs();
                                if (refreshed.success) {
                                  const configMap = {};
                                  refreshed.data.forEach(c => { configMap[c.channel] = c; });
                                  setChannelConfigs(configMap);
                                }
                                setChannelSaving(null);
                              }}
                              disabled={isSaving}
                              className="px-4 py-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-700 rounded-xl text-sm font-medium border border-red-500/20 transition-all disabled:opacity-50"
                            >
                              Disconnect
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Non-channel integrations */}
              <div className="mt-6">
                <h2 className="text-lg font-semibold text-foreground mb-2">Other Integrations</h2>
                <IndiaMartIntegrationSettings />
                {nonChannelIntegrations.map((int, i) => (
                  <div key={i} className="glass-card p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between mt-3">
                    <div className="flex items-center gap-3 sm:gap-4">
                      <span className="text-2xl sm:text-3xl flex-shrink-0">{int.icon}</span>
                      <div><p className="text-sm font-semibold text-foreground">{int.name}</p><p className="text-xs text-muted">{int.description}</p></div>
                    </div>
                    <button className={`w-full sm:w-auto px-4 py-2 rounded-xl text-sm font-medium transition-all text-center flex-shrink-0 ${int.connected ? 'bg-success-light text-success border border-success/20' : 'bg-accent hover:bg-accent-hover text-white'}`}>
                      {int.connected ? 'Connected' : 'Connect'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'email' && (
            <div className="space-y-5">
              <div className="glass-card p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
                  <Mail className="w-5 h-5 text-accent" /> Email Setup (SMTP)
                </h2>
                <p className="text-sm text-muted mb-5">Configure your business email to send campaigns, follow-ups, and transactional emails to customers.</p>

                <div className="space-y-4 max-w-2xl">
                  {/* SMTP Presets */}
                  <div>
                    <label className="block text-xs font-medium text-muted mb-2">Quick Setup — Select Your Email Provider</label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { name: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
                        { name: 'Outlook', host: 'smtp.office365.com', port: 587, secure: false },
                        { name: 'Yahoo', host: 'smtp.mail.yahoo.com', port: 465, secure: true },
                        { name: 'Zoho', host: 'smtp.zoho.in', port: 587, secure: false },
                        { name: 'GoDaddy', host: 'smtpout.secureserver.net', port: 465, secure: true },
                      ].map(preset => (
                        <button key={preset.name} type="button"
                          onClick={() => setSmtpForm(f => ({ ...f, smtpHost: preset.host, smtpPort: preset.port, smtpSecure: preset.secure }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${smtpForm.smtpHost === preset.host ? 'bg-accent text-white' : 'bg-surface-hover text-muted hover:text-foreground'}`}>
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">SMTP Host *</label>
                      <input type="text" placeholder="smtp.gmail.com" value={smtpForm.smtpHost}
                        onChange={e => setSmtpForm(f => ({ ...f, smtpHost: e.target.value }))}
                        className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">SMTP Port</label>
                      <input type="number" value={smtpForm.smtpPort}
                        onChange={e => setSmtpForm(f => ({ ...f, smtpPort: parseInt(e.target.value) || 587 }))}
                        className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Email Address *</label>
                      <input type="email" placeholder="your-business@gmail.com" value={smtpForm.smtpUser}
                        onChange={e => setSmtpForm(f => ({ ...f, smtpUser: e.target.value }))}
                        className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">App Password *</label>
                      <div className="relative">
                        <input type={showSmtpPass ? 'text' : 'password'} placeholder="App-specific password" value={smtpForm.smtpPass}
                          onChange={e => setSmtpForm(f => ({ ...f, smtpPass: e.target.value }))}
                          className="w-full px-4 py-2.5 pr-10 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                        <button type="button" onClick={() => setShowSmtpPass(!showSmtpPass)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground">
                          {showSmtpPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Display Name (From)</label>
                      <input type="text" placeholder={`e.g. ${brand.name}`} value={smtpForm.smtpFromName}
                        onChange={e => setSmtpForm(f => ({ ...f, smtpFromName: e.target.value }))}
                        className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                    <div className="flex items-center gap-3 pt-6">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={smtpForm.smtpSecure}
                          onChange={e => setSmtpForm(f => ({ ...f, smtpSecure: e.target.checked }))}
                          className="w-4 h-4 rounded border-border accent-accent" />
                        <span className="text-sm text-foreground">Use SSL (port 465)</span>
                      </label>
                    </div>
                  </div>

                  {/* Gmail Setup Info */}
                  {smtpForm.smtpHost === 'smtp.gmail.com' && (
                    <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-amber-700">
                      <strong>Gmail Setup:</strong> You need to use an <strong>App Password</strong>, not your regular password.
                      Go to <em>Google Account → Security → 2-Step Verification → App Passwords</em>, generate one for &quot;Mail&quot;, and paste it above.
                    </div>
                  )}

                  {/* Test & Save Actions */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 pt-3 border-t border-border">
                    {/* Test Connection */}
                    <button
                      onClick={async () => {
                        setSmtpTesting(true); setSmtpTestResult(null);
                        const res = await testSmtp(smtpForm);
                        setSmtpTestResult(res);
                        setSmtpTesting(false);
                      }}
                      disabled={smtpTesting || !smtpForm.smtpHost || !smtpForm.smtpUser || !smtpForm.smtpPass}
                      className="px-4 py-2.5 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 flex items-center gap-2">
                      {smtpTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                      Test Connection
                    </button>

                    {/* Send Test Email */}
                    <div className="flex items-center gap-2 flex-1">
                      <input type="email" placeholder="Send test to..." value={smtpTestEmail}
                        onChange={e => setSmtpTestEmail(e.target.value)}
                        className="flex-1 min-w-[200px] px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                      <button
                        onClick={async () => {
                          if (!smtpTestEmail) return;
                          setSmtpSending(true); setSmtpSendResult(null);
                          const res = await sendSmtpTestEmail(smtpForm, smtpTestEmail);
                          setSmtpSendResult(res);
                          setSmtpSending(false);
                        }}
                        disabled={smtpSending || !smtpTestEmail || !smtpForm.smtpHost || !smtpForm.smtpUser || !smtpForm.smtpPass}
                        className="px-4 py-2.5 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap">
                        {smtpSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        Send Test
                      </button>
                    </div>

                    {/* Save */}
                    <button
                      onClick={async () => {
                        setSmtpSaving(true);
                        const res = await updateStoreSettings({ ...smtpForm, smtpConfigured: true });
                        if (res.success) {
                          setStoreSettings(prev => ({ ...prev, ...smtpForm, smtpConfigured: true }));
                          alert('SMTP settings saved!');
                        } else alert(res.error);
                        setSmtpSaving(false);
                      }}
                      disabled={smtpSaving || !smtpForm.smtpHost || !smtpForm.smtpUser || !smtpForm.smtpPass}
                      className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50 flex items-center gap-2 whitespace-nowrap">
                      {smtpSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Save Settings
                    </button>
                  </div>

                  {/* Status Messages */}
                  {smtpTestResult && (
                    <div className={`flex items-center gap-2 p-3 rounded-xl text-sm ${smtpTestResult.success ? 'bg-success-light text-success' : 'bg-red-500/10 text-red-500'}`}>
                      {smtpTestResult.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                      {smtpTestResult.success ? 'SMTP connection successful!' : `Connection failed: ${smtpTestResult.error}`}
                    </div>
                  )}
                  {smtpSendResult && (
                    <div className={`flex items-center gap-2 p-3 rounded-xl text-sm ${smtpSendResult.success ? 'bg-success-light text-success' : 'bg-red-500/10 text-red-500'}`}>
                      {smtpSendResult.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                      {smtpSendResult.success ? `Test email sent to ${smtpTestEmail}!` : `Failed: ${smtpSendResult.error}`}
                    </div>
                  )}

                  {/* Current Status */}
                  {storeSettings?.smtpConfigured && (
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-success-light/50 text-success text-sm">
                      <CheckCircle2 className="w-4 h-4" />
                      Email is configured and ready — sending from <strong>{storeSettings.smtpUser}</strong>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="glass-card p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4 sm:mb-5">Notification Preferences</h2>
              <div className="space-y-4 max-w-2xl">
                {[
                  { label: 'New lead received', desc: 'Get notified when a new lead comes in', on: true },
                  { label: 'Appointment reminders', desc: '24hr and 2hr before appointments', on: true },
                  { label: 'Low stock alerts', desc: 'When inventory falls below threshold', on: true },
                  { label: 'Order status changes', desc: 'When orders are shipped or delivered', on: true },
                  { label: 'Negative reviews', desc: 'Alert when 1-2 star review is posted', on: true },
                  { label: 'Campaign completion', desc: 'When a campaign finishes sending', on: false },
                  { label: 'Daily summary email', desc: 'Daily digest of leads, orders, revenue', on: false },
                ].map((n, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-surface hover:bg-surface-hover transition-colors">
                    <div><p className="text-sm font-medium text-foreground">{n.label}</p><p className="text-xs text-muted">{n.desc}</p></div>
                    <div className={`w-10 h-6 rounded-full flex items-center cursor-pointer transition-all ${n.on ? 'bg-accent justify-end' : 'bg-border justify-start'}`}>
                      <div className="w-4.5 h-4.5 m-0.5 bg-white rounded-full shadow" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Stock Check Action */}
              <div className="mt-6 pt-6 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2"><Package className="w-4 h-4 text-warning" /> Stock Alert Check</h3>
                <p className="text-xs text-muted mb-3">Manually scan inventory and send low-stock alerts to all managers via in-app notification, email, and WhatsApp.</p>
                <button
                  type="button"
                  onClick={async () => {
                    setStockCheckRunning(true);
                    setStockCheckResult(null);
                    try {
                      const data = await runStockCheck();
                      if (data.success) {
                        setStockCheckResult({ ok: true, msg: data.message || `${data.alertsSent} alert(s) sent` });
                      } else {
                        setStockCheckResult({ ok: false, msg: data.error || 'Failed to run stock check' });
                      }
                    } catch (err) {
                      setStockCheckResult({ ok: false, msg: 'An error occurred. Please try again.' });
                    } finally {
                      setStockCheckRunning(false);
                    }
                  }}
                  disabled={stockCheckRunning}
                  className="flex items-center gap-2 px-4 py-2 bg-warning/10 hover:bg-warning/20 text-warning border border-warning/20 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${stockCheckRunning ? 'animate-spin' : ''}`} />
                  {stockCheckRunning ? 'Checking...' : 'Run Stock Check Now'}
                </button>
                {stockCheckResult && (
                  <p className={`mt-2 text-sm font-medium flex items-center gap-1.5 ${stockCheckResult.ok ? 'text-green-600' : 'text-red-600'}`}>
                    {stockCheckResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    {stockCheckResult.msg}
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'erp' && <ErpPoliciesSettings />}

          {activeTab === 'ai' && (
            <div className="glass-card p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4 sm:mb-5">AI Configuration</h2>
              <div className="space-y-5 max-w-2xl">
                <div className="p-4 rounded-xl bg-surface border border-border">
                  <div className="flex items-center justify-between mb-3">
                    <div><p className="text-sm font-semibold text-foreground">AI Chatbot</p><p className="text-xs text-muted">Automatically respond to customer queries</p></div>
                    <div className="w-10 h-6 rounded-full flex items-center bg-accent justify-end cursor-pointer"><div className="w-4.5 h-4.5 m-0.5 bg-white rounded-full shadow" /></div>
                  </div>
                </div>
                <div><label className="block text-xs font-medium text-muted mb-1.5">Bot Personality</label>
                  <select className="w-full"><option>Friendly & Professional</option><option>Formal</option><option>Casual</option></select>
                </div>
                <div><label className="block text-xs font-medium text-muted mb-1.5">Welcome Message</label>
                  <textarea rows={3} defaultValue={brand.vertical === 'tiles' ? `Welcome to ${brand.name}. We help with tiles, granite, marble, quartz, slab selection and fabrication. Please share your application and approximate area in sq.ft.` : 'Welcome to Kosmic Furniture. We provide modular office, school, and hospital furniture solutions across India. How may we help you today?'} className="w-full" />
                </div>
                <div><label className="block text-xs font-medium text-muted mb-1.5">Auto Follow-up Schedule</label>
                  <div className="space-y-2">
                    {['Day 1: Share product catalog', 'Day 3: Schedule showroom visit', 'Day 7: Share discount offer'].map((d, i) => (
                      <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-surface-hover text-sm text-foreground"><Bot className="w-4 h-4 text-accent flex-shrink-0" />{d}</div>
                    ))}
                  </div>
                </div>
                <button className="flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"><Save className="w-4 h-4" /> Save AI Settings</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
