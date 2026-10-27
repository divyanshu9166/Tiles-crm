/* eslint-disable @next/next/no-img-element */
'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Search, Plus, UserPlus, Users, Clock, TrendingUp, CheckCircle2,
  Phone, Mail, DollarSign, Eye, Filter, ShoppingBag, ArrowRight, MessageSquare,
  X, UserCheck, UserX, Timer, QrCode, Download, Printer, Trash2,
} from 'lucide-react';
import Modal from '@/components/Modal';
import { getWalkins, createWalkin, updateWalkinStatus } from '@/app/actions/walkins';
import { createLead } from '@/app/actions/leads';
import { moveWalkinToDraft } from '@/app/actions/drafts';
import { getStaff } from '@/app/actions/staff';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { getBrand, getActiveVertical } from '@/lib/brand';

const brand = getBrand();
const IS_TGM = getActiveVertical() === 'tiles';
const REQUIREMENT_OPTIONS = IS_TGM
  ? [
      'Floor Tiles', 'Wall Tiles', 'Outdoor / Anti-Skid Tiles',
      'Granite Kitchen Platform', 'Marble Flooring', 'Wall Cladding',
      'Vanity Top', 'Staircase', 'Engineered Quartz', 'Tile Adhesive / Grout', 'Other',
    ]
  : [
      'Sofa / Sofa Set', 'Bed', 'Dining Table', 'Wardrobe', 'Office Chair',
      'TV Unit', 'Bookshelf / Storage', 'Kids Furniture', 'Modular Kitchen',
      'Dressing Table', 'Center Table', 'Other',
    ];

const walkinStatuses = ['All', 'Browsing', 'Interested', 'Follow-up', 'Converted', 'Left'];
const TGM_ROOM_OPTIONS = ['Kitchen', 'Living Room', 'Bedroom', 'Bathroom', 'Staircase', 'Balcony / Outdoor', 'Commercial Space', 'Other'];
const TGM_MATERIAL_OPTIONS = ['Tiles', 'Granite', 'Marble', 'Quartzite', 'Engineered Quartz', 'Adhesive / Grout', 'Other'];

