'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  PhoneOff,
  Clock,
  Search,
  Filter,
  Calendar,
  User,
  MessageSquare,
  Play,
  ChevronDown,
  ChevronRight,
  BookOpen,
  Plus,
  ArrowUpRight,
  ArrowDownLeft,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Tag,
  Mail,
  FileText,
  BarChart3,
  TrendingUp,
  Users,
  CalendarPlus,
  X,
  Bot,
  PhoneCall,
  Mic,
  MicOff,
  Wifi,
  WifiOff,
  Settings,
  Loader2,
  Volume2,
} from 'lucide-react';
import StatCard from '@/components/StatCard';
import Modal from '@/components/Modal';
import { getCallLogs, initiateAICall, getAIAgentStatus } from '@/app/actions/calls';

const TABS = [
  { id: 'ai-caller', label: 'AI Caller', icon: Bot },
  { id: 'logs', label: 'Call Logs', icon: Phone },
  { id: 'phonebook', label: 'Phone Book', icon: BookOpen },
  { id: 'transcripts', label: 'Transcripts', icon: MessageSquare },
  { id: 'book', label: 'Book Appointment', icon: CalendarPlus },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
];

const directionFilters = ['All', 'Inbound', 'Outbound'];
const statusFilters = ['All', 'Completed', 'Missed', 'No Answer', 'Busy'];
const tagFilters = ['All', 'Hot Lead', 'Warm Lead', 'Cold Lead', 'Customer', 'Unknown'];

