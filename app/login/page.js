'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getStaffLoginOptions } from '@/app/actions/staff';
import { getPublicBranding } from '@/app/actions/settings';
import { getBrand } from '@/lib/brand';
import Image from 'next/image';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900"><div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" /></div>}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const brand = getBrand();
  const [mode, setMode] = useState(null); // null = chooser, 'admin', 'staff'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [storeProfile, setStoreProfile] = useState({ name: brand.name, logo: brand.logo });
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';

  // Staff login state
  const [staffList, setStaffList] = useState([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [staffPassword, setStaffPassword] = useState('');

  useEffect(() => {
    if (mode === 'staff' && staffList.length === 0) {
      setStaffLoading(true);
      getStaffLoginOptions().then(res => {
        if (res.success) setStaffList(res.data);
        setStaffLoading(false);
      });
    }
  }, [mode, staffList.length]);

  useEffect(() => {
    let active = true;
    getPublicBranding().then(res => {
      if (!active || !res.success) return;
      setStoreProfile({
        name: res.data.storeName || brand.name,
        logo: res.data.logo || brand.logo,
      });
    });
    return () => { active = false; };
  }, []);

  const handleAdminSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, type: 'credentials' }),
      });

      let result = {};
      try {
        result = await res.json();
      } catch {
        // Response was not JSON
      }

      if (!res.ok) {
        setError(result.error || (res.status === 401 ? 'Invalid email or password' : 'Login failed. Please try again.'));
      } else {
        // Full page reload so AuthProvider re-mounts and fetches the fresh session.
        // Always redirect admin login to '/' (dashboard), never follow callbackUrl,
        // which could be '/staff-portal' from a previous staff session.
        window.location.href = '/';
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleStaffSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!selectedStaffId) {
      setError('Please select a staff member');
      return;
    }
    if (!staffPassword) {
      setError('Please enter your login password');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffId: selectedStaffId,
          password: staffPassword,
          type: 'staff-credentials',
        }),
      });

      let result = {};
      try {
        result = await res.json();
      } catch {
        // Response was not JSON
      }

      if (!res.ok) {
        setError(result.error || (res.status === 401 ? 'Invalid staff credentials.' : 'Login failed. Please try again.'));
      } else {
        // Full page reload so AuthProvider re-mounts and fetches the fresh session
        window.location.href = '/staff-portal';
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  // Role chooser
  if (mode === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
        <div className="w-full max-w-lg">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
            <div className="text-center mb-8">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 bg-blue-600 overflow-hidden">
                <Image src={storeProfile.logo} alt={`${storeProfile.name} Logo`} width={64} height={64} unoptimized className="w-full h-full object-contain bg-white" />
              </div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{storeProfile.name}</h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1">Choose how you want to sign in</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setMode('admin')}
                className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-gray-200 dark:border-gray-600 hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all group"
              >
                <div className="w-14 h-14 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center group-hover:bg-blue-200 dark:group-hover:bg-blue-900/50 transition-colors">
                  <svg className="w-7 h-7 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="font-semibold text-gray-900 dark:text-white">Admin</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Full dashboard access</p>
                </div>
              </button>

              <button
                onClick={() => setMode('staff')}
                className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-gray-200 dark:border-gray-600 hover:border-amber-500 dark:hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-all group"
              >
                <div className="w-14 h-14 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center group-hover:bg-amber-200 dark:group-hover:bg-amber-900/50 transition-colors">
                  <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="font-semibold text-gray-900 dark:text-white">Staff</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Staff portal & tasks</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          {/* Logo & Header */}
          <div className="text-center mb-8">
            <div className={`w-16 h-16 ${mode === 'admin' ? 'bg-blue-600' : 'bg-amber-500'} rounded-2xl flex items-center justify-center mx-auto mb-4 overflow-hidden`}>
              <Image src={storeProfile.logo} alt={`${storeProfile.name} Logo`} width={64} height={64} unoptimized className="w-full h-full object-contain bg-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {mode === 'admin' ? 'Admin Login' : 'Staff Login'}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {mode === 'admin' ? 'Sign in with your admin credentials' : 'Select your name and enter your assigned login password'}
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm text-center">
              {error}
            </div>
          )}

          {/* Admin Form */}
          {mode === 'admin' && (
            <form onSubmit={handleAdminSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Username or Email</label>
                <input type="text" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" placeholder="Enter username or email"
                  className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="Enter your password"
                  className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all" />
              </div>
              <button type="submit" disabled={loading}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2">
                {loading ? (
                  <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Signing in...</>
                ) : 'Sign In'}
              </button>
            </form>
          )}

          {/* Staff Form */}
          {mode === 'staff' && (
            <form onSubmit={handleStaffSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Select Staff Member</label>
                {staffLoading ? (
                  <div className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-400 text-sm animate-pulse">Loading staff...</div>
                ) : (
                  <select value={selectedStaffId} onChange={(e) => setSelectedStaffId(e.target.value)} required
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none transition-all">
                    <option value="">Choose your name</option>
                    {staffList.map(s => (
                      <option key={s.id} value={s.id}>{s.name} — {s.role}</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Password</label>
                <input type="password" value={staffPassword} onChange={(e) => setStaffPassword(e.target.value)} required placeholder="Enter your login password"
                  className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none transition-all" />
              </div>
              <button type="submit" disabled={loading}
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-400 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2">
                {loading ? (
                  <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Signing in...</>
                ) : 'Enter Staff Portal'}
              </button>
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <p className="text-xs text-amber-600 dark:text-amber-400 text-center">Use the login password assigned by admin in Settings / Team.</p>
              </div>
            </form>
          )}

          {/* Back button */}
          <button onClick={() => { setMode(null); setError(''); }} className="w-full mt-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
            ← Back to role selection
          </button>
        </div>
      </div>
    </div>
  );
}