const statusConfig = {
  Browsing: { cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20', icon: Eye },
  Interested: { cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20', icon: TrendingUp },
  'Follow-up': { cls: 'bg-purple-500/10 text-purple-700 border-purple-500/20', icon: Clock },
  Converted: { cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20', icon: CheckCircle2 },
  Left: { cls: 'bg-red-500/10 text-red-700 border-red-500/20', icon: UserX },
};

const normalizePhoneNumber = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  const trimmed = digits.replace(/^0+/, '');
  if (!trimmed) return '';
  if (trimmed.length === 10) return `91${trimmed}`;
  return trimmed;
};

const buildWhatsAppUrl = (phone, message) => {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return '';
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
};

const buildWalkinWhatsAppMessage = (walkin) => {
  const requirement = walkin?.requirement ? ` about ${walkin.requirement}` : '';
  return `Hello ${walkin?.name || ''}, this is regarding your visit${requirement}.`.trim();
};

export default function WalkinsPage() {
  const router = useRouter();
  const alertToast = useAlertToast?.() || { notify: (m) => alert(m) };
  
  const [walkins, setWalkins] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [selectedWalkin, setSelectedWalkin] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', requirement: '', roomType: '', materialCategory: '', areaSqft: '', budget: '', assignedToId: '', notes: '' });
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [walkinToDraft, setWalkinToDraft] = useState(null);
  const [deletingWalkin, setDeletingWalkin] = useState(false);

  useEffect(() => {
    Promise.all([getWalkins(), getStaff()]).then(([walkinsRes, staffRes]) => {
      if (walkinsRes.success) setWalkins(walkinsRes.data);
      if (staffRes.success) setStaff(staffRes.data);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => walkins.filter(w => {
    const matchesSearch = w.name.toLowerCase().includes(search.toLowerCase()) || w.phone.includes(search) || w.requirement.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'All' || w.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [search, statusFilter, walkins]);

  const todayStr = new Date().toISOString().split('T')[0];
  const todayWalkins = walkins.filter(w => w.date === todayStr);
  const todayConverted = todayWalkins.filter(w => w.status === 'Converted').length;
  const todayInterested = todayWalkins.filter(w => w.status === 'Interested' || w.status === 'Follow-up').length;
  const conversionRate = todayWalkins.length > 0 ? Math.round((todayConverted / todayWalkins.length) * 100) : 0;

  const salespeople = staff.filter(s => (s.role || '').includes('Sales') || s.role === 'Design Consultant');

  const generateQr = async (customUrl) => {
    // Use custom URL or detect local network IP for mobile scanning
    const validCustom = typeof customUrl === 'string' && customUrl.startsWith('http') ? customUrl : null;
    let baseUrl = validCustom || window.location.origin;

    // If running on localhost, try to get local network IP
    if (!validCustom && (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1'))) {
      try {
        const port = window.location.port || '3000';
        // Use WebRTC to detect local IP
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const ip = await new Promise((resolve) => {
          pc.onicecandidate = (e) => {
            if (!e.candidate) return;
            const match = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (match && !match[1].startsWith('0.')) {
              resolve(match[1]);
              pc.close();
            }
          };
          // Fallback after 2 seconds
          setTimeout(() => resolve(null), 2000);
        });
        if (ip) baseUrl = `http://${ip}:${port}`;
      } catch { /* fallback to localhost */ }
    }

    const url = `${baseUrl}/walkin-form`;
    setQrUrl(url);
    const dataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: '#1a1a1a', light: '#ffffff' },
    });
    setQrDataUrl(dataUrl);
    setShowQrModal(true);
  };

  const downloadQr = () => {
    const link = document.createElement('a');
    link.download = 'walkin-qr-code.png';
    link.href = qrDataUrl;
    link.click();
  };

  const printQr = () => {
    const win = window.open('', '_blank');
    win.document.write(`
      <html><head><title>Walk-in QR Code</title>
      <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;}
      img{width:300px;height:300px;} h1{font-size:24px;margin-bottom:8px;} p{color:#666;font-size:14px;margin:4px 0;}
      .box{border:2px dashed #ccc;border-radius:16px;padding:40px;text-align:center;}</style></head>
      <body><div class="box">
        <h1>Scan to Register</h1>
        <p>Welcome! Please scan this QR code</p>
        <p>to register your visit</p>
        <img src="${qrDataUrl}" />
        <p style="margin-top:16px;font-size:12px;color:#999;">Powered by ${brand.name}</p>
      </div></body></html>
    `);
    win.document.close();
    win.print();
  };

  const handleStatusUpdate = async (walkinId, newStatus) => {
    await updateWalkinStatus(walkinId, newStatus);
    const refreshed = await getWalkins();
    if (refreshed.success) {
      setWalkins(refreshed.data);
      const fresh = refreshed.data.find(w => w.id === walkinId);
      if (fresh) setSelectedWalkin(fresh);
    }
  };

  const handleRegister = async () => {
    if (!form.name || !form.phone || !form.requirement) return;
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        phone: form.phone,
        email: form.email || undefined,
        requirement: form.requirement,
        roomType: form.roomType || undefined,
        materialCategory: form.materialCategory || undefined,
        areaSqft: form.areaSqft ? Number(form.areaSqft) : undefined,
        budget: form.budget || undefined,
        assignedToId: form.assignedToId ? Number(form.assignedToId) : undefined,
        notes: form.notes || undefined,
      };
      const res = await createWalkin(payload);
      if (res.success) {
        const refreshed = await getWalkins();
        if (refreshed.success) setWalkins(refreshed.data);
        setForm({ name: '', phone: '', email: '', requirement: '', roomType: '', materialCategory: '', areaSqft: '', budget: '', assignedToId: '', notes: '' });
        setShowRegisterModal(false);
        alertToast.notify?.('Walk-in registered', { variant: 'success' });
      } else {
        alertToast.notify?.(res.error || 'Could not register the walk-in', { variant: 'danger' });
      }
    } catch (err) {
      console.error('Failed to register walk-in:', err);
      alertToast.notify?.('Could not register the walk-in. Please try again.', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleConvertToLead = async () => {
    if (!selectedWalkin) return;
    try {
      const res = await createLead({
        name: selectedWalkin.name,
        phone: selectedWalkin.phone,
        email: selectedWalkin.email || undefined,
        source: 'Showroom Visit',
        interest: selectedWalkin.requirement,
        materialCategory: selectedWalkin.materialCategory || undefined,
        applicationArea: selectedWalkin.roomType || undefined,
        areaSqft: selectedWalkin.areaSqft || undefined,
        budget: selectedWalkin.budget || '',
        notes: `Converted from walk-in: ${selectedWalkin.notes || ''}`,
      });
      if (res.success) {
        await handleStatusUpdate(selectedWalkin.id, 'Converted');
        alertToast.notify?.('Converted to lead successfully!', 'success');
      } else {
        alertToast.notify?.(res.error || 'Failed to convert to lead', 'error');
      }
    } catch (err) {
      console.error(err);
      alertToast.notify?.('Error converting to lead', 'error');
    }
  };

  const handleMoveToDraft = () => {
    if (!selectedWalkin) return;
    setWalkinToDraft(selectedWalkin);
  };

  const handleWalkinWhatsApp = (walkin) => {
    const message = buildWalkinWhatsAppMessage(walkin);
    const url = buildWhatsAppUrl(walkin?.phone, message);
    if (!url) {
      alertToast.notify?.('Walk-in phone number is missing', 'error');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const confirmMoveToDraft = async () => {
    if (!walkinToDraft) return;
    setDeletingWalkin(true);
    try {
      const res = await moveWalkinToDraft(walkinToDraft.id);
      if (res?.success) {
        setSelectedWalkin(null);
        const refreshed = await getWalkins();
        if (refreshed.success) setWalkins(refreshed.data);
        alertToast.notify?.('Walk-in moved to drafts', 'success');
      } else {
        alertToast.notify?.(res?.error || 'Failed to move walk-in to drafts', 'error');
      }
    } catch (err) {
      alertToast.notify?.(err?.message || 'Failed to move walk-in to drafts', 'error');
    } finally {
      setDeletingWalkin(false);
      setWalkinToDraft(null);
    }
  };

  const cancelMoveToDraft = () => setWalkinToDraft(null);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-20 bg-surface rounded-2xl" />)}</div>
        <div className="h-64 bg-surface rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5 md:space-y-6 animate-[fade-in_0.3s_ease]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Walk-in Customers</h1>
          <p className="text-sm text-muted mt-1">Reception desk — Log & track every visitor</p>
        </div>
        <div className="flex w-full sm:w-auto items-center gap-2">
          <button onClick={() => generateQr()} className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 border border-border text-foreground hover:bg-surface-hover rounded-xl text-sm font-medium transition-all">
            <QrCode className="w-4 h-4" /> QR Code
          </button>
          <button onClick={() => setShowRegisterModal(true)} className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
            <UserPlus className="w-4 h-4" /> Register Walk-in
          </button>
        </div>
      </div>

        <Modal isOpen={!!walkinToDraft} onClose={cancelMoveToDraft} title="Move Walk-in to Draft" size="sm">
          {walkinToDraft && (
            <div className="space-y-4">
              <p className="text-sm text-muted">Move <strong className="text-foreground">{walkinToDraft.name}</strong> to drafts? It will be permanently deleted after 30 days.</p>
              <div className="flex justify-end gap-3">
                <button onClick={cancelMoveToDraft} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
                <button onClick={confirmMoveToDraft} disabled={deletingWalkin} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{deletingWalkin ? 'Moving...' : 'Move to Draft'}</button>
              </div>
            </div>
          )}
        </Modal>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-accent-light"><Users className="w-5 h-5 text-accent" /></div>
          <div><p className="text-xs text-muted">Today&apos;s Walk-ins</p><p className="text-lg font-bold text-foreground">{todayWalkins.length}</p></div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-success-light"><CheckCircle2 className="w-5 h-5 text-success" /></div>
          <div><p className="text-xs text-muted">Converted</p><p className="text-lg font-bold text-success">{todayConverted}</p></div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/10"><TrendingUp className="w-5 h-5 text-amber-700" /></div>
          <div><p className="text-xs text-muted">Interested / Follow-up</p><p className="text-lg font-bold text-amber-700">{todayInterested}</p></div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-info-light"><TrendingUp className="w-5 h-5 text-info" /></div>
          <div><p className="text-xs text-muted">Conversion Rate</p><p className="text-lg font-bold text-foreground">{conversionRate}%</p></div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="relative w-full md:flex-1 md:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input type="search" name="walkin-search" autoComplete="off" role="searchbox" placeholder="Search by name, phone, or requirement..." value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-10 pr-4 py-2.5 bg-surface rounded-xl border border-border text-sm" />
        </div>
        <div className="flex gap-1 overflow-x-auto hide-scrollbar pb-1 -mx-1 px-1 md:flex-wrap md:overflow-visible md:pb-0 md:mx-0 md:px-0">
          {walkinStatuses.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`flex-shrink-0 px-3 py-2 md:py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === s ? 'bg-accent text-white' : 'text-muted hover:text-foreground hover:bg-surface-hover'}`}>{s}</button>
          ))}
        </div>
      </div>

      {/* Walk-in Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="crm-table">
            <thead>
                <tr>
                  <th>Time</th>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Requirement</th>
                  <th>Budget</th>
                  <th>Assigned To</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th className="text-right">Actions</th>
                </tr>
            </thead>
            <tbody>
              {filtered.map(w => {
                const sc = statusConfig[w.status] || statusConfig.Browsing;
                return (
                          <tr key={w.id} className="cursor-pointer" onClick={() => setSelectedWalkin(w)}>
                            <td className="text-foreground font-medium">{w.time}</td>
                            <td className="font-medium text-foreground">{w.name}</td>
                            <td className="text-muted">{w.phone}</td>
                            <td>{w.requirement}</td>
                            <td className="text-accent font-medium">{w.budget}</td>
                            <td>
                              <span className="px-2 py-0.5 rounded-full text-xs bg-surface border border-border">{w.assignedTo}</span>
                            </td>
                            <td className="text-muted">{w.visitDuration}</td>
                            <td>
                              <span className={`px-2 py-0.5 rounded-full text-xs border ${sc.cls}`}>{w.status}</span>
                            </td>
                            <td className="text-muted">{w.date}</td>
                            <td className="w-24 text-right">
                              <button
                                onClick={(e) => { e.stopPropagation(); setWalkinToDraft(w); }}
                                className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-400"
                                title="Move to Draft"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Register Walk-in Modal */}
      <Modal isOpen={showRegisterModal} onClose={() => setShowRegisterModal(false)} title="Register Walk-in Customer" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Customer Name *</label>
              <input type="text" name="customer-name" autoComplete="name" placeholder="Full name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Phone Number *</label>
              <input type="tel" name="customer-phone" autoComplete="tel" placeholder="+91 XXXXX XXXXX" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Email (optional)</label>
              <input type="email" name="customer-email" autoComplete="email" placeholder="email@example.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Requirement *</label>
              <select value={form.requirement} onChange={e => setForm(f => ({ ...f, requirement: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
                <option value="">What are they looking for?</option>
                {REQUIREMENT_OPTIONS.map(option => <option key={option}>{option}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Budget Range</label>
              <select value={form.budget} onChange={e => setForm(f => ({ ...f, budget: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
                <option value="">Select budget range</option>
                <option>Under ₹10,000</option>
                <option>₹10,000 - ₹25,000</option>
                <option>₹25,000 - ₹50,000</option>
                <option>₹50,000 - ₹1,00,000</option>
                <option>₹1,00,000 - ₹2,00,000</option>
                <option>₹2,00,000+</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Assign Salesperson</label>
              <select value={form.assignedToId} onChange={e => setForm(f => ({ ...f, assignedToId: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
                <option value="">Select staff</option>
                {salespeople.filter(s => s.status === 'Active').map(s => (
                  <option key={s.id} value={s.id}>{s.name} — {s.role}</option>
                ))}
              </select>
            </div>
          </div>
          {IS_TGM && <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Room / Application</label>
              <select value={form.roomType} onChange={e => setForm(f => ({ ...f, roomType: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
                <option value="">Select room</option>
                {TGM_ROOM_OPTIONS.map(option => <option key={option}>{option}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Material</label>
              <select value={form.materialCategory} onChange={e => setForm(f => ({ ...f, materialCategory: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
                <option value="">Select material</option>
                {TGM_MATERIAL_OPTIONS.map(option => <option key={option}>{option}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Approx. Area (sq.ft)</label>
              <input type="number" min="0" step="0.01" placeholder="e.g. 250" value={form.areaSqft} onChange={e => setForm(f => ({ ...f, areaSqft: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
          </div>}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Notes</label>
            <textarea rows={3} placeholder="Any specific preferences, color, size, etc." value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 resize-none" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowRegisterModal(false)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
            <button onClick={handleRegister} disabled={submitting || !form.name || !form.phone || !form.requirement} className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? 'Registering...' : 'Register Customer'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Walk-in Detail Modal */}
      <Modal isOpen={!!selectedWalkin} onClose={() => setSelectedWalkin(null)} title="Walk-in Details" size="lg">
        {selectedWalkin && (() => {
          const sc = statusConfig[selectedWalkin.status] || statusConfig.Browsing;
          const StatusIcon = sc.icon;
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
                  <UserCheck className="w-7 h-7 text-accent" />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <h3 className="text-lg font-semibold text-foreground">{selectedWalkin.name}</h3>
                  <div className="flex items-center gap-3 text-sm text-muted">
                    <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" />{selectedWalkin.phone}</span>
                    {selectedWalkin.email && <span className="flex items-center gap-1"><Mail className="w-3.5 h-3.5" />{selectedWalkin.email}</span>}
                  </div>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1.5 ${sc.cls}`}>
                  <StatusIcon className="w-3.5 h-3.5" />{selectedWalkin.status}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-surface rounded-xl p-3">
                  <p className="text-xs text-muted mb-1">Requirement</p>
                  <p className="text-sm font-medium text-foreground">{selectedWalkin.requirement}</p>
                </div>
                <div className="bg-surface rounded-xl p-3">
                  <p className="text-xs text-muted mb-1">Budget</p>
                  <p className="text-sm font-medium text-accent">{selectedWalkin.budget}</p>
                </div>
                {IS_TGM && <>
                  <div className="bg-surface rounded-xl p-3"><p className="text-xs text-muted mb-1">Room / Application</p><p className="text-sm font-medium text-foreground">{selectedWalkin.roomType || '—'}</p></div>
                  <div className="bg-surface rounded-xl p-3"><p className="text-xs text-muted mb-1">Material / Area</p><p className="text-sm font-medium text-foreground">{selectedWalkin.materialCategory || '—'}{selectedWalkin.areaSqft ? ` · ${selectedWalkin.areaSqft} sq.ft` : ''}</p></div>
                </>}
                <div className="bg-surface rounded-xl p-3">
                  <p className="text-xs text-muted mb-1">Assigned To</p>
                  <p className="text-sm font-medium text-foreground">{selectedWalkin.assignedTo}</p>
                </div>
                <div className="bg-surface rounded-xl p-3">
                  <p className="text-xs text-muted mb-1">Visit Duration</p>
                  <p className="text-sm font-medium text-foreground">{selectedWalkin.visitDuration}</p>
                </div>
                <div className="bg-surface rounded-xl p-3">
                  <p className="text-xs text-muted mb-1">Date</p>
                  <p className="text-sm font-medium text-foreground">{selectedWalkin.date}</p>
                </div>
                <div className="bg-surface rounded-xl p-3">
                  <p className="text-xs text-muted mb-1">Time</p>
                  <p className="text-sm font-medium text-foreground">{selectedWalkin.time}</p>
                </div>
              </div>

              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Notes</p>
                <p className="text-sm text-foreground">{selectedWalkin.notes}</p>
              </div>

              {/* Status Update */}
              <div>
                <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Update Status</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(statusConfig).map(s => (
                    <button key={s} onClick={() => handleStatusUpdate(selectedWalkin.id, s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                        selectedWalkin.status === s ? `${statusConfig[s].cls}` : 'bg-surface border-border text-muted hover:text-foreground'
                      }`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 pt-2">
                <a href={`tel:${selectedWalkin.phone}`} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 rounded-xl text-sm font-medium hover:bg-emerald-500/20 transition-colors">
                  <Phone className="w-4 h-4" /> Call
                </a>
                <button onClick={() => handleWalkinWhatsApp(selectedWalkin)} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-surface border border-border text-muted rounded-xl text-sm font-medium hover:text-foreground hover:border-emerald-500/30 transition-colors">
                  <MessageSquare className="w-4 h-4" /> WhatsApp
                </button>
                {selectedWalkin.status !== 'Converted' && <button onClick={handleConvertToLead} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent/10 text-accent border border-accent/20 rounded-xl text-sm font-medium hover:bg-accent/20 transition-colors">
                  <ArrowRight className="w-4 h-4" /> Convert to Lead
                </button>}
                <button onClick={() => router.push(`/quotations?new=1&customer=${encodeURIComponent(selectedWalkin.name)}&phone=${encodeURIComponent(selectedWalkin.phone)}${selectedWalkin.email ? `&email=${encodeURIComponent(selectedWalkin.email)}` : ''}`)} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-500/10 text-blue-700 border border-blue-500/20 rounded-xl text-sm font-medium hover:bg-blue-500/20 transition-colors">
                  <ShoppingBag className="w-4 h-4" /> Create Quotation
                </button>
                <button onClick={handleMoveToDraft} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-500/10 text-red-700 border border-red-500/20 rounded-xl text-sm font-medium hover:bg-red-500/20 transition-colors">
                  <Trash2 className="w-4 h-4" /> Move to Draft
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* QR Code Modal */}
      <Modal isOpen={showQrModal} onClose={() => setShowQrModal(false)} title="Walk-in Registration" size="lg">
        <div className="space-y-5">
          {/* Description */}
          <p className="text-sm text-muted">
            Customers scan this QR code or visit the link below to register their walk-in visit at your showroom. Their details will appear in this dashboard in real-time.
          </p>

          {/* QR + Link side by side (desktop) or stacked (mobile) */}
          <div className="flex flex-col md:flex-row gap-5 items-center">
            {/* QR Code */}
            {qrDataUrl && (
              <div className="flex-shrink-0 p-5 bg-white rounded-2xl border-2 border-dashed border-border">
                <img src={qrDataUrl} alt="Walk-in QR Code" className="w-52 h-52 md:w-44 md:h-44" />
              </div>
            )}

            {/* Link + Actions */}
            <div className="flex-1 space-y-4 w-full">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted font-semibold mb-1.5">Shareable Link</label>
                <div className="flex gap-2">
                  <div className="flex-1 px-3 py-2.5 bg-surface border border-border rounded-xl text-xs text-foreground break-all select-all">
                    {qrUrl || '/walkin-form'}
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(qrUrl || `${window.location.origin}/walkin-form`);
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 2500);
                    }}
                    className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                      linkCopied
                        ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                        : 'bg-accent text-white hover:bg-accent-hover'
                    }`}
                  >
                    {linkCopied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied!</> : 'Copy Link'}
                  </button>
                </div>
                <p className="text-[11px] text-muted mt-1.5">Share this link via WhatsApp, SMS, or display it on a tablet at your entrance.</p>
              </div>

              <div className="flex gap-2">
                <button onClick={downloadQr} className="flex-1 flex items-center justify-center gap-2 py-2.5 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-surface-hover transition-colors">
                  <Download className="w-4 h-4" /> Download
                </button>
                <button onClick={printQr} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
                  <Printer className="w-4 h-4" /> Print
                </button>
              </div>
            </div>
          </div>

          {/* Localhost Warning + IP Entry */}
          {qrUrl && (qrUrl.includes('localhost') || qrUrl.includes('127.0.0.1')) && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-3">
              <div className="flex items-start gap-2">
                <div className="p-1 rounded-lg bg-amber-500/20 mt-0.5"><QrCode className="w-3.5 h-3.5 text-amber-700" /></div>
                <div>
                  <p className="text-xs font-semibold text-amber-700">QR points to localhost — phones can&apos;t reach it</p>
                  <p className="text-[11px] text-amber-600 mt-0.5">Enter your computer&apos;s local IP address (both devices must be on same WiFi network).</p>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. 192.168.1.5"
                  id="ip-input"
                  className="flex-1 px-3 py-2.5 bg-white border border-amber-300 rounded-xl text-sm text-gray-800 focus:outline-none focus:border-amber-500 placeholder:text-amber-300"
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      const port = window.location.port || '3000';
                      await generateQr(`http://${e.target.value.trim()}:${port}`);
                    }
                  }}
                />
                <button
                  onClick={async () => {
                    const input = document.getElementById('ip-input');
                    if (input?.value.trim()) {
                      const port = window.location.port || '3000';
                      await generateQr(`http://${input.value.trim()}:${port}`);
                    }
                  }}
                  className="px-4 py-2.5 bg-amber-500 text-white rounded-xl text-xs font-semibold hover:bg-amber-600 transition-colors"
                >
                  Update QR
                </button>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-amber-600">
                <span>Find your IP:</span>
                <code className="px-1.5 py-0.5 bg-amber-200/50 rounded text-amber-700 font-medium">Win+R → cmd → ipconfig</code>
                <span>→ look for</span>
                <strong>IPv4 Address</strong>
              </div>
            </div>
          )}

          {/* Tips */}
          <div className="flex items-start gap-3 p-3.5 rounded-xl bg-surface border border-border">
            <div className="p-1.5 rounded-lg bg-accent-light flex-shrink-0"><Eye className="w-3.5 h-3.5 text-accent" /></div>
            <div className="text-xs text-muted space-y-1">
              <p><strong className="text-foreground">Best placement:</strong> Print and display near the entrance, reception desk, or on table standees.</p>
              <p>You can also open the link on a tablet and place it at reception for customers to fill in directly.</p>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
