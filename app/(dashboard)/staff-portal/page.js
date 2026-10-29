/* eslint-disable @next/next/no-img-element */
'use client';

import { useState, useEffect } from 'react';
import {
  LogIn, LogOut, Clock, ShoppingBag, Phone, Users, Package,
  MapPin, MapPinned, Camera, Ruler, Target, Star,
  DollarSign, TrendingUp, CheckCircle2, Plus, X, Calendar,
  UserCheck, Activity, Percent, IndianRupee,
  Megaphone, AlertTriangle, Search,
  Warehouse, Timer, Home,
  Lock, User, Trash2,
  ChevronLeft, ChevronRight, Fingerprint,
  ClipboardList, Boxes, Info, MessageSquare, ChevronDown, ChevronUp, Flame,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/AuthProvider';
import Modal from '@/components/Modal';
import { getStaff, getStaffPortalProfile, clockIn as serverClockIn, clockOut as serverClockOut, staffStockUpdate, getMonthAttendance, verifyStaffPortalPassword } from '@/app/actions/staff';
import { getStaffVisits, updateFieldVisit, logSelfVisit, getSelfVisits, updateSelfVisitPhotos } from '@/app/actions/custom-orders';
import { moveSelfVisitToDraft } from '@/app/actions/drafts';
import { getProducts } from '@/app/actions/products';
import { getStaffProductionOrders, staffUpdateProductionStep, staffUpdateProductionProgress, staffAddStepNote } from '@/app/actions/manufacturing';
import { confirmDialog } from '@/components/AlertToastProvider';

const activityIcons = {
  call: { icon: Phone, color: 'bg-blue-500/10 text-blue-700', label: 'Call' },
  measurement: { icon: Ruler, color: 'bg-indigo-500/10 text-indigo-700', label: 'Measurement' },
};

const attendanceColors = {
  'Present': 'bg-emerald-500/10 text-emerald-700',
  'Absent': 'bg-red-500/10 text-red-700',
  'Half Day': 'bg-amber-500/10 text-amber-700',
  'Off Duty': 'bg-orange-500/10 text-orange-700',
};

const stockActionColors = {
  'Stock Out': 'text-red-700 bg-red-500/10',
  'Received': 'text-emerald-700 bg-emerald-500/10',
  'Dispatched': 'text-blue-700 bg-blue-500/10',
  'Low Stock Alert': 'text-amber-700 bg-amber-500/10',
};

export default function StaffPortalPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const userRole = session?.user?.role || 'STAFF';
  const [staff, setStaff] = useState([]);
  const [products, setProducts] = useState([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [autoLoginLoading, setAutoLoginLoading] = useState(false);
  const [loggedInStaff, setLoggedInStaff] = useState(null);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState('dashboard');
  const [isClockedIn, setIsClockedIn] = useState(true);
  const [clockInTime, setClockInTime] = useState(null);
  const [gpsLocation, setGpsLocation] = useState(null); // { lat, lng }
  const [gpsError, setGpsError] = useState('');
  const [gpsLoading, setGpsLoading] = useState(false);
  const [clockInMsg, setClockInMsg] = useState('');

  // Attendance month state
  const [attendanceMonth, setAttendanceMonth] = useState(() => {
    const n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() + 1 };
  });
  const [monthAttendance, setMonthAttendance] = useState([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);

  useEffect(() => {
    Promise.all([getStaff(), getProducts()]).then(([staffRes, productsRes]) => {
      if (staffRes.success) setStaff(staffRes.data);
      if (productsRes.success) setProducts(productsRes.data);
      setStaffLoading(false);
    });
  }, []);

  const applyStaffLogin = (found) => {
    setLoggedInStaff(found);
    setLoginError('');
    const todayStr = new Date().toISOString().split('T')[0];
    const today = found.attendance.find(a => a.date === todayStr);
    if (today?.clockIn) {
      setIsClockedIn(true);
      setClockInTime(today.clockIn);
    } else {
      setIsClockedIn(false);
    }
    getStaffVisits(found.id).then(res => {
      if (res.success) setAssignedVisits(res.data);
    });
  };

  // Auto-login into the local portal context when authenticated staff user enters this page
  useEffect(() => {
    if (!session?.user?.staffId || loggedInStaff) return;
    let active = true;
    setAutoLoginLoading(true);
    getStaffPortalProfile(Number(session.user.staffId)).then(res => {
      if (!active) return;
      if (res.success) applyStaffLogin(res.data);
      setAutoLoginLoading(false);
    });
    return () => { active = false; };
  }, [session, loggedInStaff]);

  // Re-fetch assigned visits when switching to assigned/dashboard tabs so manager updates are visible
  useEffect(() => {
    if (!loggedInStaff) return;
    if (tab === 'assigned' || tab === 'dashboard') {
      getStaffVisits(loggedInStaff.id).then(res => {
        if (res.success) setAssignedVisits(res.data);
      });
    }
  }, [tab, loggedInStaff]);

  // Fetch month attendance when tab = 'attendance' or month changes
  useEffect(() => {
    if (!loggedInStaff || tab !== 'attendance') return;
    setAttendanceLoading(true);
    getMonthAttendance(loggedInStaff.id, attendanceMonth.year, attendanceMonth.month).then(res => {
      if (res.success) setMonthAttendance(res.data);
      setAttendanceLoading(false);
    });
  }, [tab, loggedInStaff, attendanceMonth]);

  // Re-fetch self visits from DB when switching to self tab
  useEffect(() => {
    if (!loggedInStaff) return;
    if (tab === 'self') {
      getSelfVisits(loggedInStaff.id).then(res => {
        if (res.success) setSelfVisits(res.data);
      });
    }
  }, [tab, loggedInStaff]);

  // Fetch production orders when switching to production tab
  useEffect(() => {
    if (!loggedInStaff || tab !== 'production') return;
    setProductionLoading(true);
    getStaffProductionOrders(loggedInStaff.id).then(res => {
      if (res.success) setProductionOrders(res.data);
      setProductionLoading(false);
    });
  }, [tab, loggedInStaff]);

  // Modals
  const [showLogActivity, setShowLogActivity] = useState(false);
  const [showLogStock, setShowLogStock] = useState(false);
  const [showLogVisit, setShowLogVisit] = useState(false);

  // Activity form
  const [activityType, setActivityType] = useState('call');
  const [activityText, setActivityText] = useState('');

  // Stock form
  const [stockProduct, setStockProduct] = useState(null); // { id, name, sku, stock, warehouse }
  const [stockProductSearch, setStockProductSearch] = useState('');
  const [showStockDropdown, setShowStockDropdown] = useState(false);
  const [stockAction, setStockAction] = useState('Received');
  const [stockQty, setStockQty] = useState('');
  const [stockSaving, setStockSaving] = useState(false);
  const [stockMsg, setStockMsg] = useState('');

  // Visit form
  const [visitCustomer, setVisitCustomer] = useState('');
  const [visitAddress, setVisitAddress] = useState('');
  const [visitType, setVisitType] = useState('Measurement');
  const [visitNotes, setVisitNotes] = useState('');
  const [visitMeasurements, setVisitMeasurements] = useState('');
  const [visitPhotos, setVisitPhotos] = useState([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  // Photo upload for existing visits
  const [uploadingVisitId, setUploadingVisitId] = useState(null);

  // Assigned visits from custom orders
  const [assignedVisits, setAssignedVisits] = useState([]);
  const [showUpdateVisit, setShowUpdateVisit] = useState(false);
  const [editingVisit, setEditingVisit] = useState(null);
  const [visitSaving, setVisitSaving] = useState(false);

  // Self visits from DB
  const [selfVisits, setSelfVisits] = useState([]);
  const [deletingVisitId, setDeletingVisitId] = useState(null);

  // Production orders
  const [productionOrders, setProductionOrders] = useState([]);
  const [productionLoading, setProductionLoading] = useState(false);
  const [stepUpdating, setStepUpdating] = useState(null);
  const [expandedOrderId, setExpandedOrderId] = useState(null); // for materials panel
  const [stepNotes, setStepNotes] = useState({}); // { [stepId]: string } draft notes per step
  const [savingNoteId, setSavingNoteId] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    const found = staff.find(s => String(s.id) === selectedStaffId);
    if (!found) {
      setLoginError('Please select a staff member');
      return;
    }

    const entered = accessKey.trim();
    if (!entered) {
      setLoginError('Please enter your password');
      return;
    }

    setLoginSubmitting(true);
    try {
      // Require assigned login credentials
      if (!found.hasLogin) {
        setLoginError('No login credentials assigned. Please contact your admin.');
        return;
      }

      const res = await verifyStaffPortalPassword(found.id, entered);
      if (!res.success) {
        setLoginError(res.error || 'Invalid password');
        return;
      }

      applyStaffLogin(found);
    } finally {
      setLoginSubmitting(false);
    }
  };

  const getGps = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocation not supported')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  const handleClockIn = async () => {
    setGpsLoading(true);
    setGpsError('');
    setClockInMsg('');
    try {
      const gps = await getGps();
      setGpsLocation(gps);
      const res = await serverClockIn(loggedInStaff.id, gps);
      if (res.success) {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        setIsClockedIn(true);
        setClockInTime(time);
        if (res.data.isLate) setClockInMsg('Marked as Late');
        if (res.data.distance != null) setClockInMsg(prev => (prev ? prev + ' · ' : '') + `${res.data.distance}m from store`);
      } else {
        setGpsError(res.error || 'Clock-in failed');
      }
    } catch (err) {
      setGpsError('Location access denied. Please enable GPS and try again.');
    } finally {
      setGpsLoading(false);
    }
  };

  const handleClockOut = async () => {
    setGpsLoading(true);
    setGpsError('');
    try {
      const gps = await getGps();
      const res = await serverClockOut(loggedInStaff.id, gps);
      if (res.success) {
        setIsClockedIn(false);
        setClockInTime(null);
        setClockInMsg('');
      } else {
        setGpsError(res.error || 'Clock-out failed');
      }
    } catch {
      // Allow clock-out even without GPS
      const res = await serverClockOut(loggedInStaff.id);
      if (res.success) {
        setIsClockedIn(false);
        setClockInTime(null);
      }
    } finally {
      setGpsLoading(false);
    }
  };

  const handleLogout = () => {
    setLoggedInStaff(null);
    setSelectedStaffId('');
    setAccessKey('');
    setTab('dashboard');
  };

  const handleLogActivity = (e) => {
    e.preventDefault();
    if (!activityText.trim()) return;
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    loggedInStaff.activities.unshift({
      type: activityType,
      text: activityText,
      time,
      date: new Date().toISOString().split('T')[0],
    });
    setActivityText('');
    setShowLogActivity(false);
  };

  const handleLogStock = async (e) => {
    e.preventDefault();
    if (!stockProduct || !stockQty || parseInt(stockQty) < 1) return;
    setStockSaving(true);
    setStockMsg('');
    const res = await staffStockUpdate({
      staffId: loggedInStaff.id,
      productId: stockProduct.id,
      action: stockAction,
      quantity: parseInt(stockQty),
    });
    if (res.success) {
      // Refresh staff data to show updated stock log
      const staffRes = await getStaff();
      if (staffRes.success) {
        const updated = staffRes.data.find(s => s.id === loggedInStaff.id);
        if (updated) setLoggedInStaff({ ...loggedInStaff, stockUpdates: updated.stockUpdates });
      }
      setStockProduct(null);
      setStockProductSearch('');
      setStockQty('');
      setStockAction('Received');
      setShowLogStock(false);
    } else {
      setStockMsg(res.error || 'Failed to update stock');
    }
    setStockSaving(false);
  };

  const handlePhotoSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (visitPhotos.length + files.length > 5) {
      alert('Maximum 5 photos allowed per visit');
      return;
    }
    // Preview locally before upload
    const previews = files.map(f => ({ file: f, preview: URL.createObjectURL(f), name: f.name }));
    setVisitPhotos(prev => [...prev, ...previews]);
  };

  const uploadPhotos = async (photos) => {
    if (photos.length === 0) return [];
    const formData = new FormData();
    formData.set('folder', 'field-visits');
    photos.forEach(p => formData.append('files', p.file));
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) return data.urls;
      console.error('Upload failed:', data.error);
      return [];
    } catch (err) {
      console.error('Upload error:', err);
      return [];
    }
  };

  const handleUploadToVisit = async (visitId, e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingVisitId(visitId);
    const formData = new FormData();
    formData.set('folder', 'field-visits');
    files.forEach(f => formData.append('files', f));
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success && data.urls?.length > 0) {
        await updateSelfVisitPhotos(visitId, data.urls);
        // Refresh self visits from DB
        const refreshed = await getSelfVisits(loggedInStaff.id);
        if (refreshed.success) setSelfVisits(refreshed.data);
      }
    } catch (err) {
      console.error('Upload error:', err);
    } finally {
      setUploadingVisitId(null);
    }
  };

  const handleLogVisit = async (e) => {
    e.preventDefault();
    if (!visitCustomer.trim() || !visitAddress.trim()) return;
    setUploadingPhotos(true);
    const uploadedUrls = await uploadPhotos(visitPhotos);
    const measurements = visitMeasurements
      ? Object.fromEntries(visitMeasurements.split(',').map(m => { const [k, v] = m.trim().split(':'); return [k?.trim(), v?.trim()]; }))
      : undefined;

    const res = await logSelfVisit({
      staffId: loggedInStaff.id,
      customer: visitCustomer,
      address: visitAddress,
      type: visitType,
      notes: visitNotes || undefined,
      measurements,
      photoUrls: uploadedUrls.length > 0 ? uploadedUrls : undefined,
    });

    if (res.success) {
      // Refresh self visits from DB
      const refreshed = await getSelfVisits(loggedInStaff.id);
      if (refreshed.success) setSelfVisits(refreshed.data);
    }

    // Cleanup previews
    visitPhotos.forEach(p => URL.revokeObjectURL(p.preview));
    setVisitCustomer('');
    setVisitAddress('');
    setVisitNotes('');
    setVisitMeasurements('');
    setVisitPhotos([]);
    setUploadingPhotos(false);
    setShowLogVisit(false);
  };

  // ========== MOVE SELF VISIT TO DRAFT ==========
  const handleMoveSelfVisitToDraft = async (visitId) => {
    if (!await confirmDialog('Move this visit to drafts? It will be permanently deleted after 30 days.')) return;
    setDeletingVisitId(visitId);
    const res = await moveSelfVisitToDraft(visitId);
    if (res.success) {
      setSelfVisits(prev => prev.filter(v => v.id !== visitId));
    }
    setDeletingVisitId(null);
  };

  // ========== VISIT UPDATE (Custom Order Visits) ==========
  const handleUpdateAssignedVisit = async (e) => {
    e.preventDefault();
    if (!editingVisit) return;
    const form = new FormData(e.target);
    setVisitSaving(true);

    const updateData = {
      visitId: editingVisit.id,
      status: form.get('status') || undefined,
      staffNotes: form.get('staffNotes') || undefined,
      measurements: {
        length: form.get('length') || undefined,
        width: form.get('width') || undefined,
        height: form.get('height') || undefined,
        depth: form.get('depth') || undefined,
        countertop: form.get('countertop') || undefined,
        notes: form.get('measurementNotes') || undefined,
      },
    };

    // Only include measurements if at least one value is provided
    const hasMeasurements = Object.values(updateData.measurements).some(v => v);
    if (!hasMeasurements) delete updateData.measurements;

    const res = await updateFieldVisit(updateData);
    if (res.success) {
      // Reload assigned visits
      const visitsRes = await getStaffVisits(loggedInStaff.id);
      if (visitsRes.success) setAssignedVisits(visitsRes.data);
      setShowUpdateVisit(false);
      setEditingVisit(null);
    }
    setVisitSaving(false);
  };

  const handleVisitStatusChange = async (visit, newStatus) => {
    setVisitSaving(true);
    const res = await updateFieldVisit({ visitId: visit.id, status: newStatus });
    if (res.success) {
      const visitsRes = await getStaffVisits(loggedInStaff.id);
      if (visitsRes.success) setAssignedVisits(visitsRes.data);
    }
    setVisitSaving(false);
  };

  // ========== LOADING ==========
  if (userRole === 'ADMIN') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="glass-card p-8 text-center max-w-md">
          <h1 className="text-lg font-semibold text-foreground">Staff Portal is for staff accounts only</h1>
          <p className="text-sm text-muted mt-2">Please use your staff login to access attendance, visits, and updates.</p>
        </div>
      </div>
    );
  }

  if (staffLoading || (session?.user?.staffId && autoLoginLoading && !loggedInStaff)) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center animate-pulse">
        <div className="w-full max-w-md">
          <div className="glass-card p-8 space-y-6">
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-surface" />
              <div className="h-6 w-32 bg-surface rounded-lg" />
            </div>
            <div className="h-12 bg-surface rounded-xl" />
            <div className="h-12 bg-surface rounded-xl" />
            <div className="h-12 bg-surface rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  // ========== LOGIN SCREEN ==========
  if (!loggedInStaff) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center animate-[fade-in_0.5s_ease-out]">
        <div className="w-full max-w-md">
          <div className="glass-card p-8">
            {/* Header */}
            <div className="text-center mb-8">
              <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-4">
                <User className="w-8 h-8 text-accent" />
              </div>
              <h1 className="text-2xl font-bold text-foreground">Staff Portal</h1>
              <p className="text-sm text-muted mt-1">Login to access your dashboard</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              {/* Staff Selection */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Select Your Name</label>
                <select
                  value={selectedStaffId}
                  onChange={e => {
                    setSelectedStaffId(e.target.value);
                    setAccessKey('');
                    setLoginError('');
                  }}
                  className="w-full px-4 py-3 bg-surface rounded-xl border border-border text-sm text-foreground"
                >
                  <option value="">Choose staff member...</option>
                  {staff.map(s => (
                    <option key={s.id} value={s.id}>{s.name} — {s.role}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Enter Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type="password"
                    placeholder="Your assigned password"
                    value={accessKey}
                    onChange={e => { setAccessKey(e.target.value); setLoginError(''); }}
                    className="w-full pl-10 pr-4 py-3 bg-surface rounded-xl border border-border text-sm"
                  />
                </div>
              </div>

              {loginError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-700 text-xs">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {loginError}
                </div>
              )}

              <button type="submit" disabled={loginSubmitting} className="w-full py-3 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2">
                <LogIn className="w-4 h-4" /> {loginSubmitting ? 'Checking...' : 'Login'}
              </button>
            </form>

            <p className="text-[10px] text-muted text-center mt-6">Contact your admin if you haven&apos;t been assigned a login password.</p>
          </div>
        </div>
      </div>
    );
  }

  // ========== STAFF DASHBOARD ==========
  const me = loggedInStaff;
  const stats = me.stats || {};
  const target = me.target || {};
  const commission = me.commission || {};
  const recentSales = me.recentSales || [];
  const targetPct = target.monthly > 0 ? Math.round(((target.achieved || 0) / target.monthly) * 100) : 0;
  const todayActivities = me.activities.filter(a => a.date === new Date().toISOString().split('T')[0]);
  const upcomingVisits = me.fieldVisits.filter(v => v.status === 'Scheduled' || v.status === 'In Progress');

  const portalTabs = [
    { key: 'dashboard', label: 'Staff Portal', icon: Home },
    { key: 'production', label: 'Dashboard', icon: Package },
    { key: 'stock', label: 'Stock Updates', icon: Warehouse },
    { key: 'assigned', label: 'Assigned Visits', icon: MapPin },
    { key: 'self', label: 'Self Visits', icon: MapPinned },
    { key: 'attendance', label: 'My Attendance', icon: Calendar },
    { key: 'sales', label: 'My Sales', icon: ShoppingBag },
  ];

  return (
    <div className="space-y-6 animate-[fade-in_0.3s_ease]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center text-lg font-bold text-accent">{me.avatar}</div>
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              Welcome, {me.name.split(' ')[0]}
              <span className="text-xs font-normal text-muted bg-surface px-2 py-0.5 rounded-full">{me.role}</span>
            </h1>
            <p className="text-sm text-muted mt-0.5">Staff Portal — Shift: 9:00 AM – 8:00 PM</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            {/* GPS Clock In/Out */}
            {!isClockedIn ? (
              <button onClick={handleClockIn} disabled={gpsLoading} className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-xl text-sm font-semibold transition-all">
                {gpsLoading ? (
                  <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Locating...</>
                ) : (
                  <><MapPin className="w-4 h-4" /> Clock In (GPS)</>
                )}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs font-medium text-emerald-700">
                  <div className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" />
                  Clocked in at {clockInTime}
                </span>
                <button onClick={handleClockOut} disabled={gpsLoading} className="flex items-center gap-2 px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white rounded-xl text-sm font-semibold transition-all">
                  {gpsLoading ? 'Locating...' : <><LogOut className="w-4 h-4" /> Clock Out</>}
                </button>
              </div>
            )}
            <button onClick={handleLogout} className="px-3 py-2.5 border border-border rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-all">
              Logout
            </button>
          </div>
          {/* GPS feedback messages */}
          {gpsError && <p className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {gpsError}</p>}
          {clockInMsg && <p className="text-xs text-amber-600 flex items-center gap-1"><MapPin className="w-3 h-3" /> {clockInMsg}</p>}
        </div>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-3 gap-1 sm:flex sm:flex-wrap">
        {portalTabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} className={`flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${tab === t.key ? 'bg-accent text-white' : 'text-muted hover:text-foreground hover:bg-surface-hover border border-border'}`}>
              <Icon className="w-3.5 h-3.5 flex-shrink-0" /> <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* ===== MY DASHBOARD ===== */}
      {tab === 'dashboard' && (
        <div className="space-y-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-success-light"><DollarSign className="w-5 h-5 text-success" /></div>
              <div><p className="text-xs text-muted">Total Revenue</p><p className="text-lg font-bold text-success">₹{(stats.revenue / 100000).toFixed(1)}L</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-purple-light"><ShoppingBag className="w-5 h-5 text-purple" /></div>
              <div><p className="text-xs text-muted">Today&apos;s Revenue</p><p className="text-lg font-bold text-foreground">₹{stats.todayRevenue.toLocaleString()}</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-info-light"><Target className="w-5 h-5 text-info" /></div>
              <div><p className="text-xs text-muted">Conversion Rate</p><p className="text-lg font-bold text-foreground">{stats.conversionRate}%</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-amber-500/10"><Star className="w-5 h-5 text-amber-700" /></div>
              <div><p className="text-xs text-muted">My Rating</p><p className="text-lg font-bold text-amber-700">{stats.rating} / 5</p></div>
            </div>
          </div>

          {/* Target + Commission */}
          {target.monthly > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Target Card */}
              <div className="glass-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Target className="w-4 h-4 text-accent" /> Monthly Target</h3>
                  <span className={`text-sm font-bold ${targetPct >= 80 ? 'text-emerald-700' : targetPct >= 50 ? 'text-amber-700' : 'text-red-700'}`}>{targetPct}%</span>
                </div>
                <div className="h-3 bg-surface rounded-full overflow-hidden mb-3">
                  <div className={`h-full rounded-full transition-all ${targetPct >= 80 ? 'bg-emerald-600' : targetPct >= 50 ? 'bg-amber-600' : 'bg-red-600'}`} style={{ width: `${Math.min(100, targetPct)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted">
                  <span>Achieved: <span className="font-semibold text-foreground">₹{(target.achieved / 1000).toFixed(0)}K</span></span>
                  <span>Target: <span className="font-semibold text-foreground">₹{(target.monthly / 1000).toFixed(0)}K</span></span>
                </div>
                <div className="mt-2 p-2 rounded-lg bg-surface text-xs text-muted text-center">
                  {target.monthly - target.achieved > 0
                    ? `₹${((target.monthly - target.achieved) / 1000).toFixed(0)}K more to hit target`
                    : 'Target achieved! Great work!'}
                </div>
              </div>

              {/* Commission Card */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4"><IndianRupee className="w-4 h-4 text-accent" /> My Commission</h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-surface rounded-xl p-3 text-center">
                    <p className="text-lg font-bold text-foreground">{commission.rate}%</p>
                    <p className="text-[10px] text-muted">Rate</p>
                  </div>
                  <div className="bg-surface rounded-xl p-3 text-center">
                    <p className="text-lg font-bold text-emerald-700">₹{commission.earned.toLocaleString()}</p>
                    <p className="text-[10px] text-muted">Earned</p>
                  </div>
                  <div className="bg-surface rounded-xl p-3 text-center">
                    <p className="text-lg font-bold text-amber-700">₹{commission.pending.toLocaleString()}</p>
                    <p className="text-[10px] text-muted">Pending</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Quick Actions */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-semibold text-foreground mb-4">Quick Actions</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <button onClick={() => router.push('/walkins')} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-surface-hover transition-all">
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center"><Users className="w-5 h-5 text-purple-700" /></div>
                <span className="text-xs font-medium text-foreground">Add Walk-in</span>
              </button>
              <button onClick={() => router.push('/leads')} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-surface-hover transition-all">
                <div className="w-10 h-10 rounded-xl bg-teal-500/10 flex items-center justify-center"><UserCheck className="w-5 h-5 text-teal-700" /></div>
                <span className="text-xs font-medium text-foreground">Add Lead</span>
              </button>
              <button onClick={() => router.push('/orders')} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-surface-hover transition-all">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center"><ShoppingBag className="w-5 h-5 text-emerald-700" /></div>
                <span className="text-xs font-medium text-foreground">Orders</span>
              </button>
              <button onClick={() => setShowLogStock(true)} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-surface-hover transition-all">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center"><Package className="w-5 h-5 text-amber-700" /></div>
                <span className="text-xs font-medium text-foreground">Update Stock</span>
              </button>
              <button onClick={() => router.push('/marketing')} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-surface-hover transition-all">
                <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center"><Megaphone className="w-5 h-5 text-orange-700" /></div>
                <span className="text-xs font-medium text-foreground">Marketing</span>
              </button>
              <button onClick={() => setShowLogVisit(true)} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-surface-hover transition-all">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center"><MapPin className="w-5 h-5 text-indigo-700" /></div>
                <span className="text-xs font-medium text-foreground">Log Visit</span>
              </button>
            </div>
          </div>

          {/* Today's Activity + Upcoming */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Activity Log */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Activity className="w-4 h-4 text-accent" /> Activity Log</h3>
                <button onClick={() => setShowLogActivity(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-xs font-medium transition-all">
                  <Plus className="w-3.5 h-3.5" /> Log Activity
                </button>
              </div>
              <div className="space-y-2 max-h-[350px] overflow-y-auto">
                {me.activities.map((act, i) => {
                  const config = activityIcons[act.type] || activityIcons.call;
                  const Icon = config.icon;
                  return (
                    <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg bg-surface hover:bg-surface-hover transition-colors">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${config.color}`}><Icon className="w-3.5 h-3.5" /></div>
                      <div className="flex-1">
                        <p className="text-xs text-foreground">{act.text}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted">{act.date} · {act.time}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${config.color}`}>{config.label}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {me.activities.length === 0 && <p className="text-xs text-muted text-center py-4">No activities logged yet</p>}
              </div>
            </div>

            {/* Upcoming Visits */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground">Upcoming Visits</h3>
                <button onClick={() => setTab('assigned')} className="text-xs text-accent font-medium hover:underline">View All</button>
              </div>
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {/* Assigned visits from custom orders */}
                {assignedVisits.filter(v => v.status === 'Scheduled' || v.status === 'In Progress').map(visit => (
                  <div key={`assigned-${visit.id}`} className="bg-surface rounded-xl p-3 border border-border border-l-4 border-l-accent">
                    <div className="flex items-start justify-between mb-1">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{visit.customer}</p>
                        {visit.customOrderDisplayId && <span className="text-[10px] text-accent font-medium">{visit.customOrderDisplayId} · {visit.customOrderType}</span>}
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${visit.status === 'In Progress' ? 'bg-blue-500/10 text-blue-700' : 'bg-amber-500/10 text-amber-700'}`}>{visit.status}</span>
                    </div>
                    <p className="text-xs text-muted flex items-center gap-1"><MapPin className="w-3 h-3" /> {visit.address}</p>
                    <p className="text-xs text-muted mt-1">{visit.scheduledDate || visit.date} · {visit.scheduledTime || visit.time} · {visit.type}</p>
                  </div>
                ))}
                {/* Self-logged visits */}
                {upcomingVisits.map(visit => (
                  <div key={visit.id} className="bg-surface rounded-xl p-3 border border-border">
                    <div className="flex items-start justify-between mb-1">
                      <p className="text-sm font-semibold text-foreground">{visit.customer}</p>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${visit.status === 'In Progress' ? 'bg-blue-500/10 text-blue-700' : 'bg-amber-500/10 text-amber-700'}`}>{visit.status}</span>
                    </div>
                    <p className="text-xs text-muted flex items-center gap-1"><MapPin className="w-3 h-3" /> {visit.address}</p>
                    <p className="text-xs text-muted mt-1">{visit.date} · {visit.time} · {visit.type}</p>
                  </div>
                ))}
                {upcomingVisits.length === 0 && assignedVisits.filter(v => v.status === 'Scheduled' || v.status === 'In Progress').length === 0 && (
                  <p className="text-xs text-muted text-center py-4">No upcoming visits</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}



      {/* ===== PRODUCTION ORDERS TAB ===== */}
      {tab === 'production' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Package className="w-5 h-5 text-accent" /> My Production Orders
            </h3>
            <button
              onClick={() => {
                setProductionLoading(true);
                getStaffProductionOrders(loggedInStaff.id).then(res => {
                  if (res.success) setProductionOrders(res.data);
                  setProductionLoading(false);
                });
              }}
              className="px-3 py-1.5 text-xs text-muted hover:text-foreground border border-border rounded-lg hover:bg-surface-hover transition-colors"
            >
              Refresh
            </button>
          </div>

          {productionLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-pulse text-sm text-muted">Loading production orders...</div>
            </div>
          ) : productionOrders.length === 0 ? (
            <div className="glass-card p-8 sm:p-12 text-center">
              <Package className="w-10 h-10 text-muted mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">No Production Orders Assigned</p>
              <p className="text-xs text-muted">When your manager assigns production work to you, it will appear here.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {productionOrders.map(order => {
                const totalSteps = order.productionSteps?.length || 0;
                const doneSteps = order.productionSteps?.filter(s => s.status === 'DONE').length || 0;
                const inProgressSteps = order.productionSteps?.filter(s => s.status === 'IN_PROGRESS').length || 0;
                const qtyPct = order.plannedQty > 0 ? Math.round((order.actualQty / order.plannedQty) * 100) : 0;

                // Due date urgency
                const dueDaysLeft = order.dueDate ? Math.ceil((new Date(order.dueDate) - new Date()) / 86400000) : null;
                const isOverdue = dueDaysLeft !== null && dueDaysLeft < 0 && order.status !== 'COMPLETED';
                const isDueSoon = dueDaysLeft !== null && dueDaysLeft >= 0 && dueDaysLeft <= 2 && order.status !== 'COMPLETED';

                // Materials from BOM
                const bomItems = order.bom?.items || [];
                const isExpanded = expandedOrderId === order.id;

                // Determine current phase
                let currentPhase = 'planned';
                let phaseLabel = 'Planned';
                let phaseColor = 'text-gray-500 bg-gray-500/10';
                let phaseIcon = '📋';
                if (order.status === 'COMPLETED') {
                  currentPhase = 'completed'; phaseLabel = 'Completed'; phaseColor = 'text-emerald-600 bg-emerald-500/10'; phaseIcon = '✅';
                } else if (order.status === 'CANCELLED') {
                  currentPhase = 'cancelled'; phaseLabel = 'Cancelled'; phaseColor = 'text-red-600 bg-red-500/10'; phaseIcon = '❌';
                } else if (order.status === 'ON_HOLD') {
                  currentPhase = 'on_hold'; phaseLabel = 'On Hold'; phaseColor = 'text-amber-600 bg-amber-500/10'; phaseIcon = '⏸️';
                } else if (order.status === 'IN_PROGRESS') {
                  if (qtyPct >= 100) {
                    currentPhase = 'quality_check'; phaseLabel = 'Quality Check'; phaseColor = 'text-purple-600 bg-purple-500/10'; phaseIcon = '🔍';
                  } else if (qtyPct > 0 || inProgressSteps > 0 || doneSteps > 0) {
                    currentPhase = 'production'; phaseLabel = 'In Production'; phaseColor = 'text-blue-600 bg-blue-500/10'; phaseIcon = '🔨';
                  } else {
                    currentPhase = 'material_prep'; phaseLabel = 'Material Prep'; phaseColor = 'text-orange-600 bg-orange-500/10'; phaseIcon = '📦';
                  }
                }

                const priorityStyles = {
                  URGENT: 'border-l-red-500',
                  HIGH: 'border-l-orange-500',
                  MEDIUM: 'border-l-amber-400',
                  LOW: 'border-l-blue-400',
                };

                return (
                  <div key={order.id} className={`glass-card overflow-hidden border-l-4 ${priorityStyles[order.priority] || 'border-l-gray-300'}`}>

                    {/* ── Card Header ── */}
                    <div className="p-4 pb-3">
                      {/* Urgency Banner */}
                      {isOverdue && (
                        <div className="flex items-center gap-1.5 mb-2 px-2.5 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg">
                          <Flame className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                          <span className="text-xs font-semibold text-red-600">OVERDUE by {Math.abs(dueDaysLeft)} day{Math.abs(dueDaysLeft) !== 1 ? 's' : ''} — complete immediately</span>
                        </div>
                      )}
                      {isDueSoon && !isOverdue && (
                        <div className="flex items-center gap-1.5 mb-2 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                          <span className="text-xs font-semibold text-amber-600">Due {dueDaysLeft === 0 ? 'TODAY' : `in ${dueDaysLeft} day${dueDaysLeft !== 1 ? 's' : ''}`} — prioritise this order</span>
                        </div>
                      )}

                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-foreground truncate">{order.finishedProduct?.name}</p>
                          <p className="text-[11px] text-muted mt-0.5">{order.displayId} · BOM: {order.bom?.name} v{order.bom?.version}</p>
                          {order.customOrder && (
                            <p className="text-[11px] text-accent font-medium mt-0.5">
                              👤 Customer: {order.customOrder.customer || order.customOrder.displayId}
                            </p>
                          )}
                        </div>
                        <span className={`text-[11px] px-2.5 py-1 rounded-full font-semibold flex-shrink-0 flex items-center gap-1 ${phaseColor}`}>
                          <span>{phaseIcon}</span> {phaseLabel}
                        </span>
                      </div>

                      {/* Info row */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2.5 text-[11px] text-muted">
                        <span className="font-semibold text-foreground">📦 {order.plannedQty} unit{order.plannedQty !== 1 ? 's' : ''}</span>
                        {order.dueDate && (
                          <span className={`flex items-center gap-1 ${isOverdue ? 'text-red-600 font-semibold' : isDueSoon ? 'text-amber-600 font-semibold' : ''}`}>
                            📅 {new Date(order.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                            {dueDaysLeft !== null && order.status !== 'COMPLETED' && (
                              <span>({dueDaysLeft < 0 ? `${Math.abs(dueDaysLeft)}d overdue` : dueDaysLeft === 0 ? 'today' : `${dueDaysLeft}d left`})</span>
                            )}
                          </span>
                        )}
                        {order.workCenter && <span>📍 {order.workCenter.name}</span>}
                        <span className={`font-medium ${order.priority === 'URGENT' ? 'text-red-500' : order.priority === 'HIGH' ? 'text-orange-500' : ''}`}>
                          ⚡ {order.priority}
                        </span>
                      </div>
                    </div>

                    {/* ── Phase Progress Timeline ── */}
                    {order.status !== 'CANCELLED' && (
                      <div className="px-4 py-3 bg-surface-hover/30 border-y border-border">
                        <div className="flex items-center gap-0">
                          {[
                            { key: 'planned', label: 'Planned', short: '📋' },
                            { key: 'material_prep', label: 'Prep', short: '📦' },
                            { key: 'production', label: 'Production', short: '🔨' },
                            { key: 'quality_check', label: 'QC', short: '🔍' },
                            { key: 'completed', label: 'Done', short: '✅' },
                          ].map((phase, idx, arr) => {
                            const phaseOrder = ['planned', 'material_prep', 'production', 'quality_check', 'completed'];
                            const currentIdx = phaseOrder.indexOf(currentPhase);
                            const thisIdx = phaseOrder.indexOf(phase.key);
                            const isActive = thisIdx === currentIdx;
                            const isDone = thisIdx < currentIdx;
                            const isFuture = thisIdx > currentIdx;
                            return (
                              <div key={phase.key} className="flex items-center flex-1 min-w-0">
                                <div className={`flex flex-col items-center gap-0.5 flex-1 min-w-0 ${isFuture ? 'opacity-30' : ''}`}>
                                  <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-xs
                                    ${isDone ? 'bg-emerald-500 text-white' : isActive ? 'bg-accent text-white ring-2 ring-accent/30 ring-offset-1' : 'bg-surface border border-border text-muted'}`}>
                                    {isDone ? '✓' : phase.short}
                                  </div>
                                  <span className={`text-[9px] sm:text-[10px] truncate max-w-full ${isActive ? 'font-bold text-foreground' : isDone ? 'text-emerald-600 font-medium' : 'text-muted'}`}>
                                    {phase.label}
                                  </span>
                                </div>
                                {idx < arr.length - 1 && (
                                  <div className={`h-0.5 flex-shrink-0 w-3 sm:w-5 mt-[-10px] ${isDone ? 'bg-emerald-500' : 'bg-border'}`} />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── Quantity Update Section ── */}
                    {order.status === 'IN_PROGRESS' && (
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-foreground">Units Produced</span>
                          <span className={`text-xs font-bold ${qtyPct >= 100 ? 'text-emerald-600' : 'text-accent'}`}>{qtyPct}%</span>
                        </div>
                        <div className="h-2.5 bg-surface rounded-full overflow-hidden mb-4">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${qtyPct >= 100 ? 'bg-emerald-500' : qtyPct > 50 ? 'bg-accent' : qtyPct > 0 ? 'bg-amber-500' : 'bg-gray-300'}`}
                            style={{ width: `${Math.min(100, qtyPct)}%` }}
                          />
                        </div>

                        <div className="flex items-center justify-between gap-3">
                          <button
                            disabled={stepUpdating === `qty-${order.id}` || order.actualQty <= 0}
                            onClick={async () => {
                              setStepUpdating(`qty-${order.id}`);
                              const res = await staffUpdateProductionProgress(loggedInStaff.id, order.id, Math.max(0, order.actualQty - 1));
                              if (res.success) {
                                const refresh = await getStaffProductionOrders(loggedInStaff.id);
                                if (refresh.success) setProductionOrders(refresh.data);
                              } else { alert(res.error); }
                              setStepUpdating(null);
                            }}
                            className="w-12 h-12 rounded-xl bg-red-500/10 text-red-600 font-bold text-xl hover:bg-red-500/20 active:scale-95 disabled:opacity-20 disabled:hover:bg-red-500/10 transition-all flex items-center justify-center border border-red-500/20"
                          >
                            −
                          </button>

                          <div className="flex-1 text-center">
                            <p className="text-3xl font-black text-foreground">{order.actualQty} <span className="text-base font-medium text-muted">/ {order.plannedQty}</span></p>
                            <p className="text-[10px] text-muted mt-0.5">units completed</p>
                          </div>

                          <button
                            disabled={stepUpdating === `qty-${order.id}` || order.actualQty >= order.plannedQty}
                            onClick={async () => {
                              setStepUpdating(`qty-${order.id}`);
                              const res = await staffUpdateProductionProgress(loggedInStaff.id, order.id, Math.min(order.plannedQty, order.actualQty + 1));
                              if (res.success) {
                                const refresh = await getStaffProductionOrders(loggedInStaff.id);
                                if (refresh.success) setProductionOrders(refresh.data);
                              } else { alert(res.error); }
                              setStepUpdating(null);
                            }}
                            className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-600 font-bold text-xl hover:bg-emerald-500/20 active:scale-95 disabled:opacity-20 disabled:hover:bg-emerald-500/10 transition-all flex items-center justify-center border border-emerald-500/20"
                          >
                            +
                          </button>
                        </div>

                        {qtyPct >= 100 && (
                          <div className="mt-3 p-2.5 bg-emerald-500/10 rounded-lg text-center">
                            <p className="text-xs font-semibold text-emerald-600">✅ All units produced — awaiting quality check by manager</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Status messages for non-active orders */}
                    {order.status === 'PLANNED' && (
                      <div className="px-4 py-3 bg-gray-500/5">
                        <p className="text-xs text-muted text-center">⏳ Waiting for manager to start this production order</p>
                      </div>
                    )}
                    {order.status === 'ON_HOLD' && (
                      <div className="px-4 py-3 bg-amber-500/5">
                        <p className="text-xs text-amber-600 text-center font-medium">⏸️ Production on hold — contact your manager</p>
                      </div>
                    )}
                    {order.status === 'COMPLETED' && (
                      <div className="px-4 py-3 bg-emerald-500/5">
                        <p className="text-xs text-emerald-600 text-center font-medium">✅ Production completed — {order.actualQty}/{order.plannedQty} units</p>
                      </div>
                    )}

                    {/* ── Manufacturing Steps ── */}
                    {totalSteps > 0 && (
                      <div className="border-t border-border">
                        <div className="px-4 py-2 bg-surface-hover/30 flex items-center justify-between">
                          <span className="text-[10px] text-muted uppercase tracking-wide font-semibold flex items-center gap-1.5">
                            <ClipboardList className="w-3 h-3" /> Manufacturing Steps
                          </span>
                          <span className="text-[10px] font-medium text-muted">{doneSteps}/{totalSteps} done</span>
                        </div>
                        <div className="divide-y divide-border/50">
                          {order.productionSteps.map(step => {
                            const stepIcon = { PENDING: '⏳', IN_PROGRESS: '🔨', DONE: '✅', SKIPPED: '⏭️' };
                            // Estimated time: plannedMins is per-unit * qty, so show per-unit (divide by plannedQty)
                            const estMinsPerUnit = order.plannedQty > 0 ? Math.round((step.plannedMins || 0) / order.plannedQty) : (step.plannedMins || 0);
                            const draftNote = stepNotes[step.id] ?? (step.notes || '');
                            return (
                              <div key={step.id} className={`px-4 py-3 ${step.status === 'IN_PROGRESS' ? 'bg-blue-500/5' : step.status === 'DONE' ? 'bg-emerald-500/5' : ''}`}>
                                <div className="flex items-start gap-3">
                                  <span className="text-lg flex-shrink-0 mt-0.5">{stepIcon[step.status] || '⏳'}</span>
                                  <div className="flex-1 min-w-0">
                                    <p className={`text-sm ${step.status === 'DONE' ? 'line-through text-muted' : 'text-foreground font-medium'}`}>
                                      {step.stepNumber}. {step.operationName}
                                    </p>
                                    {/* Meta row: estimated time, work center, actual time */}
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted mt-1">
                                      {estMinsPerUnit > 0 && (
                                        <span className="flex items-center gap-0.5">
                                          <Timer className="w-2.5 h-2.5" />
                                          Est. {estMinsPerUnit >= 60 ? `${Math.floor(estMinsPerUnit/60)}h ${estMinsPerUnit%60}m` : `${estMinsPerUnit}m`}
                                        </span>
                                      )}
                                      {step.workCenter?.name && <span>📍 {step.workCenter.name}</span>}
                                      {step.status === 'IN_PROGRESS' && step.startedAt && (
                                        <span className="text-blue-600 font-medium flex items-center gap-0.5">
                                          <Clock className="w-2.5 h-2.5 animate-pulse" />
                                          Started {new Date(step.startedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                      )}
                                      {step.status === 'DONE' && step.actualMins > 0 && (
                                        <span className={`font-medium ${step.actualMins > estMinsPerUnit && estMinsPerUnit > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                                          ✓ Took {step.actualMins >= 60 ? `${Math.floor(step.actualMins/60)}h ${step.actualMins%60}m` : `${step.actualMins}m`}
                                          {estMinsPerUnit > 0 && step.actualMins > estMinsPerUnit && ' (over estimate)'}
                                        </span>
                                      )}
                                      {step.completedAt && (
                                        <span className="text-emerald-600">Done {new Date(step.completedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                                      )}
                                    </div>

                                    {/* Existing saved note */}
                                    {step.notes && step.status === 'DONE' && (
                                      <p className="mt-1.5 text-[10px] text-amber-700 bg-amber-500/5 px-2 py-1 rounded flex items-start gap-1">
                                        <MessageSquare className="w-2.5 h-2.5 flex-shrink-0 mt-0.5" />
                                        {step.notes}
                                      </p>
                                    )}

                                    {/* Step notes input — show when IN_PROGRESS */}
                                    {order.status === 'IN_PROGRESS' && step.status === 'IN_PROGRESS' && (
                                      <div className="mt-2 flex gap-2 items-start">
                                        <textarea
                                          value={draftNote}
                                          onChange={e => setStepNotes(n => ({ ...n, [step.id]: e.target.value }))}
                                          placeholder="Add note / report issue (optional)..."
                                          rows={2}
                                          className="flex-1 px-2 py-1.5 text-[11px] bg-surface border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none text-foreground placeholder:text-muted"
                                        />
                                        <button
                                          disabled={savingNoteId === step.id || !draftNote.trim()}
                                          onClick={async () => {
                                            setSavingNoteId(step.id);
                                            await staffAddStepNote(loggedInStaff.id, step.id, draftNote.trim());
                                            const refresh = await getStaffProductionOrders(loggedInStaff.id);
                                            if (refresh.success) setProductionOrders(refresh.data);
                                            setSavingNoteId(null);
                                          }}
                                          className="px-2 py-1.5 bg-accent text-white rounded-lg text-[10px] font-semibold disabled:opacity-40 flex-shrink-0"
                                        >
                                          {savingNoteId === step.id ? '...' : 'Save'}
                                        </button>
                                      </div>
                                    )}
                                  </div>

                                  {/* Action buttons */}
                                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                                    {order.status === 'IN_PROGRESS' && step.status === 'PENDING' && (
                                      <button
                                        disabled={stepUpdating === step.id}
                                        onClick={async () => {
                                          setStepUpdating(step.id);
                                          const res = await staffUpdateProductionStep(loggedInStaff.id, step.id, 'IN_PROGRESS');
                                          if (res.success) {
                                            const refresh = await getStaffProductionOrders(loggedInStaff.id);
                                            if (refresh.success) setProductionOrders(refresh.data);
                                          } else { alert(res.error); }
                                          setStepUpdating(null);
                                        }}
                                        className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 active:scale-95 disabled:opacity-50 transition-all"
                                      >
                                        ▶ Start
                                      </button>
                                    )}
                                    {order.status === 'IN_PROGRESS' && step.status === 'IN_PROGRESS' && (
                                      <button
                                        disabled={stepUpdating === step.id}
                                        onClick={async () => {
                                          setStepUpdating(step.id);
                                          const note = (stepNotes[step.id] ?? '').trim() || undefined;
                                          const res = await staffUpdateProductionStep(loggedInStaff.id, step.id, 'DONE', note);
                                          if (res.success) {
                                            setStepNotes(n => { const c = {...n}; delete c[step.id]; return c; });
                                            const refresh = await getStaffProductionOrders(loggedInStaff.id);
                                            if (refresh.success) setProductionOrders(refresh.data);
                                          } else { alert(res.error); }
                                          setStepUpdating(null);
                                        }}
                                        className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 active:scale-95 disabled:opacity-50 transition-all"
                                      >
                                        ✓ Done
                                      </button>
                                    )}
                                    {step.status === 'DONE' && (
                                      <span className="text-[10px] text-emerald-600 font-semibold">Completed</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── Manager Notes ── */}
                    {order.notes && (
                      <div className="px-4 py-2.5 border-t border-border bg-amber-500/5">
                        <p className="text-[11px] text-amber-700 flex items-start gap-1.5">
                          <MessageSquare className="w-3 h-3 flex-shrink-0 mt-0.5" />
                          <span><span className="font-semibold">Manager note:</span> {order.notes}</span>
                        </p>
                      </div>
                    )}

                    {/* ── BOM Materials Checklist (with stock availability) ── */}
                    {bomItems.length > 0 && (
                      <div className="border-t border-border">
                        <button
                          onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                          className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover/50 transition-colors"
                        >
                          <span className="flex items-center gap-2 text-[11px] font-semibold text-muted uppercase tracking-wide">
                            <Boxes className="w-3.5 h-3.5" />
                            Required Materials ({bomItems.length})
                          </span>
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-muted" />}
                        </button>
                        {isExpanded && (
                          <div className="divide-y divide-border/40 bg-surface-hover/20">
                            {bomItems.map((item, idx) => {
                              const needed = item.quantity * order.plannedQty * (1 + (item.wastagePercent || 0) / 100);
                              const inStock = item.rawMaterial?.stock ?? 0;
                              const hasEnough = inStock >= needed;
                              return (
                                <div key={idx} className="px-4 py-2.5 flex items-center justify-between gap-3">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${hasEnough ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                                      <Boxes className={`w-3 h-3 ${hasEnough ? 'text-emerald-500' : 'text-red-500'}`} />
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-xs font-medium text-foreground truncate">{item.rawMaterial?.name || 'Material'}</p>
                                      <p className="text-[10px] text-muted">{item.rawMaterial?.sku} · Stock: {inStock} {item.rawMaterial?.unitOfMeasure}</p>
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <p className={`text-xs font-bold ${hasEnough ? 'text-emerald-600' : 'text-red-600'}`}>
                                      {Math.ceil(needed * 10) / 10} {item.unitOfMeasure || item.rawMaterial?.unitOfMeasure || 'PCS'}
                                    </p>
                                    <p className={`text-[10px] font-medium ${hasEnough ? 'text-emerald-600' : 'text-red-500'}`}>
                                      {hasEnough ? '✓ Available' : '⚠ Shortage'}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                            {bomItems.some(item => {
                              const needed = item.quantity * order.plannedQty * (1 + (item.wastagePercent || 0) / 100);
                              return (item.rawMaterial?.stock ?? 0) < needed;
                            }) && (
                              <div className="px-4 py-2 bg-red-500/5">
                                <p className="text-[10px] text-red-600 font-medium">⚠️ Some materials are short — inform your manager before starting</p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}


      {/* ===== STOCK UPDATES TAB ===== */}
      {tab === 'stock' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">My Stock Updates</h3>
            <button onClick={() => setShowLogStock(true)} className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-medium transition-all">
              <Plus className="w-4 h-4" /> Update Stock
            </button>
          </div>
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="crm-table min-w-[600px] sm:min-w-max whitespace-nowrap">
                <thead>
                  <tr><th>Product</th><th>Warehouse</th><th>Action</th><th>Qty</th><th>Date & Time</th></tr>
                </thead>
                <tbody>
                  {me.stockUpdates.map((u, i) => (
                    <tr key={i}>
                      <td className="font-medium text-foreground">{u.product}</td>
                      <td className="text-muted text-xs">{u.warehouse}</td>
                      <td><span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${stockActionColors[u.action]}`}>{u.action}</span></td>
                      <td className="font-semibold">{u.qty}</td>
                      <td className="text-xs text-muted">{u.date} · {u.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {me.stockUpdates.length === 0 && <p className="text-sm text-muted text-center py-8">No stock updates yet</p>}
          </div>
        </div>
      )}

      {/* ===== ASSIGNED VISITS TAB ===== */}
      {tab === 'assigned' && (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-foreground">Assigned Visits</h3>

          {/* Active assigned visits */}
          {assignedVisits.filter(v => v.status !== 'Completed' && v.status !== 'Cancelled').length > 0 && (
            <div className="space-y-3">
              {assignedVisits.filter(v => v.status !== 'Completed' && v.status !== 'Cancelled').map(visit => (
                <div key={visit.id} className="glass-card p-5 border-l-4 border-l-accent">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs text-accent">{visit.displayId}</span>
                        {visit.customOrderDisplayId && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent-light text-accent border border-accent/20">
                            Order: {visit.customOrderDisplayId}
                          </span>
                        )}
                        {visit.customOrderStatus && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-hover text-muted">
                            {visit.customOrderStatus}
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-foreground">{visit.customer}</p>
                      <p className="text-xs text-muted flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" /> {visit.address}</p>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-medium ${
                      visit.status === 'In Progress' ? 'bg-blue-500/10 text-blue-700' : 'bg-amber-500/10 text-amber-700'
                    }`}>{visit.status}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted mb-2">
                    <span><Calendar className="w-3 h-3 inline mr-1" />{visit.scheduledDate || visit.date}</span>
                    {visit.scheduledTime && <span><Clock className="w-3 h-3 inline mr-1" />{visit.scheduledTime}</span>}
                    <span className="px-2 py-0.5 rounded bg-surface-hover text-foreground">{visit.type}</span>
                    {visit.customOrderType && <span className="text-muted">({visit.customOrderType})</span>}
                  </div>
                  {visit.notes && <p className="text-xs text-muted mb-2">{visit.notes}</p>}

                  {/* ── Order Details Section ── */}
                  {visit.customOrderId && (
                    <div className="bg-surface rounded-xl p-3 mb-3 space-y-2.5">
                      <p className="text-[10px] font-semibold text-muted uppercase tracking-wide">Order Details</p>

                      {/* Info row: materials, color, delivery, price */}
                      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                        {visit.materials && (
                          <span className="text-xs text-foreground"><span className="text-muted">Material:</span> {visit.materials}</span>
                        )}
                        {visit.color && (
                          <span className="text-xs text-foreground"><span className="text-muted">Color:</span> {visit.color}</span>
                        )}
                        {visit.estimatedDelivery && (
                          <span className="text-xs text-foreground"><span className="text-muted">Est. Delivery:</span> {visit.estimatedDelivery}</span>
                        )}
                        {visit.quotedPrice != null && (
                          <span className="text-xs text-foreground"><span className="text-muted">Price:</span> ₹{visit.quotedPrice.toLocaleString()}</span>
                        )}
                        {visit.advancePaid > 0 && (
                          <span className="text-xs text-foreground"><span className="text-muted">Advance:</span> ₹{visit.advancePaid.toLocaleString()}</span>
                        )}
                      </div>

                      {/* Production notes */}
                      {visit.productionNotes && (
                        <p className="text-xs text-muted"><span className="text-foreground font-medium">Notes:</span> {visit.productionNotes}</p>
                      )}

                      {/* Reference Product */}
                      {visit.referenceProduct && (
                        <div className="flex items-center gap-3 bg-white/50 rounded-lg p-2 border border-border">
                          {visit.referenceProduct.image && (
                            <img src={visit.referenceProduct.image} alt="" className="w-10 h-10 rounded-lg object-cover border border-border" />
                          )}
                          <div>
                            <p className="text-xs font-medium text-foreground">{visit.referenceProduct.name}</p>
                            <p className="text-[10px] text-muted">SKU: {visit.referenceProduct.sku} · ₹{visit.referenceProduct.price?.toLocaleString()}</p>
                          </div>
                          <span className="ml-auto text-[10px] text-muted bg-surface-hover px-2 py-0.5 rounded">Reference</span>
                        </div>
                      )}

                      {/* Reference Images */}
                      {visit.referenceImages && visit.referenceImages.length > 0 && (
                        <div>
                          <p className="text-[10px] text-muted mb-1.5">Reference Images</p>
                          <div className="flex gap-2 flex-wrap">
                            {visit.referenceImages.map((url, i) => (
                              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="w-14 h-14 rounded-lg overflow-hidden border border-border hover:border-accent/50 transition-colors">
                                <img src={url} alt={`Ref ${i + 1}`} className="w-full h-full object-cover" />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Measurements */}
                  {visit.existingMeasurements && Object.values(visit.existingMeasurements).some(v => v) && (
                    <div className="bg-surface rounded-lg p-2.5 mb-2">
                      <p className="text-[10px] text-muted mb-1">Current Measurements</p>
                      <div className="flex flex-wrap gap-3">
                        {Object.entries(visit.existingMeasurements).filter(([k, v]) => v && k !== 'notes').map(([k, v]) => (
                          <span key={k} className="text-xs text-foreground capitalize"><span className="text-muted">{k}:</span> {v}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 mt-3 pt-3 border-t border-border flex-wrap">
                    {visit.status === 'Scheduled' && (
                      <button disabled={visitSaving} onClick={() => handleVisitStatusChange(visit, 'In Progress')} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500/10 text-blue-700 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-50">
                        Start Visit
                      </button>
                    )}
                    <button onClick={() => { setEditingVisit(visit); setShowUpdateVisit(true); }} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/10 text-purple-700 border border-purple-500/20 hover:bg-purple-500/20 transition-colors">
                      <Ruler className="w-3 h-3 inline mr-1" /> Update Measurements
                    </button>
                    {(visit.status === 'Scheduled' || visit.status === 'In Progress') && (
                      <button disabled={visitSaving} onClick={() => handleVisitStatusChange(visit, 'Completed')} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
                        <CheckCircle2 className="w-3 h-3 inline mr-1" /> Visit Completed
                      </button>
                    )}
                    {visit.status === 'Scheduled' && (
                      <button disabled={visitSaving} onClick={() => handleVisitStatusChange(visit, 'Cancelled')} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/10 text-red-700 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50">
                        Cannot Visit
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Completed assigned visits */}
          {assignedVisits.filter(v => v.status === 'Completed').length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Completed</h4>
              <div className="space-y-2">
                {assignedVisits.filter(v => v.status === 'Completed').map(visit => (
                  <div key={visit.id} className="glass-card p-4 opacity-80">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-xs text-muted">{visit.displayId}</span>
                          {visit.customOrderDisplayId && <span className="text-[10px] text-muted">({visit.customOrderDisplayId})</span>}
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-700">Completed</span>
                        </div>
                        <p className="text-sm font-medium text-foreground">{visit.customer}</p>
                      </div>
                      <div className="text-right text-xs text-muted">
                        <p>{visit.completedAt || visit.date}</p>
                        {visit.measurements && <p className="text-emerald-700 mt-0.5">Measurements recorded</p>}
                      </div>
                    </div>
                    {visit.staffNotes && <p className="text-xs text-muted mt-1 bg-surface rounded-lg p-2">{visit.staffNotes}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {assignedVisits.length === 0 && (
            <div className="glass-card p-8 text-center text-muted text-sm">No assigned visits</div>
          )}
        </div>
      )}

      {/* ===== SELF VISITS TAB ===== */}
      {tab === 'self' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">Self Visits</h3>
            <button onClick={() => setShowLogVisit(true)} className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-medium transition-all">
              <Plus className="w-4 h-4" /> Log Self Visit
            </button>
          </div>

          {selfVisits.length > 0 ? (
            <div className="space-y-3">
              {selfVisits.map(visit => (
                <div key={visit.id} className="glass-card p-5">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{visit.customer}</p>
                      <p className="text-xs text-muted flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" /> {visit.address}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-medium ${visit.status === 'Completed' ? 'bg-emerald-500/10 text-emerald-700' : visit.status === 'In Progress' ? 'bg-blue-500/10 text-blue-700' : 'bg-amber-500/10 text-amber-700'}`}>{visit.status}</span>
                      <button
                        onClick={() => handleMoveSelfVisitToDraft(visit.id)}
                        disabled={deletingVisitId === visit.id}
                        className="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        title="Move to Draft"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted mb-2">
                    <span>{visit.date} · {visit.time}</span>
                    <span className="px-2 py-0.5 rounded bg-surface-hover text-foreground">{visit.type}</span>
                  </div>
                  {visit.notes && <p className="text-xs text-muted mb-2">{visit.notes}</p>}
                  <div className="flex items-center gap-4">
                    {visit.measurements && (
                      <div className="flex items-center gap-1 text-xs text-indigo-700">
                        <Ruler className="w-3 h-3" />
                        {Object.entries(visit.measurements).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                      </div>
                    )}
                    {visit.photos > 0 && <span className="flex items-center gap-1 text-xs text-purple-700"><Camera className="w-3 h-3" /> {visit.photos} photo{visit.photos > 1 ? 's' : ''}</span>}
                  </div>
                  {visit.photoUrls && visit.photoUrls.length > 0 && (
                    <div className="flex gap-2 flex-wrap mt-2">
                      {visit.photoUrls.map((url, i) => (
                        <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="w-16 h-16 rounded-lg overflow-hidden border border-border hover:border-accent/50 transition-colors">
                          <img src={url} alt={`Visit photo ${i + 1}`} className="w-full h-full object-cover" />
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="mt-2">
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/10 text-purple-700 border border-purple-500/20 hover:bg-purple-500/20 cursor-pointer transition-colors">
                      {uploadingVisitId === visit.id ? (
                        <><Clock className="w-3 h-3 animate-spin" /> Uploading...</>
                      ) : (
                        <><Camera className="w-3 h-3" /> Upload Photos</>
                      )}
                      <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => handleUploadToVisit(visit.id, e)} className="hidden" disabled={uploadingVisitId === visit.id} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="glass-card p-8 text-center text-muted text-sm">No self visits logged yet</div>
          )}
        </div>
      )}

      {/* ===== MY ATTENDANCE TAB ===== */}
      {tab === 'attendance' && (() => {
        const { year, month } = attendanceMonth;
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const daysInMonth = new Date(year, month, 0).getDate();
        const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=Sun
        const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;

        const recordMap = {};
        monthAttendance.forEach(a => { recordMap[a.date] = a; });

        const toDateStr = d => `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

        // Stats
        const presentDays = monthAttendance.filter(a => a.status === 'Present').length;
        const lateDays    = monthAttendance.filter(a => a.isLate).length;
        const absentDays  = monthAttendance.filter(a => a.status === 'Absent').length;
        const workedRecs  = monthAttendance.filter(a => a.hours > 0);
        const totalHours  = workedRecs.reduce((s, a) => s + a.hours, 0);
        const avgHours    = workedRecs.length > 0 ? (totalHours / workedRecs.length).toFixed(1) : '0.0';
        // Attendance rate = present days / working days elapsed this month
        const workingDaysElapsed = (() => {
          let count = 0;
          const cap = isCurrentMonth ? today.getDate() : daysInMonth;
          for (let d = 1; d <= cap; d++) {
            if (new Date(year, month - 1, d).getDay() !== 0) count++;
          }
          return count;
        })();
        const attendanceRate = workingDaysElapsed > 0 ? Math.round(((presentDays + lateDays) / workingDaysElapsed) * 100) : 0;

        const prevMonth = () => setAttendanceMonth(p => {
          const m = p.month === 1 ? 12 : p.month - 1;
          const y = p.month === 1 ? p.year - 1 : p.year;
          return { year: y, month: m };
        });
        const nextMonth = () => {
          if (isCurrentMonth) return;
          setAttendanceMonth(p => {
            const m = p.month === 12 ? 1 : p.month + 1;
            const y = p.month === 12 ? p.year + 1 : p.year;
            return { year: y, month: m };
          });
        };

        // Calendar dot helper
        const getDotStyle = (d) => {
          const ds = toDateStr(d);
          const isFuture = ds > todayStr;
          const isSun = new Date(year, month - 1, d).getDay() === 0;
          const rec = recordMap[ds];
          const isToday = ds === todayStr;
          if (isFuture) return { dot: 'bg-transparent border border-border', text: 'text-zinc-600' };
          if (isSun && !rec) return { dot: 'bg-zinc-700/20', text: 'text-zinc-600' };
          if (!rec) return { dot: 'bg-zinc-600/30', text: 'text-muted' };
          if (rec.isLate) return { dot: 'bg-amber-500', text: isToday ? 'text-accent font-bold' : 'text-foreground' };
          if (rec.status === 'Present') return { dot: 'bg-emerald-500', text: isToday ? 'text-accent font-bold' : 'text-foreground' };
          if (rec.status === 'Absent') return { dot: 'bg-red-500', text: isToday ? 'text-accent font-bold' : 'text-foreground' };
          if (rec.status === 'Half Day') return { dot: 'bg-orange-400', text: isToday ? 'text-accent font-bold' : 'text-foreground' };
          return { dot: 'bg-zinc-500/30', text: 'text-muted' };
        };

        // Build descending day list (past only)
        const dayList = [];
        for (let d = daysInMonth; d >= 1; d--) {
          const ds = toDateStr(d);
          if (ds > todayStr) continue;
          const dateObj = new Date(year, month - 1, d);
          const isSunday = dateObj.getDay() === 0;
          const rec = recordMap[ds] || null;
          dayList.push({ d, ds, dateObj, isSunday, rec });
        }

        return (
          <div className="space-y-4">

            {/* ── Header ── */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Fingerprint className="w-5 h-5 text-accent" />
                <h3 className="text-base font-semibold text-foreground">Attendance</h3>
              </div>
              <div className="flex items-center gap-1 bg-surface border border-border rounded-xl p-1">
                <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-muted hover:text-foreground">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm font-medium text-foreground px-3 min-w-[130px] text-center">{monthLabel}</span>
                <button onClick={nextMonth} disabled={isCurrentMonth} className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-muted hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ── Stat strip ── */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Present', value: presentDays, sub: `${attendanceRate}% rate`, color: 'text-emerald-600', bg: 'bg-emerald-500/10', bar: 'bg-emerald-500' },
                { label: 'Absent',  value: absentDays,  sub: `${workingDaysElapsed} work days`, color: 'text-red-600',     bg: 'bg-red-500/10',     bar: 'bg-red-500' },
                { label: 'Late',    value: lateDays,    sub: 'arrivals',          color: 'text-amber-600', bg: 'bg-amber-500/10', bar: 'bg-amber-500' },
                { label: 'Avg',     value: `${avgHours}h`, sub: `${totalHours.toFixed(1)}h total`, color: 'text-blue-600',    bg: 'bg-blue-500/10',  bar: 'bg-blue-500' },
              ].map(s => (
                <div key={s.label} className="glass-card p-4 flex flex-col gap-2">
                  <div className={`w-8 h-8 rounded-xl ${s.bg} flex items-center justify-center`}>
                    <div className={`w-2.5 h-2.5 rounded-full ${s.bar}`} />
                  </div>
                  <div>
                    <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-[10px] text-muted leading-none">{s.label}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{s.sub}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* ── Attendance rate bar ── */}
            <div className="glass-card px-5 py-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-foreground">Monthly Attendance Rate</span>
                <span className={`text-sm font-bold ${attendanceRate >= 90 ? 'text-emerald-600' : attendanceRate >= 75 ? 'text-amber-600' : 'text-red-600'}`}>{attendanceRate}%</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${attendanceRate >= 90 ? 'bg-emerald-500' : attendanceRate >= 75 ? 'bg-amber-500' : 'bg-red-500'}`}
                  style={{ width: `${attendanceRate}%` }}
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-[10px] text-zinc-500">{presentDays + lateDays} days present out of {workingDaysElapsed} working days</span>
                <span className="text-[10px] text-zinc-500">{attendanceRate >= 90 ? '🟢 Excellent' : attendanceRate >= 75 ? '🟡 Good' : '🔴 Needs improvement'}</span>
              </div>
            </div>

            {/* ── Calendar heatmap ── */}
            <div className="glass-card p-5">
              <p className="text-xs font-medium text-muted uppercase tracking-wider mb-3">Month Overview</p>
              <div className="grid grid-cols-7 gap-y-2 gap-x-1 mb-2">
                {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                  <div key={d} className="text-center text-[10px] text-zinc-500 font-medium">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-y-2 gap-x-1">
                {Array(firstWeekday).fill(null).map((_, i) => <div key={`pad-${i}`} />)}
                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
                  const ds = toDateStr(d);
                  const { dot, text } = getDotStyle(d);
                  const isToday = ds === todayStr;
                  return (
                    <div key={d} className="flex flex-col items-center gap-1">
                      <span className={`text-[10px] leading-none ${text}`}>{d}</span>
                      <div className={`w-5 h-5 rounded-full ${dot} ${isToday ? 'ring-2 ring-accent ring-offset-1 ring-offset-[var(--color-background)]' : ''}`} />
                    </div>
                  );
                })}
              </div>
              {/* Legend */}
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border flex-wrap">
                {[
                  { dot: 'bg-emerald-500', label: 'Present' },
                  { dot: 'bg-amber-500',   label: 'Late' },
                  { dot: 'bg-red-500',     label: 'Absent' },
                  { dot: 'bg-orange-400',  label: 'Half Day' },
                  { dot: 'bg-zinc-600/30', label: 'No record' },
                ].map(l => (
                  <div key={l.label} className="flex items-center gap-1.5">
                    <div className={`w-2.5 h-2.5 rounded-full ${l.dot}`} />
                    <span className="text-[10px] text-zinc-500">{l.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Day-by-day list ── */}
            <div className="glass-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                <p className="text-xs font-medium text-muted uppercase tracking-wider">Daily Log</p>
                <p className="text-xs text-zinc-500">{dayList.length} days shown</p>
              </div>
              {attendanceLoading ? (
                <div className="flex items-center justify-center py-12 gap-2 text-muted text-sm">
                  <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  Loading...
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {dayList.map(({ d, ds, dateObj, isSunday, rec }) => {
                    const isToday = ds === todayStr;
                    const weekday = dateObj.toLocaleDateString('en-IN', { weekday: 'short' });
                    const dateLabel = dateObj.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });

                    // Determine status display
                    let statusLabel, statusClass, dotClass;
                    if (rec) {
                      if (rec.status === 'Present' && !rec.isLate) {
                        statusLabel = 'Present'; statusClass = 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20'; dotClass = 'bg-emerald-500';
                      } else if (rec.isLate) {
                        statusLabel = 'Late'; statusClass = 'bg-amber-500/10 text-amber-700 border-amber-500/20'; dotClass = 'bg-amber-500';
                      } else if (rec.status === 'Absent') {
                        statusLabel = 'Absent'; statusClass = 'bg-red-500/10 text-red-700 border-red-500/20'; dotClass = 'bg-red-500';
                      } else if (rec.status === 'Half Day') {
                        statusLabel = 'Half Day'; statusClass = 'bg-orange-500/10 text-orange-700 border-orange-500/20'; dotClass = 'bg-orange-400';
                      } else {
                        statusLabel = rec.status; statusClass = 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'; dotClass = 'bg-zinc-400';
                      }
                    } else if (isSunday) {
                      statusLabel = 'Sunday'; statusClass = 'bg-zinc-500/5 text-zinc-500 border-zinc-500/10'; dotClass = 'bg-zinc-600/20';
                    } else {
                      statusLabel = 'No record'; statusClass = 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'; dotClass = 'bg-zinc-600/30';
                    }

                    return (
                      <div key={ds} className={`flex items-center gap-4 px-5 py-3.5 transition-colors ${isToday ? 'bg-accent/5' : isSunday && !rec ? 'opacity-40' : 'hover:bg-surface-hover'}`}>

                        {/* Date column */}
                        <div className="w-14 flex-shrink-0 text-center">
                          <p className={`text-xl font-bold leading-none ${isToday ? 'text-accent' : 'text-foreground'}`}>{d}</p>
                          <p className="text-[10px] text-muted mt-0.5">{weekday}</p>
                          {isToday && <p className="text-[9px] text-accent font-medium mt-0.5">TODAY</p>}
                        </div>

                        {/* Dot indicator */}
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />

                        {/* Status + times */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusClass}`}>{statusLabel}</span>
                            <span className="text-[10px] text-zinc-500">{dateLabel}</span>
                          </div>
                          {rec?.clockIn && (
                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                              <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                                <LogIn className="w-3 h-3" /> {rec.clockIn}
                              </span>
                              {rec.clockOut && (
                                <span className="flex items-center gap-1 text-xs text-red-500 font-medium">
                                  <LogOut className="w-3 h-3" /> {rec.clockOut}
                                </span>
                              )}
                              {rec.clockInDist != null && (
                                <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                                  <MapPin className="w-2.5 h-2.5" /> {rec.clockInDist}m
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Hours badge */}
                        {rec?.hours > 0 ? (
                          <div className="flex-shrink-0 text-right">
                            <p className="text-base font-bold text-foreground">{rec.hours}<span className="text-xs font-normal text-muted">h</span></p>
                            {rec.method === 'gps' && <p className="text-[9px] text-teal-600 font-medium">GPS ✓</p>}
                          </div>
                        ) : (
                          <div className="flex-shrink-0 w-10" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        );
      })()}

      {/* ===== MY SALES TAB ===== */}
      {tab === 'sales' && (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-foreground">My Sales History</h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-success-light"><DollarSign className="w-5 h-5 text-success" /></div>
              <div><p className="text-xs text-muted">Total Revenue</p><p className="text-lg font-bold text-success">₹{(stats.revenue / 100000).toFixed(1)}L</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-accent-light"><TrendingUp className="w-5 h-5 text-accent" /></div>
              <div><p className="text-xs text-muted">Conversions</p><p className="text-lg font-bold text-foreground">{stats.conversions} / {stats.leadsAssigned}</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-purple-light"><ShoppingBag className="w-5 h-5 text-purple" /></div>
              <div><p className="text-xs text-muted">Today</p><p className="text-lg font-bold text-foreground">{stats.todaySales} sales — ₹{stats.todayRevenue.toLocaleString()}</p></div>
            </div>
          </div>

          <div className="glass-card overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Recent Sales</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="crm-table min-w-[600px] sm:min-w-max whitespace-nowrap">
                <thead>
                  <tr><th>Product</th><th>Customer</th><th>Date</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {recentSales.map((sale, i) => (
                    <tr key={i}>
                      <td className="font-medium text-foreground">{sale.product}</td>
                      <td className="text-muted">{sale.customer}</td>
                      <td className="text-muted text-xs">{sale.date}</td>
                      <td className="font-semibold text-success">₹{sale.amount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {recentSales.length === 0 && <p className="text-sm text-muted text-center py-8">No sales recorded</p>}
          </div>
        </div>
      )}

      {/* ===== LOG ACTIVITY MODAL ===== */}
      <Modal isOpen={showLogActivity} onClose={() => setShowLogActivity(false)} title="Log Activity" size="md">
        <form onSubmit={handleLogActivity} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Activity Type</label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(activityIcons).map(([key, config]) => {
                const Icon = config.icon;
                return (
                  <button key={key} type="button" onClick={() => setActivityType(key)} className={`flex flex-col items-center gap-1 p-2.5 rounded-xl border transition-all text-xs ${activityType === key ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/30'}`}>
                    <Icon className={`w-4 h-4 ${activityType === key ? 'text-accent' : 'text-muted'}`} />
                    <span className={activityType === key ? 'text-accent font-medium' : 'text-muted'}>{config.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Description</label>
            <textarea value={activityText} onChange={e => setActivityText(e.target.value)} placeholder="Describe the activity..." rows={3} className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm resize-none" required />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowLogActivity(false)} className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors">Cancel</button>
            <button type="submit" className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">Log Activity</button>
          </div>
        </form>
      </Modal>

      {/* ===== LOG STOCK MODAL ===== */}
      <Modal isOpen={showLogStock} onClose={() => { setShowLogStock(false); setStockMsg(''); setStockProduct(null); setStockProductSearch(''); setStockQty(''); }} title="Update Stock" size="md">
        <form onSubmit={handleLogStock} className="space-y-4">
          {/* Product Search */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Select Product *</label>
            {stockProduct ? (
              <div className="flex items-center justify-between px-4 py-3 bg-surface border border-border rounded-xl">
                <div>
                  <p className="text-sm font-medium text-foreground">{stockProduct.name}</p>
                  <p className="text-xs text-muted">SKU: {stockProduct.sku} · Current stock: <span className={`font-semibold ${stockProduct.stock <= 5 ? 'text-red-700' : 'text-emerald-700'}`}>{stockProduct.stock} units</span> · {stockProduct.warehouse}</p>
                </div>
                <button type="button" onClick={() => { setStockProduct(null); setStockProductSearch(''); }} className="text-muted hover:text-foreground ml-3">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  type="text"
                  placeholder="Search by product name or SKU..."
                  value={stockProductSearch}
                  onChange={e => { setStockProductSearch(e.target.value); setShowStockDropdown(true); }}
                  onFocus={() => setShowStockDropdown(true)}
                  onBlur={() => setTimeout(() => setShowStockDropdown(false), 200)}
                  className="w-full pl-10 pr-4 py-2.5 bg-surface rounded-xl border border-border text-sm"
                  autoFocus
                />
                {showStockDropdown && (
                  <div className="absolute z-20 w-full mt-1 bg-surface border border-border rounded-xl shadow-lg max-h-56 overflow-y-auto">
                    {products
                      .filter(p => !stockProductSearch || p.name.toLowerCase().includes(stockProductSearch.toLowerCase()) || p.sku.toLowerCase().includes(stockProductSearch.toLowerCase()))
                      .slice(0, 12)
                      .map(p => (
                        <button key={p.id} type="button"
                          onClick={() => { setStockProduct(p); setShowStockDropdown(false); setStockProductSearch(''); }}
                          className="w-full text-left px-4 py-2.5 hover:bg-surface-hover border-b border-border last:border-0 transition-colors"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-foreground">{p.name}</p>
                              <p className="text-xs text-muted">SKU: {p.sku} · {p.warehouse}</p>
                            </div>
                            <span className={`text-xs font-semibold ${p.stock <= p.reorderLevel ? 'text-red-700' : 'text-emerald-700'}`}>{p.stock} in stock</span>
                          </div>
                        </button>
                      ))}
                    {products.filter(p => !stockProductSearch || p.name.toLowerCase().includes(stockProductSearch.toLowerCase()) || p.sku.toLowerCase().includes(stockProductSearch.toLowerCase())).length === 0 && (
                      <p className="px-4 py-3 text-xs text-muted text-center">No products found</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action & Quantity */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Action</label>
              <select value={stockAction} onChange={e => setStockAction(e.target.value)} className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm">
                <option>Received</option>
                <option>Stock Out</option>
                <option>Dispatched</option>
                <option>Low Stock Alert</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Quantity</label>
              <input type="number" min="1" value={stockQty} onChange={e => setStockQty(e.target.value)} placeholder="Enter quantity" className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm" required />
            </div>
          </div>

          {/* Stock preview */}
          {stockProduct && stockQty && parseInt(stockQty) > 0 && (
            <div className="px-4 py-3 bg-surface rounded-xl text-xs text-muted flex items-center justify-between">
              <span>Stock after update:</span>
              <span className="font-semibold text-foreground">
                {stockAction === 'Received'
                  ? `${stockProduct.stock} + ${stockQty} = ${stockProduct.stock + parseInt(stockQty)} units`
                  : stockAction === 'Stock Out' || stockAction === 'Dispatched'
                  ? `${stockProduct.stock} − ${stockQty} = ${Math.max(0, stockProduct.stock - parseInt(stockQty))} units`
                  : `${stockProduct.stock} units (no change)`}
              </span>
            </div>
          )}

          {stockMsg && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-700 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {stockMsg}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => { setShowLogStock(false); setStockMsg(''); setStockProduct(null); setStockProductSearch(''); setStockQty(''); }} className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors">Cancel</button>
            <button type="submit" disabled={stockSaving || !stockProduct} className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50">
              {stockSaving ? 'Updating...' : 'Update Stock'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ===== LOG FIELD VISIT MODAL ===== */}
      <Modal isOpen={showLogVisit} onClose={() => setShowLogVisit(false)} title="Log Self Visit" size="md">
        <form onSubmit={handleLogVisit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Customer Name</label>
            <input type="text" value={visitCustomer} onChange={e => setVisitCustomer(e.target.value)} placeholder="Customer name" className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Address</label>
            <input type="text" value={visitAddress} onChange={e => setVisitAddress(e.target.value)} placeholder="Full address" className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Visit Type</label>
            <select value={visitType} onChange={e => setVisitType(e.target.value)} className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm">
              <option>Measurement</option>
              <option>Design Consultation</option>
              <option>Delivery Check</option>
              <option>Installation</option>
              <option>Follow-up</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Notes</label>
            <textarea value={visitNotes} onChange={e => setVisitNotes(e.target.value)} placeholder="Visit details, what to measure..." rows={2} className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Photos (max 5)</label>
            <div className="space-y-2">
              {visitPhotos.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {visitPhotos.map((p, i) => (
                    <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-border group">
                      <img src={p.preview} alt={p.name} className="w-full h-full object-cover" />
                      <button type="button" onClick={() => { URL.revokeObjectURL(p.preview); setVisitPhotos(prev => prev.filter((_, idx) => idx !== i)); }} className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <X className="w-4 h-4 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {visitPhotos.length < 5 && (
                <label className="flex items-center gap-2 px-4 py-2.5 bg-surface border border-dashed border-border rounded-xl text-sm text-muted hover:border-accent/50 hover:text-foreground cursor-pointer transition-colors">
                  <Camera className="w-4 h-4" /> Add Photos
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handlePhotoSelect} className="hidden" />
                </label>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Measurements (optional)</label>
            <input type="text" value={visitMeasurements} onChange={e => setVisitMeasurements(e.target.value)} placeholder="length: 8 ft, width: 4 ft, height: 3 ft" className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm" />
            <p className="text-[10px] text-muted mt-1">Format: key: value, key: value</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowLogVisit(false)} className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors">Cancel</button>
            <button type="submit" disabled={uploadingPhotos} className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50">
              {uploadingPhotos ? 'Uploading...' : 'Schedule Visit'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ===== UPDATE VISIT MODAL (Custom Order Visits) ===== */}
      <Modal isOpen={showUpdateVisit} onClose={() => { setShowUpdateVisit(false); setEditingVisit(null); }} title="Update Visit & Measurements" size="md">
        {editingVisit && (
          <form onSubmit={handleUpdateAssignedVisit} className="space-y-4">
            {/* Visit context */}
            <div className="bg-surface rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs text-accent">{editingVisit.displayId}</span>
                {editingVisit.customOrderDisplayId && (
                  <span className="text-[10px] text-muted">Custom Order: {editingVisit.customOrderDisplayId}</span>
                )}
              </div>
              <p className="text-sm font-medium text-foreground">{editingVisit.customer}</p>
              <p className="text-xs text-muted">{editingVisit.address}</p>
            </div>

            {/* Visit Status */}
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Visit Status</label>
              <select name="status" defaultValue={editingVisit.status} className="w-full px-4 py-2.5 rounded-xl text-sm">
                <option value="Scheduled">Scheduled</option>
                <option value="In Progress">In Progress</option>
                <option value="Completed">Completed</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>

            {/* Measurements */}
            <div className="border-t border-border pt-4">
              <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <Ruler className="w-4 h-4 text-accent" /> Measurements
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs text-muted mb-1">Length</label><input type="text" name="length" defaultValue={editingVisit.measurements?.length || editingVisit.existingMeasurements?.length || ''} placeholder="e.g., 12 ft" className="w-full px-3 py-2.5 rounded-xl text-sm" /></div>
                <div><label className="block text-xs text-muted mb-1">Width</label><input type="text" name="width" defaultValue={editingVisit.measurements?.width || editingVisit.existingMeasurements?.width || ''} placeholder="e.g., 8 ft" className="w-full px-3 py-2.5 rounded-xl text-sm" /></div>
                <div><label className="block text-xs text-muted mb-1">Height</label><input type="text" name="height" defaultValue={editingVisit.measurements?.height || editingVisit.existingMeasurements?.height || ''} placeholder="e.g., 9 ft" className="w-full px-3 py-2.5 rounded-xl text-sm" /></div>
                <div><label className="block text-xs text-muted mb-1">Depth</label><input type="text" name="depth" defaultValue={editingVisit.measurements?.depth || editingVisit.existingMeasurements?.depth || ''} placeholder="e.g., 2 ft" className="w-full px-3 py-2.5 rounded-xl text-sm" /></div>
              </div>
              <div className="mt-3">
                <label className="block text-xs text-muted mb-1">Countertop</label>
                <input type="text" name="countertop" defaultValue={editingVisit.measurements?.countertop || editingVisit.existingMeasurements?.countertop || ''} placeholder="e.g., Granite 4x2 ft" className="w-full px-3 py-2.5 rounded-xl text-sm" />
              </div>
              <div className="mt-3">
                <label className="block text-xs text-muted mb-1">Measurement Notes</label>
                <textarea name="measurementNotes" rows={2} defaultValue={editingVisit.measurements?.notes || ''} placeholder="Additional measurement details..." className="w-full px-3 py-2.5 rounded-xl text-sm resize-none" />
              </div>
            </div>

            {/* Staff Notes */}
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Your Notes</label>
              <textarea name="staffNotes" rows={2} defaultValue={editingVisit.staffNotes || ''} placeholder="Notes about the visit, site conditions, customer preferences..." className="w-full px-4 py-2.5 rounded-xl text-sm resize-none" />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => { setShowUpdateVisit(false); setEditingVisit(null); }} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
              <button type="submit" disabled={visitSaving} className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50">
                {visitSaving ? 'Saving...' : 'Save Updates'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