export default function CallsPage() {
  const [callLogs, setCallLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('ai-caller');
  const [searchQuery, setSearchQuery] = useState('');
  const [directionFilter, setDirectionFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [tagFilter, setTagFilter] = useState('All');
  const [selectedCall, setSelectedCall] = useState(null);
  const [selectedTranscript, setSelectedTranscript] = useState(null);
  const [selectedContact, setSelectedContact] = useState(null);
  const [showBookModal, setShowBookModal] = useState(false);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [expandedTranscript, setExpandedTranscript] = useState(null);

  // AI Caller state
  const [agentStatus, setAgentStatus] = useState(null);
  const [outboundPhone, setOutboundPhone] = useState('');
  const [outboundName, setOutboundName] = useState('');
  const [outboundReason, setOutboundReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [callingState, setCallingState] = useState('idle'); // idle | calling | connected | ended
  const [activeCallLogId, setActiveCallLogId] = useState(null);
  const [browserCallState, setBrowserCallState] = useState('idle'); // idle | connecting | connected
  const [callMessage, setCallMessage] = useState('');
  const browserRoomRef = useRef(null);

  const removeBrowserCallAudio = () => {
    document.querySelectorAll('[data-livekit-browser-audio="true"]').forEach((element) => element.remove());
  };

  const disconnectBrowserRoom = async (room = browserRoomRef.current) => {
    if (!room) return;
    // Prevent a pending microphone negotiation from using a room we are closing.
    if (browserRoomRef.current === room) browserRoomRef.current = null;
    removeBrowserCallAudio();
    try {
      await room.disconnect();
    } catch (error) {
      console.warn('Browser voice room cleanup failed:', error);
    }
  };

  const refreshLogs = () => {
    getCallLogs().then(res => {
      if (res.success) setCallLogs(res.data);
    });
  };

  useEffect(() => {
    getCallLogs().then(res => {
      if (res.success) setCallLogs(res.data);
      setLoading(false);
    });
    getAIAgentStatus().then(res => {
      if (res.success) setAgentStatus(res.data);
    });
  }, []);

  // Auto-refresh while either calling mode is active.
  useEffect(() => {
    if (callingState !== 'connected' && browserCallState !== 'connected') return;
    const interval = setInterval(refreshLogs, 15000);
    return () => clearInterval(interval);
  }, [callingState, browserCallState]);

  useEffect(() => {
    if (!activeCallLogId) return;
    const activeCall = callLogs.find((call) => call.id === activeCallLogId);
    if (!activeCall) return;
    if (['Completed', 'No answer', 'Busy', 'Failed', 'Missed'].includes(activeCall.status)) {
      setCallingState('ended');
      setCallMessage(`Call finished: ${activeCall.outcome || activeCall.status}.`);
    }
  }, [activeCallLogId, callLogs]);

  // A call may finish while another tab is open. Always load fresh database
  // state when the user opens logs or transcripts.
  useEffect(() => {
    if (activeTab !== 'logs' && activeTab !== 'transcripts') return;
    getCallLogs().then(res => {
      if (res.success) setCallLogs(res.data);
    });
  }, [activeTab]);

  useEffect(() => () => {
    const room = browserRoomRef.current;
    browserRoomRef.current = null;
    removeBrowserCallAudio();
    if (room) void room.disconnect().catch(() => undefined);
  }, []);

  // Derive phone book from call logs
  const phoneBook = useMemo(() => {
    const map = {};
    callLogs.forEach(c => {
      if (!map[c.phone]) {
        map[c.phone] = { name: c.customer, phone: c.phone, totalCalls: 0, lastCall: c.date, tag: 'Customer' };
      }
      map[c.phone].totalCalls++;
    });
    return Object.values(map);
  }, [callLogs]);

  // Derive transcripts from call logs with transcripts
  const callTranscripts = useMemo(() => {
    return callLogs.filter(c => c.transcript).map(c => ({
      id: c.id, customer: c.customer, phone: c.phone, date: c.date, time: c.time,
      direction: c.direction, duration: c.duration,
      summary: c.transcript.summary || 'AI-handled call', sentiment: c.transcript.sentiment || 'Neutral',
      messages: Array.isArray(c.transcript.messages) ? c.transcript.messages : [],
    }));
  }, [callLogs]);

  // Filtered call logs
  const filteredLogs = useMemo(() => {
    return callLogs.filter((call) => {
      const matchesSearch =
        call.customer.toLowerCase().includes(searchQuery.toLowerCase()) ||
        call.phone.includes(searchQuery);
      const matchesDirection = directionFilter === 'All' || call.direction === directionFilter;
      const matchesStatus = statusFilter === 'All' || call.status === statusFilter;
      return matchesSearch && matchesDirection && matchesStatus;
    });
  }, [searchQuery, directionFilter, statusFilter, callLogs]);

  // Filtered phone book
  const filteredPhoneBook = useMemo(() => {
    return phoneBook.filter((contact) => {
      const matchesSearch =
        contact.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        contact.phone.includes(searchQuery);
      const matchesTag = tagFilter === 'All' || contact.tag === tagFilter;
      return matchesSearch && matchesTag;
    });
  }, [searchQuery, tagFilter, phoneBook]);

  // Filtered transcripts
  const filteredTranscripts = useMemo(() => {
    return callTranscripts.filter((t) => {
      return (
        t.customer.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.phone.includes(searchQuery) ||
        (t.summary || '').toLowerCase().includes(searchQuery.toLowerCase())
      );
    });
  }, [searchQuery, callTranscripts]);

  // Compute detailed stats from callLogs
  const computedStats = useMemo(() => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayCalls = callLogs.filter(c => c.date === todayStr);
    const inbound = callLogs.filter(c => c.direction === 'Inbound').length;
    const outbound = callLogs.filter(c => c.direction === 'Outbound').length;
    const completed = callLogs.filter(c => c.status === 'Completed').length;
    const missed = callLogs.filter(c => c.status === 'Missed').length;
    const noAnswer = callLogs.filter(c => c.status === 'No answer' || c.status === 'No Answer').length;
    const busy = callLogs.filter(c => c.status === 'Busy').length;
    const totalSec = callLogs.reduce((s, c) => s + (c.durationSec || 0), 0);
    const avgSec = callLogs.length > 0 ? Math.round(totalSec / callLogs.length) : 0;
    const avgMin = Math.floor(avgSec / 60);
    const avgSecR = avgSec % 60;
    return {
      totalCalls: callLogs.length,
      todayCalls: todayCalls.length,
      todayInbound: todayCalls.filter(c => c.direction === 'Inbound').length,
      todayOutbound: todayCalls.filter(c => c.direction === 'Outbound').length,
      inbound, outbound, completed, missed, noAnswer, busy,
      avgDuration: `${avgMin}:${String(avgSecR).padStart(2, '0')}`,
      appointmentsBooked: callLogs.filter(c => (c.outcome || '').toLowerCase().includes('appointment')).length,
      quotationsSent: callLogs.filter(c => (c.outcome || '').toLowerCase().includes('quotation')).length,
    };
  }, [callLogs]);
  // Use computedStats as callStats
  const callStats = computedStats;

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-surface rounded-2xl" />)}</div>
        <div className="h-64 bg-surface rounded-2xl" />
      </div>
    );
  }

  const getDirectionIcon = (direction) => {
    if (direction === 'Inbound') return <ArrowDownLeft className="w-4 h-4 text-teal-700" />;
    return <ArrowUpRight className="w-4 h-4 text-amber-700" />;
  };

  const getStatusBadge = (status) => {
    if (status === 'Queued') return <span className="px-2 py-0.5 rounded-full text-xs border bg-blue-500/10 text-blue-700 border-blue-500/20">Queued</span>;
    if (status === 'In progress') return <span className="px-2 py-0.5 rounded-full text-xs border bg-amber-500/10 text-amber-700 border-amber-500/20">In progress</span>;
    if (status === 'Failed') return <span className="px-2 py-0.5 rounded-full text-xs border bg-red-500/10 text-red-700 border-red-500/20">Failed</span>;
    const styles = {
      Completed: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
      Missed: 'bg-red-500/10 text-red-700 border-red-500/20',
      'No Answer': 'bg-orange-500/10 text-orange-700 border-orange-500/20',
      Busy: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/20',
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs border ${styles[status] || ''}`}>
        {status}
      </span>
    );
  };

  const getTagBadge = (tag) => {
    const styles = {
      'Hot Lead': 'bg-red-500/10 text-red-700 border-red-500/20',
      'Warm Lead': 'bg-orange-500/10 text-orange-700 border-orange-500/20',
      'Cold Lead': 'bg-blue-500/10 text-blue-700 border-blue-500/20',
      Customer: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
      Unknown: 'bg-zinc-500/10 text-stone-500 border-zinc-500/20',
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs border ${styles[tag] || ''}`}>
        {tag}
      </span>
    );
  };

  const getSentimentBadge = (sentiment) => {
    const styles = {
      Positive: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
      Neutral: 'bg-zinc-500/10 text-stone-500 border-zinc-500/20',
      Negative: 'bg-red-500/10 text-red-700 border-red-500/20',
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs border ${styles[sentiment] || ''}`}>
        {sentiment}
      </span>
    );
  };

  const getOutcomeBadge = (outcome) => {
    const positiveOutcomes = ['Appointment Booked', 'Quote Sent', 'Confirmed', 'Resolved', 'Review Collected', 'Informed', 'Interested'];
    const neutralOutcomes = ['Transferred to Human', 'Callback Scheduled', 'Voicemail Left'];
    const negativeOutcomes = ['Escalated', 'Retry Later'];

    let cls = 'bg-zinc-500/10 text-stone-500 border-zinc-500/20';
    if (positiveOutcomes.includes(outcome)) cls = 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20';
    else if (neutralOutcomes.includes(outcome)) cls = 'bg-amber-500/10 text-amber-700 border-amber-500/20';
    else if (negativeOutcomes.includes(outcome)) cls = 'bg-red-500/10 text-red-700 border-red-500/20';

    return (
      <span className={`px-2 py-0.5 rounded-full text-xs border ${cls}`}>
        {outcome}
      </span>
    );
  };

  // ─── CALL LOGS TAB ───
  const renderCallLogs = () => (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Phone} label="Total Calls Today" value={callStats.todayCalls} trend="+3 vs yesterday" positive />
        <StatCard icon={PhoneIncoming} label="Inbound" value={callStats.todayInbound} trend={`${callStats.inbound} total`} positive />
        <StatCard icon={PhoneOutgoing} label="Outbound" value={callStats.todayOutbound} trend={`${callStats.outbound} total`} positive />
        <StatCard icon={Clock} label="Avg Duration" value={callStats.avgDuration} trend="min:sec" />
      </div>

      {/* Filters — Desktop (md+) */}
      <div className="hidden md:flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder="Search by name or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
          />
        </div>
        <div className="flex gap-1">
          {directionFilters.map((f) => (
            <button
              key={f}
              onClick={() => setDirectionFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${directionFilter === f
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-surface border border-border text-muted hover:text-foreground'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {statusFilters.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === f
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-surface border border-border text-muted hover:text-foreground'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Filters — Mobile (full-width search + horizontally scrollable chips) */}
      <div className="md:hidden space-y-3 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder="Search by name or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5">
          {directionFilters.map((f) => (
            <button
              key={f}
              onClick={() => setDirectionFilter(f)}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${directionFilter === f
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-surface border border-border text-muted'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5">
          {statusFilters.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${statusFilter === f
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-surface border border-border text-muted'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Call Logs Table */}
      {/* Mobile-friendly card list (visible on small screens) */}
      <div className="space-y-3 md:hidden">
        {filteredLogs.map((call) => (
          <div key={call.id} className="glass-card p-4" onClick={() => setSelectedCall(call)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {getDirectionIcon(call.direction)}
                  <p className="text-sm font-semibold text-foreground truncate">{call.customer}</p>
                </div>
                <p className="text-xs text-muted truncate mt-0.5">{call.phone}</p>
              </div>
              {getStatusBadge(call.status)}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{call.date}</span>
              <span>•</span>
              <span>{call.time}</span>
              <span>•</span>
              <span>{call.duration}</span>
            </div>
            <p className="text-xs text-muted mt-2 line-clamp-2">{call.purpose}</p>
            <div className="mt-3 flex items-center justify-between">
              {getOutcomeBadge(call.outcome)}
              <div className="flex items-center gap-2">
                {call.recording && (
                  <button
                    className="touch-target flex items-center justify-center rounded-xl bg-surface-hover text-muted hover:text-accent transition-colors"
                    title="Play recording"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Play className="w-4 h-4" />
                  </button>
                )}
                <button
                  className="touch-target flex items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 transition-colors"
                  title="Call back"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Phone className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Customer</th>
                <th>Phone</th>
                <th>Date & Time</th>
                <th>Duration</th>
                <th>Purpose</th>
                <th>Status</th>
                <th>Outcome</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((call) => (
                <tr key={call.id} className="cursor-pointer" onClick={() => setSelectedCall(call)}>
                  <td>
                    <div className="flex items-center gap-2">
                      {getDirectionIcon(call.direction)}
                      <span className="text-xs text-muted">{call.direction}</span>
                    </div>
                  </td>
                  <td className="font-medium text-foreground">{call.customer}</td>
                  <td className="text-muted">{call.phone}</td>
                  <td>
                    <div className="text-sm">{call.date}</div>
                    <div className="text-xs text-muted">{call.time}</div>
                  </td>
                  <td className={call.durationSec === 0 ? 'text-muted' : 'text-foreground'}>{call.duration}</td>
                  <td className="text-sm max-w-[200px] truncate">{call.purpose}</td>
                  <td>{getStatusBadge(call.status)}</td>
                  <td>{getOutcomeBadge(call.outcome)}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      {call.recording && (
                        <button
                          className="p-1.5 rounded-lg bg-surface-hover text-muted hover:text-accent transition-colors"
                          title="Play recording"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        className="p-1.5 rounded-lg bg-surface-hover text-muted hover:text-emerald-700 transition-colors"
                        title="Call back"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Phone className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  // ─── PHONE BOOK TAB ───
  const renderPhoneBook = () => (
    <div>
      {/* Filters — Desktop (md+) */}
      <div className="hidden md:flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {tagFilters.map((f) => (
            <button
              key={f}
              onClick={() => setTagFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${tagFilter === f
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-surface border border-border text-muted hover:text-foreground'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowAddContactModal(true)}
          className="ml-auto flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Contact
        </button>
      </div>

      {/* Filters — Mobile (full-width search + scrollable chips + add button) */}
      <div className="md:hidden space-y-3 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5">
          {tagFilters.map((f) => (
            <button
              key={f}
              onClick={() => setTagFilter(f)}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${tagFilter === f
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-surface border border-border text-muted'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowAddContactModal(true)}
          className="touch-target w-full flex items-center justify-center gap-2 px-4 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Contact
        </button>
      </div>

      {/* Phone Book Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredPhoneBook.map((contact) => (
          <div
            key={contact.phone || contact.name}
            className="glass-card p-4 cursor-pointer hover:border-accent/30 transition-all"
            onClick={() => setSelectedContact(contact)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-accent" />
                </div>
                <div>
                  <h3 className="font-medium text-foreground">{contact.name}</h3>
                  <p className="text-xs text-muted">{contact.phone}</p>
                </div>
              </div>
              {getTagBadge(contact.tag)}
            </div>
            {contact.email && (
              <div className="flex items-center gap-2 text-xs text-muted mb-2">
                <Mail className="w-3.5 h-3.5" />
                {contact.email}
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-muted pt-2 border-t border-border">
              <span>{contact.totalCalls} calls</span>
              <span>Last: {contact.lastCall}</span>
            </div>
            <p className="text-xs text-muted mt-2 truncate">{contact.notes}</p>
          </div>
        ))}
      </div>
    </div>
  );

  // ─── TRANSCRIPTS TAB ───
  const renderTranscripts = () => (
    <div>
      <div className="relative w-full md:max-w-md mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input
          type="text"
          placeholder="Search transcripts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 md:py-2 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
        />
      </div>

      <div className="space-y-3">
        {filteredTranscripts.length === 0 && (
          <div className="glass-card p-8 text-center">
            <MessageSquare className="mx-auto h-8 w-8 text-muted" />
            <p className="mt-3 font-medium text-foreground">No transcripts saved yet</p>
            <p className="mt-1 text-sm text-muted">Active AI calls appear here as the conversation progresses.</p>
          </div>
        )}
        {filteredTranscripts.map((transcript) => (
          <div key={transcript.id} className="glass-card overflow-hidden">
            {/* Header */}
            <div
              className="p-4 cursor-pointer hover:bg-surface-hover transition-colors"
              onClick={() =>
                setExpandedTranscript(expandedTranscript === transcript.id ? null : transcript.id)
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-y-2">
                <div className="flex items-center gap-2 min-w-0">
                  {expandedTranscript === transcript.id ? (
                    <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
                  )}
                  <div className="flex items-center gap-2 min-w-0">
                    {getDirectionIcon(transcript.direction)}
                    <span className="font-medium text-foreground truncate">{transcript.customer}</span>
                  </div>
                  <span className="text-xs text-muted truncate">{transcript.phone}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 md:pl-0">
                  {getSentimentBadge(transcript.sentiment)}
                  <span className="text-xs text-muted">
                    {transcript.date} at {transcript.time}
                  </span>
                  <span className="text-xs text-muted flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {transcript.duration}
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted mt-2 ml-7">{transcript.summary}</p>
            </div>

            {/* Expanded Chat */}
            {expandedTranscript === transcript.id && (
              <div className="border-t border-border p-4 bg-surface-hover">
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                  {transcript.messages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex ${msg.from === 'agent' ? 'justify-start' : 'justify-end'}`}
                    >
                      <div
                        className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${msg.from === 'agent'
                          ? 'bg-accent/10 border border-accent/20 text-foreground'
                          : 'bg-surface border border-border text-foreground'
                          }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                            {msg.from === 'agent' ? 'AI Agent' : 'Customer'}
                          </span>
                          <span className="text-[10px] text-muted">{msg.time}</span>
                        </div>
                        <p className="text-sm leading-relaxed">{msg.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  // ─── BOOK APPOINTMENT TAB ───
  const renderBookAppointment = () => {
    const recentCalls = callLogs.filter((c) => c.status === 'Completed').slice(0, 5);

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Booking Form */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <CalendarPlus className="w-5 h-5 text-accent" />
            Quick Book from Call
          </h3>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-muted mb-1 block">Customer Name</label>
              <input
                type="text"
                placeholder="Enter customer name"
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Phone Number</label>
              <input
                type="text"
                placeholder="+91 XXXXX XXXXX"
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-muted mb-1 block">Date</label>
                <input
                  type="date"
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                />
              </div>
              <div>
                <label className="text-sm text-muted mb-1 block">Time</label>
                <input
                  type="time"
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Purpose</label>
              <select className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
                <option value="">Select purpose...</option>
                <option>Showroom Visit</option>
                <option>Product Demo</option>
                <option>Measurement Visit</option>
                <option>Design Consultation</option>
                <option>Delivery Coordination</option>
                <option>Complaint Resolution</option>
                <option>Follow-up Meeting</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Notes from Call</label>
              <textarea
                rows={3}
                placeholder="Key points from the call..."
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 resize-none"
              />
            </div>
            <button className="w-full py-2.5 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors">
              Book Appointment
            </button>
          </div>
        </div>

        {/* Recent Calls to Book */}
        <div>
          <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <Phone className="w-5 h-5 text-accent" />
            Recent Calls — Quick Book
          </h3>
          <div className="space-y-3">
            {recentCalls.map((call) => (
              <div key={call.id} className="glass-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    {getDirectionIcon(call.direction)}
                    <div>
                      <h4 className="font-medium text-foreground text-sm">{call.customer}</h4>
                      <p className="text-xs text-muted">{call.phone}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted">{call.date}</p>
                    <p className="text-xs text-muted">{call.time}</p>
                  </div>
                </div>
                <p className="text-xs text-muted mb-3">{call.notes}</p>
                <div className="flex items-center justify-between">
                  {getOutcomeBadge(call.outcome)}
                  <button
                    onClick={() => setShowBookModal(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent rounded-lg text-xs font-medium hover:bg-accent/20 transition-colors border border-accent/20"
                  >
                    <CalendarPlus className="w-3.5 h-3.5" />
                    Book
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ─── ANALYTICS TAB ───
  const renderAnalytics = () => {
    const outcomeCount = {};
    callLogs.forEach((c) => {
      outcomeCount[c.outcome] = (outcomeCount[c.outcome] || 0) + 1;
    });

    const purposeCount = {};
    callLogs.filter((c) => c.status === 'Completed').forEach((c) => {
      purposeCount[c.purpose] = (purposeCount[c.purpose] || 0) + 1;
    });

    const dailyCalls = {};
    callLogs.forEach((c) => {
      dailyCalls[c.date] = (dailyCalls[c.date] || 0) + 1;
    });

    return (
      <div>
        {/* Overview Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard icon={Phone} label="Total Calls" value={callStats.totalCalls} trend="Last 7 days" positive />
          <StatCard icon={CheckCircle2} label="Completed" value={callStats.completed} trend={`${Math.round((callStats.completed / callStats.totalCalls) * 100)}% success`} positive />
          <StatCard icon={CalendarPlus} label="Appointments Booked" value={callStats.appointmentsBooked} trend="From calls" positive />
          <StatCard icon={FileText} label="Quotations Sent" value={callStats.quotationsSent} trend="From calls" positive />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Call Outcomes */}
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground mb-4">Call Outcomes</h3>
            <div className="space-y-3">
              {Object.entries(outcomeCount)
                .sort((a, b) => b[1] - a[1])
                .map(([outcome, count]) => (
                  <div key={outcome} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getOutcomeBadge(outcome)}
                    </div>
                    <div className="flex items-center gap-3 flex-1 ml-4">
                      <div className="flex-1 h-2 bg-surface rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent/40 rounded-full"
                          style={{ width: `${(count / callStats.totalCalls) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-foreground w-6 text-right">
                        {count}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Daily Call Volume */}
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground mb-4">Daily Call Volume</h3>
            <div className="space-y-3">
              {Object.entries(dailyCalls)
                .sort((a, b) => b[0].localeCompare(a[0]))
                .map(([date, count]) => (
                  <div key={date} className="flex items-center justify-between">
                    <span className="text-sm text-muted w-28">{date}</span>
                    <div className="flex items-center gap-3 flex-1 ml-4">
                      <div className="flex-1 h-2 bg-surface rounded-full overflow-hidden">
                        <div
                          className="h-full bg-teal-500/40 rounded-full"
                          style={{ width: `${(count / Math.max(...Object.values(dailyCalls))) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-foreground w-6 text-right">
                        {count}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Inbound vs Outbound */}
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground mb-4">Direction Split</h3>
            <div className="flex items-center gap-6">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted flex items-center gap-2">
                    <ArrowDownLeft className="w-4 h-4 text-teal-700" /> Inbound
                  </span>
                  <span className="text-lg font-bold text-foreground">{callStats.inbound}</span>
                </div>
                <div className="h-3 bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full bg-teal-500/50 rounded-full"
                    style={{
                      width: `${(callStats.inbound / callStats.totalCalls) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted flex items-center gap-2">
                    <ArrowUpRight className="w-4 h-4 text-amber-700" /> Outbound
                  </span>
                  <span className="text-lg font-bold text-foreground">{callStats.outbound}</span>
                </div>
                <div className="h-3 bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-500/50 rounded-full"
                    style={{
                      width: `${(callStats.outbound / callStats.totalCalls) * 100}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Status Breakdown */}
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground mb-4">Call Status Breakdown</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface rounded-xl p-4 text-center">
                <CheckCircle2 className="w-6 h-6 text-emerald-700 mx-auto mb-2" />
                <p className="text-2xl font-bold text-foreground">{callStats.completed}</p>
                <p className="text-xs text-muted">Completed</p>
              </div>
              <div className="bg-surface rounded-xl p-4 text-center">
                <PhoneMissed className="w-6 h-6 text-red-700 mx-auto mb-2" />
                <p className="text-2xl font-bold text-foreground">{callStats.missed}</p>
                <p className="text-xs text-muted">Missed</p>
              </div>
              <div className="bg-surface rounded-xl p-4 text-center">
                <PhoneOff className="w-6 h-6 text-orange-700 mx-auto mb-2" />
                <p className="text-2xl font-bold text-foreground">{callStats.noAnswer}</p>
                <p className="text-xs text-muted">No Answer</p>
              </div>
              <div className="bg-surface rounded-xl p-4 text-center">
                <AlertCircle className="w-6 h-6 text-yellow-700 mx-auto mb-2" />
                <p className="text-2xl font-bold text-foreground">{callStats.busy}</p>
                <p className="text-xs text-muted">Busy</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ─── AI CALLER TAB ───
  const handleOutboundCall = async () => {
    if (!outboundPhone.trim() || callingState !== 'idle') return;
    if (!agentStatus?.workerOnline) {
      setCallMessage('AI worker is offline. Start the worker before placing an outbound call.');
      return;
    }
    const reason = outboundReason === 'Custom reason' ? customReason.trim() : outboundReason;
    if (outboundReason === 'Custom reason' && !reason) {
      setCallMessage('Please enter the custom call reason.');
      return;
    }
    setCallingState('calling');
    setCallMessage('');
    try {
      const res = await initiateAICall(outboundPhone, reason, outboundName);
      if (res.success) {
        setCallingState('connected');
        setActiveCallLogId(res.data.callLogId);
        setCallMessage('Call queued. Waiting for the AI worker to dial the customer.');
      } else {
        setCallingState('idle');
        setCallMessage(res.error || 'Failed to initiate call');
      }
    } catch (err) {
      setCallingState('idle');
      setCallMessage(err.message || 'Failed to initiate call');
    }
  };

  const handleBrowserCall = async () => {
    if (browserCallState === 'connected') {
      await disconnectBrowserRoom();
      setBrowserCallState('idle');
      return;
    }

    setBrowserCallState('connecting');
    try {
      const resp = await fetch('/api/calls/token');
      const data = await resp.json();
      if (data.error) {
        setBrowserCallState('idle');
        setCallMessage(data.error);
        return;
      }

      // Dynamically load LiveKit client
      if (!window.LivekitClient) {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js';
        document.head.appendChild(script);
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
        });
      }

      const room = new window.LivekitClient.Room();
      browserRoomRef.current = room;

      room.on(window.LivekitClient.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === 'audio') {
          const el = track.attach();
          el.dataset.livekitBrowserAudio = 'true';
          document.body.appendChild(el);
        }
      });

      room.on(window.LivekitClient.RoomEvent.Disconnected, () => {
        if (browserRoomRef.current === room) browserRoomRef.current = null;
        setBrowserCallState('idle');
        removeBrowserCallAudio();
        // Refresh logs
        getCallLogs().then(r => { if (r.success) setCallLogs(r.data); });
      });

      await room.connect(data.url, data.token);
      if (browserRoomRef.current !== room) return;
      await room.localParticipant.setMicrophoneEnabled(true);
      if (browserRoomRef.current !== room) {
        await room.localParticipant.setMicrophoneEnabled(false);
        return;
      }
      setBrowserCallState('connected');
    } catch (err) {
      await disconnectBrowserRoom();
      setBrowserCallState('idle');
      setCallMessage('Failed to connect: ' + err.message);
    }
  };

  const renderAICaller = () => {
    const aiCalls = callLogs.filter(c => c.aiHandled);
    const recentAICalls = aiCalls.slice(0, 5);

    return (
      <div>
        {/* Agent Status & Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={Bot}
            label="AI Agent"
            value={agentStatus?.workerOnline ? 'Online' : agentStatus?.configured ? 'Worker Offline' : 'Not Configured'}
            trend={agentStatus?.workerOnline ? 'Ready to accept calls' : agentStatus?.configured ? 'Start or restore the AI worker' : 'Setup required'}
            positive={agentStatus?.workerOnline}
          />
          <StatCard icon={PhoneOutgoing} label="AI Outbound" value={aiCalls.filter(c => c.direction === 'Outbound').length} trend="Total AI calls" positive />
          <StatCard icon={PhoneIncoming} label="AI Inbound" value={aiCalls.filter(c => c.direction === 'Inbound').length} trend="Total AI calls" positive />
          <StatCard icon={Clock} label="AI Calls Today" value={aiCalls.filter(c => {
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            return c.date === todayStr;
          }).length} trend="Today" positive />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Make Outbound Call */}
          <div className="glass-card p-6">
            <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
              <PhoneOutgoing className="w-5 h-5 text-accent" />
              AI Outbound Call
            </h3>
            <p className="text-xs text-muted mb-4">
              Anushka (AI Agent) will call the customer and handle the conversation automatically.
            </p>
            <div className="space-y-3">
              <div>
                <label htmlFor="ai-outbound-phone" className="text-sm text-muted mb-1 block">Phone Number *</label>
                <input
                  id="ai-outbound-phone"
                  name="phoneNumber"
                  type="text"
                  placeholder="+91XXXXX XXXXX"
                  value={outboundPhone}
                  onChange={(e) => setOutboundPhone(e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
                />
              </div>
              <div>
                <label htmlFor="ai-outbound-customer-name" className="text-sm text-muted mb-1 block">Customer Name</label>
                <input
                  id="ai-outbound-customer-name"
                  name="customerName"
                  type="text"
                  placeholder="Enter name (optional)"
                  value={outboundName}
                  onChange={(e) => setOutboundName(e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
                />
              </div>
              <div>
                <label htmlFor="ai-outbound-reason" className="text-sm text-muted mb-1 block">Call Reason</label>
                <select
                  id="ai-outbound-reason"
                  name="callReason"
                  value={outboundReason}
                  onChange={(e) => setOutboundReason(e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                >
                  <option value="">Select reason...</option>
                  <option value="Follow up on inquiry">Follow up on inquiry</option>
                  <option value="Appointment reminder">Appointment reminder</option>
                  <option value="Delivery update">Delivery update</option>
                  <option value="Quotation follow-up">Quotation follow-up</option>
                  <option value="Feedback collection">Feedback collection</option>
                  <option value="New collection announcement">New collection announcement</option>
                  <option value="Payment reminder">Payment reminder</option>
                  <option value="Order status update">Order status update</option>
                  <option value="Custom reason">Custom reason</option>
                </select>
              </div>
              {outboundReason === 'Custom reason' && (
                <div>
                  <label htmlFor="ai-outbound-custom-reason" className="text-sm text-muted mb-1 block">Custom Call Reason</label>
                  <textarea
                    id="ai-outbound-custom-reason"
                    name="customCallReason"
                    placeholder="Enter custom reason..."
                    value={customReason}
                    maxLength={2000}
                    onChange={(e) => setCustomReason(e.target.value)}
                    className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
                  />
                </div>
              )}

              {callMessage && (
                <div className={`text-sm p-3 rounded-xl ${callingState === 'connected' ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/20' : 'bg-red-500/10 text-red-700 border border-red-500/20'}`}>
                  {callMessage}
                </div>
              )}

              <button
                onClick={handleOutboundCall}
                disabled={!outboundPhone.trim() || callingState !== 'idle' || !agentStatus?.workerOnline}
                className="w-full flex items-center justify-center gap-2 min-h-[48px] py-2.5 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {callingState === 'calling' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Initiating Call...</>
                ) : callingState === 'connected' ? (
                  <><PhoneCall className="w-4 h-4" /> Call Queued</>
                ) : callingState === 'ended' ? (
                  <><CheckCircle2 className="w-4 h-4" /> Call Finished</>
                ) : (
                  <><PhoneOutgoing className="w-4 h-4" /> Start AI Call</>
                )}
              </button>

              {(callingState === 'connected' || callingState === 'ended') && (
                <button
                  onClick={() => { setCallingState('idle'); setActiveCallLogId(null); setCallMessage(''); }}
                  className="w-full py-2 text-sm text-muted hover:text-foreground transition-colors"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          {/* Browser Voice Call */}
          <div className="glass-card p-6">
            <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
              <Mic className="w-5 h-5 text-teal-600" />
              Browser Voice Call
            </h3>
            <p className="text-xs text-muted mb-4">
              Talk to the AI agent directly from your browser. Useful for testing or when you want to speak as a customer.
            </p>

            <div className="flex flex-col items-center py-6">
              {/* Call visualization */}
              <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-4 transition-all ${browserCallState === 'connected'
                ? 'bg-emerald-500/20 border-2 border-emerald-500/40 animate-pulse'
                : browserCallState === 'connecting'
                  ? 'bg-amber-500/20 border-2 border-amber-500/40 animate-pulse'
                  : 'bg-surface border-2 border-border'
                }`}>
                {browserCallState === 'connected' ? (
                  <Volume2 className="w-10 h-10 text-emerald-600" />
                ) : browserCallState === 'connecting' ? (
                  <Loader2 className="w-10 h-10 text-amber-600 animate-spin" />
                ) : (
                  <Mic className="w-10 h-10 text-muted" />
                )}
              </div>

              <p className="text-sm font-medium text-foreground mb-1">
                {browserCallState === 'connected'
                  ? 'Connected — Speak now'
                  : browserCallState === 'connecting'
                    ? 'Connecting to AI Agent...'
                    : 'Ready to call'}
              </p>
              <p className="text-xs text-muted mb-6">
                {browserCallState === 'connected'
                  ? 'AI Agent Anushka is listening'
                  : 'Click below to start a voice conversation'}
              </p>

              <button
                onClick={handleBrowserCall}
                className={`flex items-center justify-center gap-2 w-full sm:w-auto min-h-[56px] px-8 py-3 rounded-2xl text-sm font-semibold transition-all ${browserCallState === 'connected'
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : browserCallState === 'connecting'
                    ? 'bg-amber-500/20 text-amber-700 cursor-wait'
                    : 'bg-teal-600 text-white hover:bg-teal-700'
                  }`}
                disabled={browserCallState === 'connecting'}
              >
                {browserCallState === 'connected' ? (
                  <><PhoneOff className="w-4 h-4" /> End Call</>
                ) : browserCallState === 'connecting' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Connecting...</>
                ) : (
                  <><Phone className="w-4 h-4" /> Start Browser Call</>
                )}
              </button>
            </div>

            {/* Agent configuration status */}
            {agentStatus && (
              <div className="border-t border-border pt-4 mt-2">
                <p className="text-xs text-muted mb-2 uppercase tracking-wider">Service Status</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'AI Worker Online', ok: agentStatus.workerOnline },
                    { label: 'LiveKit', ok: agentStatus.hasLiveKit },
                    { label: 'Deepgram STT', ok: agentStatus.hasDeepgram },
                    { label: 'Sarvam TTS', ok: agentStatus.hasSarvam },
                    { label: 'Groq LLM', ok: agentStatus.hasGroq },
                    { label: 'Vobiz SIP', ok: agentStatus.hasVobiz },
                    { label: 'SIP Trunk', ok: agentStatus.hasSipTrunk },
                  ].map(({ label, ok }) => (
                    <div key={label} className="flex items-center gap-2 text-xs">
                      <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                      <span className={ok ? 'text-foreground' : 'text-muted'}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Recent AI Calls */}
        {recentAICalls.length > 0 && (
          <div className="mt-6">
            <h3 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
              <Bot className="w-4 h-4 text-accent" />
              Recent AI Calls
            </h3>
            <div className="glass-card overflow-hidden hidden md:block">
              <div className="overflow-x-auto">
                <table className="crm-table">
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Date & Time</th>
                      <th>Duration</th>
                      <th>Purpose</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentAICalls.map((call) => (
                      <tr key={call.id} className="cursor-pointer" onClick={() => setSelectedCall(call)}>
                        <td>
                          <div className="flex items-center gap-2">
                            {getDirectionIcon(call.direction)}
                            <span className="text-xs text-muted">{call.direction}</span>
                          </div>
                        </td>
                        <td className="font-medium text-foreground">
                          <div className="flex items-center gap-1.5">
                            <Bot className="w-3 h-3 text-accent" />
                            {call.customer}
                          </div>
                        </td>
                        <td className="text-muted">{call.phone}</td>
                        <td>
                          <div className="text-sm">{call.date}</div>
                          <div className="text-xs text-muted">{call.time}</div>
                        </td>
                        <td>{call.duration}</td>
                        <td className="text-sm max-w-[200px] truncate">{call.purpose}</td>
                        <td>{getOutcomeBadge(call.outcome)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent AI Calls — Mobile cards */}
            <div className="md:hidden space-y-3">
              {recentAICalls.map((call) => (
                <div key={call.id} className="glass-card p-4" onClick={() => setSelectedCall(call)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {getDirectionIcon(call.direction)}
                        <Bot className="w-3.5 h-3.5 text-accent flex-shrink-0" />
                        <p className="text-sm font-semibold text-foreground truncate">{call.customer}</p>
                      </div>
                      <p className="text-xs text-muted truncate mt-0.5">{call.phone}</p>
                    </div>
                    {getOutcomeBadge(call.outcome)}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>{call.date}</span>
                    <span>•</span>
                    <span>{call.time}</span>
                    <span>•</span>
                    <span>{call.duration}</span>
                  </div>
                  {call.purpose && (
                    <p className="text-xs text-muted mt-2 line-clamp-2">{call.purpose}</p>
                  )}
                </div>
              ))}
            </div>
          </div >
        )
        }

        {/* Quick Call from Phone Book */}
        {
          phoneBook.length > 0 && (
            <div className="mt-6">
              <h3 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
                <PhoneCall className="w-4 h-4 text-accent" />
                Quick AI Call — Recent Contacts
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {phoneBook.slice(0, 6).map((contact) => (
                  <div key={contact.phone} className="glass-card p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
                        <User className="w-4 h-4 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{contact.name}</p>
                        <p className="text-xs text-muted">{contact.phone}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setOutboundPhone(contact.phone);
                        setOutboundName(contact.name);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent rounded-lg text-xs font-medium hover:bg-accent/20 transition-colors border border-accent/20"
                    >
                      <Bot className="w-3 h-3" />
                      AI Call
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        }
      </div >
    );
  };

  return (
    <div className={`space-y-6 animate-[fade-in_0.3s_ease] ${(browserCallState !== 'idle' || callingState === 'calling' || callingState === 'connected') ? 'pb-28 md:pb-0' : ''}`}>
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Call Center</h1>
          <p className="text-sm text-muted mt-1">
            Manage inbound & outbound calls, transcripts, and appointments
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <button
            onClick={refreshLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-xl text-xs text-muted hover:text-foreground transition-colors"
            title="Refresh call data"
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Refresh
          </button>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl ${agentStatus?.configured
            ? 'bg-emerald-500/10 border border-emerald-500/20'
            : 'bg-zinc-500/10 border border-zinc-500/20'
            }`}>
            <div className={`w-2 h-2 rounded-full ${agentStatus?.configured ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-400'}`} />
            <span className={`text-xs font-medium ${agentStatus?.configured ? 'text-emerald-700' : 'text-muted'}`}>
              {agentStatus?.configured ? 'AI Agent Online' : 'AI Agent Offline'}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-surface rounded-xl border border-border p-1 w-full overflow-x-auto">
        <div className="flex items-center gap-1 min-w-max">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  setSearchQuery('');
                }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id
                  ? 'bg-accent/20 text-accent shadow-sm'
                  : 'text-muted hover:text-foreground hover:bg-surface-hover'
                  }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'ai-caller' && renderAICaller()}
      {activeTab === 'logs' && renderCallLogs()}
      {activeTab === 'phonebook' && renderPhoneBook()}
      {activeTab === 'transcripts' && renderTranscripts()}
      {activeTab === 'book' && renderBookAppointment()}
      {activeTab === 'analytics' && renderAnalytics()}

      {/* ─── MOBILE STICKY ACTIVE-CALL BAR (sits above the 60px bottom nav) ─── */}
      {(browserCallState !== 'idle' || callingState === 'calling' || callingState === 'connected') && (
        <div
          className="md:hidden fixed left-0 right-0 z-40 px-3"
          style={{ bottom: 'calc(60px + env(safe-area-inset-bottom) + 8px)' }}
        >
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 shadow-xl">
            <div
              className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${browserCallState === 'connected'
                ? 'bg-emerald-500/20 text-emerald-700 animate-pulse'
                : browserCallState === 'connecting' || callingState === 'calling'
                  ? 'bg-amber-500/20 text-amber-700 animate-pulse'
                  : 'bg-accent/15 text-accent'
                }`}
            >
              {browserCallState === 'connecting' || callingState === 'calling' ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : browserCallState === 'connected' ? (
                <Volume2 className="w-5 h-5" />
              ) : (
                <PhoneCall className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">
                {browserCallState === 'connected'
                  ? 'Browser call connected'
                  : browserCallState === 'connecting'
                    ? 'Connecting browser call...'
                    : callingState === 'calling'
                      ? 'Initiating AI call...'
                      : 'AI call in progress'}
              </p>
              <p className="text-xs text-muted truncate">
                {browserCallState === 'connected'
                  ? 'AI Agent Anushka is listening'
                  : callingState === 'connected'
                    ? (outboundName || outboundPhone || 'Outbound call')
                    : 'Please wait'}
              </p>
            </div>
            {browserCallState === 'connected' ? (
              <button
                onClick={handleBrowserCall}
                className="touch-target flex items-center gap-1.5 px-4 rounded-xl bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors flex-shrink-0"
              >
                <PhoneOff className="w-4 h-4" />
                End
              </button>
            ) : callingState === 'connected' ? (
              <button
                onClick={() => { setCallingState('idle'); setCallMessage(''); }}
                className="touch-target flex items-center justify-center px-4 rounded-xl bg-surface-hover text-muted text-sm font-medium flex-shrink-0"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* ─── CALL DETAIL MODAL ─── */}
      <Modal isOpen={!!selectedCall} onClose={() => setSelectedCall(null)} title="Call Details" size="lg">
        {selectedCall && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
                {selectedCall.direction === 'Inbound' ? (
                  <PhoneIncoming className="w-6 h-6 text-teal-700" />
                ) : (
                  <PhoneOutgoing className="w-6 h-6 text-amber-700" />
                )}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">{selectedCall.customer}</h3>
                <p className="text-sm text-muted">{selectedCall.phone}</p>
              </div>
              <div className="ml-auto text-right">
                {getStatusBadge(selectedCall.status)}
                <p className="text-xs text-muted mt-1">{selectedCall.date} at {selectedCall.time}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Direction</p>
                <div className="flex items-center gap-2">
                  {getDirectionIcon(selectedCall.direction)}
                  <span className="text-sm font-medium text-foreground">{selectedCall.direction}</span>
                </div>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Duration</p>
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted" />
                  {selectedCall.duration}
                </p>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Agent</p>
                <p className="text-sm font-medium text-foreground">{selectedCall.agent}</p>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Outcome</p>
                {getOutcomeBadge(selectedCall.outcome)}
              </div>
            </div>

            <div className="bg-surface rounded-xl p-3">
              <p className="text-xs text-muted mb-1">Purpose</p>
              <p className="text-sm text-foreground">{selectedCall.purpose}</p>
            </div>

            <div className="bg-surface rounded-xl p-3">
              <p className="text-xs text-muted mb-1">Notes</p>
              <p className="text-sm text-foreground">{selectedCall.notes}</p>
            </div>

            {/* Transcript */}
            {selectedCall.transcript && (
              <div className="border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-surface flex items-center justify-between border-b border-border">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-accent" />
                    <span className="text-sm font-semibold text-foreground">Call Transcript</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {getSentimentBadge(selectedCall.transcript.sentiment)}
                  </div>
                </div>
                {selectedCall.transcript.summary && (
                  <div className="px-4 py-2 bg-accent/5 border-b border-border">
                    <p className="text-xs text-muted">Summary</p>
                    <p className="text-sm text-foreground mt-0.5">{selectedCall.transcript.summary}</p>
                  </div>
                )}
                <div className="p-4 space-y-3 max-h-[300px] overflow-y-auto">
                  {(selectedCall.transcript.messages || []).map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.from === 'agent' ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[75%] rounded-2xl px-3 py-2 ${msg.from === 'agent'
                        ? 'bg-accent/10 border border-accent/20'
                        : 'bg-surface border border-border'
                        }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                            {msg.from === 'agent' ? 'Anushka (AI)' : 'Customer'}
                          </span>
                          <span className="text-[10px] text-muted">{msg.time}</span>
                        </div>
                        <p className="text-sm leading-relaxed text-foreground">{msg.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              {selectedCall.recording && (
                <button className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent/10 text-accent border border-accent/20 rounded-xl text-sm font-medium hover:bg-accent/20 transition-colors">
                  <Play className="w-4 h-4" />
                  Play Recording
                </button>
              )}
              <button className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors">
                <Phone className="w-4 h-4" />
                Call Again
              </button>
              <button
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-teal-500/10 text-teal-700 border border-teal-500/20 rounded-xl text-sm font-medium hover:bg-teal-500/20 transition-colors"
                onClick={() => {
                  setSelectedCall(null);
                  setActiveTab('book');
                }}
              >
                <CalendarPlus className="w-4 h-4" />
                Book Appointment
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ─── CONTACT DETAIL MODAL ─── */}
      <Modal isOpen={!!selectedContact} onClose={() => setSelectedContact(null)} title="Contact Details" size="md">
        {selectedContact && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
                <User className="w-7 h-7 text-accent" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">{selectedContact.name}</h3>
                <p className="text-sm text-muted">{selectedContact.phone}</p>
                {selectedContact.email && (
                  <p className="text-xs text-muted">{selectedContact.email}</p>
                )}
              </div>
              <div className="ml-auto">{getTagBadge(selectedContact.tag)}</div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Total Calls</p>
                <p className="text-lg font-bold text-foreground">{selectedContact.totalCalls}</p>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Last Call</p>
                <p className="text-sm font-medium text-foreground">{selectedContact.lastCall}</p>
              </div>
            </div>

            <div className="bg-surface rounded-xl p-3">
              <p className="text-xs text-muted mb-1">Notes</p>
              <p className="text-sm text-foreground">{selectedContact.notes}</p>
            </div>

            {/* Call history for this contact */}
            <div>
              <p className="text-xs text-muted mb-2 uppercase tracking-wider">Recent Call History</p>
              <div className="space-y-2">
                {callLogs
                  .filter((c) => c.phone === selectedContact.phone)
                  .slice(0, 5)
                  .map((call) => (
                    <div key={call.id} className="flex items-center justify-between bg-surface rounded-lg p-2.5">
                      <div className="flex items-center gap-2">
                        {getDirectionIcon(call.direction)}
                        <span className="text-xs text-foreground">{call.purpose}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {getStatusBadge(call.status)}
                        <span className="text-xs text-muted">{call.date}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 rounded-xl text-sm font-medium hover:bg-emerald-500/20 transition-colors">
                <Phone className="w-4 h-4" />
                Call Now
              </button>
              <button className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent/10 text-accent border border-accent/20 rounded-xl text-sm font-medium hover:bg-accent/20 transition-colors">
                <MessageSquare className="w-4 h-4" />
                Send Message
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ─── ADD CONTACT MODAL ─── */}
      <Modal isOpen={showAddContactModal} onClose={() => setShowAddContactModal(false)} title="Add New Contact" size="md">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-muted mb-1 block">Full Name</label>
            <input
              type="text"
              placeholder="Enter full name"
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Phone Number</label>
            <input
              type="text"
              placeholder="+91 XXXXX XXXXX"
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Email</label>
            <input
              type="email"
              placeholder="email@example.com"
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Tag</label>
            <select className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
              <option>Hot Lead</option>
              <option>Warm Lead</option>
              <option>Cold Lead</option>
              <option>Customer</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Notes</label>
            <textarea
              rows={2}
              placeholder="Add notes..."
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 resize-none"
            />
          </div>
          <button
            onClick={() => setShowAddContactModal(false)}
            className="w-full py-2.5 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors"
          >
            Add Contact
          </button>
        </div>
      </Modal>

      {/* ─── QUICK BOOK MODAL ─── */}
      <Modal isOpen={showBookModal} onClose={() => setShowBookModal(false)} title="Book Appointment" size="md">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-muted mb-1 block">Customer Name</label>
            <input
              type="text"
              placeholder="Enter customer name"
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Phone</label>
            <input
              type="text"
              placeholder="+91 XXXXX XXXXX"
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted mb-1 block">Date</label>
              <input
                type="date"
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Time</label>
              <input
                type="time"
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
              />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Purpose</label>
            <select className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50">
              <option value="">Select purpose...</option>
              <option>Showroom Visit</option>
              <option>Product Demo</option>
              <option>Measurement Visit</option>
              <option>Design Consultation</option>
              <option>Delivery Coordination</option>
              <option>Follow-up Meeting</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Notes</label>
            <textarea
              rows={2}
              placeholder="Notes..."
              className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 resize-none"
            />
          </div>
          <button
            onClick={() => setShowBookModal(false)}
            className="w-full py-2.5 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors"
          >
            Confirm Booking
          </button>
        </div>
      </Modal>
    </div>
  );
}
