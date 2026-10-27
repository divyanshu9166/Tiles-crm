'use client';

import { useState, useEffect } from 'react';
import { Search, Plus, MessageSquare, Instagram, Facebook, Globe, Phone, Mail, ChevronRight, Bot, Clock, Trash2, Store, Building2, FileText } from 'lucide-react';
import { getLeads, createLead, updateLeadStatus, addFollowUp } from '@/app/actions/leads';
import { moveLeadToDraft } from '@/app/actions/drafts';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getActiveVertical } from '@/lib/brand';

const IS_TGM = getActiveVertical() === 'tiles';
const TGM_MATERIAL_OPTIONS = ['Tiles', 'Granite', 'Marble', 'Quartzite', 'Engineered Quartz', 'Adhesive / Grout', 'Other'];
const TGM_APPLICATION_OPTIONS = ['Kitchen', 'Floor', 'Wall', 'Bathroom', 'Staircase', 'Outdoor', 'Commercial', 'Other'];

const pipelineStages = ['New', 'Contacted', 'Showroom Visit', 'Quotation', 'Won', 'Lost'];

const stageToEnum = {
  'New': 'NEW', 'Contacted': 'CONTACTED', 'Showroom Visit': 'SHOWROOM_VISIT',
  'Quotation': 'QUOTATION', 'Won': 'WON', 'Lost': 'LOST',
};

const sourceIconMap = { WhatsApp: MessageSquare, 'WhatsApp Inquiry': MessageSquare, Instagram, Facebook, Website: Globe, 'Showroom Visit': Store, IndiaMART: Building2 };

const sourceColorMap = {
  WhatsApp: 'text-success bg-success-light',
  'WhatsApp Inquiry': 'text-emerald-700 bg-emerald-500/10',
  Instagram: 'text-pink bg-pink-light',
  Facebook: 'text-info bg-info-light',
  Website: 'text-teal bg-teal-light',
  'Showroom Visit': 'text-amber-700 bg-amber-500/10',
  IndiaMART: 'text-blue-700 bg-blue-500/10',
};

const defaultSourceColor = 'text-muted bg-surface-hover';

const statusColorMap = {
  New: 'bg-info-light text-info border-info/20',
  Contacted: 'bg-accent-light text-accent border-accent/20',
  'Showroom Visit': 'bg-purple-light text-purple border-purple/20',
  Quotation: 'bg-teal-light text-teal border-teal/20',
  Won: 'bg-success-light text-success border-success/20',
  Lost: 'bg-danger-light text-danger border-danger/20',
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

const buildLeadWhatsAppMessage = (lead) => {
  const interest = lead?.interest ? ` about ${lead.interest}` : '';
  return `Hello ${lead?.name || ''}, this is regarding your enquiry${interest}.`.trim();
};

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [view, setView] = useState('pipeline');
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [followUpForm, setFollowUpForm] = useState({ day: 1, message: '', date: '' });
  const { notify } = useAlertToast();
  const [leadToDraft, setLeadToDraft] = useState(null);
  const [deletingLead, setDeletingLead] = useState(false);

  const refresh = async () => {
    const res = await getLeads();
    if (res.success) setLeads(res.data);
  };

  useEffect(() => {
    getLeads().then(res => {
      if (res.success) setLeads(res.data);
      setLoading(false);
    });
  }, []);

  const searchDigits = search.replace(/\D/g, '');
  const filteredLeads = leads.filter(l =>
    l.name.toLowerCase().includes(search.toLowerCase()) ||
    (l.interest || '').toLowerCase().includes(search.toLowerCase()) ||
    (searchDigits.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(searchDigits))
  );

  const handleCreateLead = async (e) => {
    e.preventDefault();
    const f = e.target;
    const res = await createLead({
      name: f.fullName.value, phone: f.phone.value, email: f.email.value,
      source: f.source.value, budget: f.budget.value,
      interest: f.interest.value, notes: f.notes.value,
      materialCategory: IS_TGM ? f.materialCategory.value : undefined,
      applicationArea: IS_TGM ? f.applicationArea.value : undefined,
      areaSqft: IS_TGM && f.areaSqft.value ? Number(f.areaSqft.value) : undefined,
    });
    if (res.success) { setShowAddModal(false); await refresh(); notify('Lead created', { variant: 'success' }); }
    else notify(res.error || 'Could not create the lead', { variant: 'danger' });
  };

  const handleUpdateStatus = async (leadId, newStage) => {
    const enumStatus = stageToEnum[newStage];
    if (!enumStatus) return;
    setUpdatingStatus(true);
    const res = await updateLeadStatus({ id: leadId, status: enumStatus });
    if (res.success) {
      await refresh();
      setSelectedLead(prev => prev ? { ...prev, status: newStage } : null);
    } else notify(res.error || 'Could not change the stage', { variant: 'danger' });
    setUpdatingStatus(false);
  };

  const handleDelete = (leadId) => {
    const lead = leads.find(l => l.id === leadId);
    // Close detail modal so confirmation modal appears on top.
    // Delay setting the draft modal until after the detail modal closes to avoid z-index/overlay issues.
    setSelectedLead(null);
    setTimeout(() => setLeadToDraft(lead || { id: leadId }), 160);
  };

  const confirmDelete = async () => {
    if (!leadToDraft) return;
    setDeletingLead(true);
    try {
      const res = await moveLeadToDraft(leadToDraft.id);
      if (res?.success) {
        setSelectedLead(null);
        await refresh();
        notify('Lead moved to drafts', { variant: 'success' });
      } else {
        notify(res?.error || 'Failed to move lead to drafts', { variant: 'danger' });
      }
    } catch (err) {
      notify(err?.message || 'Failed to move lead to drafts', { variant: 'danger' });
    } finally {
      setDeletingLead(false);
      setLeadToDraft(null);
    }
  };

  const cancelDelete = () => setLeadToDraft(null);

  const handleAddFollowUp = async () => {
    if (!followUpForm.message || !followUpForm.date) return;
    const res = await addFollowUp({ leadId: selectedLead.id, day: followUpForm.day, message: followUpForm.message, date: followUpForm.date });
    if (!res.success) { notify(res.error || 'Could not add the follow-up', { variant: 'danger' }); return; }
    if (res.success) {
      setFollowUpForm({ day: 1, message: '', date: '' });
      setShowFollowUpForm(false);
      const updated = await getLeads();
      if (updated.success) {
        setLeads(updated.data);
        const fresh = updated.data.find(l => l.id === selectedLead.id);
        if (fresh) setSelectedLead(fresh);
      }
    }
  };

  const handleLeadWhatsApp = (lead) => {
    const message = buildLeadWhatsAppMessage(lead);
    const url = buildWhatsAppUrl(lead?.phone, message);
    if (!url) {
      notify('Lead phone number is missing', { variant: 'danger' });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="flex gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="min-w-[280px] h-64 bg-surface rounded-2xl" />)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out] min-w-0">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:flex-wrap md:gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Leads</h1>
          <p className="text-xs md:text-sm text-muted mt-1">{leads.length} total · {leads.filter(l => l.status === 'New').length} new · {leads.filter(l => l.status === 'Won').length} won</p>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <div className="flex flex-1 md:flex-initial bg-surface rounded-xl border border-border p-0.5">
            <button onClick={() => setView('pipeline')} className={`flex-1 md:flex-initial px-4 py-2 md:py-1.5 rounded-lg text-xs font-medium transition-all ${view === 'pipeline' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>Pipeline</button>
            <button onClick={() => setView('list')} className={`flex-1 md:flex-initial px-4 py-2 md:py-1.5 rounded-lg text-xs font-medium transition-all ${view === 'list' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>List</button>
          </div>
          <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all whitespace-nowrap">
            <Plus className="w-4 h-4" /> Add Lead
          </button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input type="text" placeholder="Search leads by name or product interest..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full md:max-w-md pl-10 pr-4 py-3 md:py-2.5 bg-surface rounded-xl border border-border text-sm" />
      </div>

      {view === 'pipeline' ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {pipelineStages.map((stage) => {
            const stageLeads = filteredLeads.filter(l => l.status === stage);
            return (
              <div key={stage} className="min-w-[280px] flex-shrink-0">
                <div className="flex items-center gap-2 mb-3 px-1">
                  <span className={`badge ${statusColorMap[stage]}`}>{stage}</span>
                  <span className="text-xs text-muted">({stageLeads.length})</span>
                </div>
                <div className="space-y-3">
                  {stageLeads.map((lead) => {
                    const SourceIcon = sourceIconMap[lead.source] || Globe;
                    const sourceColor = sourceColorMap[lead.source] || defaultSourceColor;
                    return (
                      <div key={lead.id} onClick={() => setSelectedLead(lead)}
                        className="glass-card p-4 cursor-pointer group hover:scale-[1.02] transition-transform">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center text-xs font-semibold text-accent">
                              {lead.name.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-foreground">{lead.name}</p>
                              <p className="text-[11px] text-muted">{lead.date}</p>
                            </div>
                          </div>
                          {SourceIcon && (
                            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${sourceColor}`}>
                              <SourceIcon className="w-3.5 h-3.5" />
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-muted mb-2">🛋️ {lead.interest}</p>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-accent">{lead.budget}</span>
                          <ChevronRight className="w-3.5 h-3.5 text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    );
                  })}
                  {stageLeads.length === 0 && (
                    <div className="text-center py-8 text-sm text-muted border-2 border-dashed border-border rounded-xl">No leads</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {/* Mobile stacked card list */}
          <div className="md:hidden space-y-3">
            {filteredLeads.map((lead) => {
              const SourceIcon = sourceIconMap[lead.source] || Globe;
              const sourceColor = sourceColorMap[lead.source] || defaultSourceColor;
              const sourceTextColor = sourceColor.split(' ')[0];
              return (
                <button
                  key={lead.id}
                  type="button"
                  onClick={() => setSelectedLead(lead)}
                  className="w-full text-left glass-card p-4 active:scale-[0.99] transition-transform"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center text-xs font-semibold text-accent flex-shrink-0">
                      {lead.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground truncate">{lead.name}</p>
                        <span className={`badge flex-shrink-0 ${statusColorMap[lead.status]}`}>{lead.status}</span>
                      </div>
                      <p className="text-xs text-muted mt-0.5 truncate">🛋️ {lead.interest}</p>
                      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-muted">
                        <span className="inline-flex items-center gap-1.5">
                          {SourceIcon && <SourceIcon className={`w-3.5 h-3.5 ${sourceTextColor}`} />}
                          {lead.source}
                        </span>
                        {lead.phone && (
                          <span className="inline-flex items-center gap-1.5 min-w-0">
                            <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{lead.phone}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                    <span className="text-sm font-semibold text-accent">{lead.budget}</span>
                    <span className="text-xs text-muted">{lead.date}</span>
                  </div>
                </button>
              );
            })}
            {filteredLeads.length === 0 && (
              <div className="text-center py-10 text-sm text-muted border-2 border-dashed border-border rounded-2xl">No leads found</div>
            )}
          </div>

          {/* Desktop table */}
          <div className="glass-card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="crm-table">
                <thead><tr><th>Name</th><th>Interest</th><th>Source</th><th>Budget</th><th>Status</th><th>Date</th></tr></thead>
                <tbody>
                  {filteredLeads.map((lead) => {
                    const SourceIcon = sourceIconMap[lead.source] || Globe;
                    const sourceColor = sourceColorMap[lead.source] || defaultSourceColor;
                    const sourceTextColor = sourceColor.split(' ')[0];
                    return (
                      <tr key={lead.id} className="cursor-pointer" onClick={() => setSelectedLead(lead)}>
                        <td>
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center text-xs font-semibold text-accent">
                              {lead.name.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{lead.name}</p>
                              <p className="text-xs text-muted">{lead.phone}</p>
                            </div>
                          </div>
                        </td>
                        <td className="text-foreground">{lead.interest}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            {SourceIcon && <SourceIcon className={`w-4 h-4 ${sourceTextColor}`} />}
                            <span>{lead.source}</span>
                          </div>
                        </td>
                        <td className="text-accent font-medium">{lead.budget}</td>
                        <td><span className={`badge ${statusColorMap[lead.status]}`}>{lead.status}</span></td>
                        <td className="text-muted">{lead.date}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Modal isOpen={!!leadToDraft} onClose={cancelDelete} title="Move Lead to Draft" size="sm">
        {leadToDraft && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Move <strong className="text-foreground">{leadToDraft.name || leadToDraft.id}</strong> to drafts? It will be permanently deleted after 30 days.</p>
            <div className="flex justify-end gap-3">
              <button onClick={cancelDelete} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
              <button onClick={confirmDelete} disabled={deletingLead} className="px-4 py-2 rounded-lg bg-danger text-white text-sm disabled:opacity-50">{deletingLead ? 'Moving...' : 'Move to Draft'}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Lead Detail Modal */}
      <Modal isOpen={!!selectedLead} onClose={() => { setSelectedLead(null); setShowFollowUpForm(false); }} title="Lead Details" size="lg">
        {selectedLead && (
          <div className="space-y-5">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center text-xl font-bold text-accent">
                {selectedLead.name.split(' ').map(n => n[0]).join('')}
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-foreground">{selectedLead.name}</h3>
                <div className="flex items-center gap-4 mt-1 flex-wrap">
                  <span className="flex items-center gap-1 text-sm text-muted"><Phone className="w-3.5 h-3.5" /> {selectedLead.phone}</span>
                  {selectedLead.email && <span className="flex items-center gap-1 text-sm text-muted"><Mail className="w-3.5 h-3.5" /> {selectedLead.email}</span>}
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <a
                    href={`tel:${selectedLead.phone}`}
                    className="touch-target inline-flex items-center justify-center gap-1.5 flex-1 md:flex-initial px-4 py-2.5 md:px-3 md:py-1.5 rounded-lg text-sm md:text-xs font-medium bg-success-light text-success border border-success/20 hover:bg-success/20"
                  >
                    <Phone className="w-3.5 h-3.5" /> Call
                  </a>
                  <button
                    type="button"
                    onClick={() => handleLeadWhatsApp(selectedLead)}
                    className="touch-target inline-flex items-center justify-center gap-1.5 flex-1 md:flex-initial px-4 py-2.5 md:px-3 md:py-1.5 rounded-lg text-sm md:text-xs font-medium bg-surface border border-border text-muted hover:text-foreground hover:border-success/30"
                  >
                    <MessageSquare className="w-3.5 h-3.5" /> WhatsApp
                  </button>
                  <a
                    href={`/quotations?new=1&customer=${encodeURIComponent(selectedLead.name)}&phone=${encodeURIComponent(selectedLead.phone)}${selectedLead.email ? `&email=${encodeURIComponent(selectedLead.email)}` : ''}`}
                    className="touch-target inline-flex items-center justify-center gap-1.5 flex-1 md:flex-initial px-4 py-2.5 md:px-3 md:py-1.5 rounded-lg text-sm md:text-xs font-medium bg-accent text-white hover:bg-accent-hover"
                  >
                    <FileText className="w-3.5 h-3.5" /> New quotation
                  </a>
                </div>
              </div>
            </div>

            {/* Pipeline Stage Selector */}
            <div>
              <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Move Stage</p>
              <div className="flex flex-wrap gap-1.5">
                {pipelineStages.map(stage => (
                  <button key={stage} disabled={updatingStatus} onClick={() => handleUpdateStatus(selectedLead.id, stage)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${selectedLead.status === stage
                      ? `${statusColorMap[stage]} font-bold`
                      : 'bg-surface border-border text-muted hover:text-foreground'
                      }`}>
                    {stage}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-3 rounded-xl bg-surface">
                <p className="text-xs text-muted mb-1">Interest</p>
                <p className="text-sm font-medium text-foreground">🛋️ {selectedLead.interest}</p>
              </div>
              <div className="p-3 rounded-xl bg-surface">
                <p className="text-xs text-muted mb-1">Budget</p>
                <p className="text-sm font-medium text-accent">{selectedLead.budget}</p>
              </div>
              <div className="p-3 rounded-xl bg-surface">
                <p className="text-xs text-muted mb-1">Source</p>
                <p className="text-sm font-medium text-foreground">{selectedLead.source}</p>
              </div>
              {IS_TGM && <>
                <div className="p-3 rounded-xl bg-surface"><p className="text-xs text-muted mb-1">Material</p><p className="text-sm font-medium text-foreground">{selectedLead.materialCategory || '—'}</p></div>
                <div className="p-3 rounded-xl bg-surface"><p className="text-xs text-muted mb-1">Application / Area</p><p className="text-sm font-medium text-foreground">{selectedLead.applicationArea || '—'}{selectedLead.areaSqft ? ` · ${selectedLead.areaSqft} sq.ft` : ''}</p></div>
              </>}
              <div className="p-3 rounded-xl bg-surface">
                <p className="text-xs text-muted mb-1">Date Added</p>
                <p className="text-sm font-medium text-foreground">{selectedLead.date}</p>
              </div>
            </div>

            {selectedLead.notes && (
              <div className="p-3 rounded-xl bg-surface">
                <p className="text-xs text-muted mb-1">Notes</p>
                <p className="text-sm text-foreground">{selectedLead.notes}</p>
              </div>
            )}

            {/* Follow-up Timeline */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-accent" />
                  <p className="text-sm font-semibold text-foreground">Follow-up Timeline</p>
                  {selectedLead.followUps?.length > 0 && (
                    <span className="text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full">{selectedLead.followUps.length}</span>
                  )}
                </div>
                <button onClick={() => setShowFollowUpForm(f => !f)}
                  className="text-xs text-accent hover:text-accent-hover font-medium flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add Follow-up
                </button>
              </div>

              {showFollowUpForm && (
                <div className="mb-4 p-4 rounded-xl bg-surface border border-border space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted mb-1 block">Day #</label>
                      <input type="number" min="1" value={followUpForm.day} onChange={e => setFollowUpForm(f => ({ ...f, day: Number(e.target.value) }))}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                    <div>
                      <label className="text-xs text-muted mb-1 block">Date</label>
                      <input type="date" value={followUpForm.date} onChange={e => setFollowUpForm(f => ({ ...f, date: e.target.value }))}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted mb-1 block">Message</label>
                    <textarea rows={2} value={followUpForm.message} onChange={e => setFollowUpForm(f => ({ ...f, message: e.target.value }))}
                      placeholder="Follow-up message..." className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm resize-none focus:outline-none focus:border-accent/50" />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowFollowUpForm(false)} className="px-3 py-1.5 text-xs text-muted hover:text-foreground rounded-lg hover:bg-surface-hover transition-colors">Cancel</button>
                    <button onClick={handleAddFollowUp} disabled={!followUpForm.message || !followUpForm.date}
                      className="px-4 py-1.5 bg-accent text-white rounded-lg text-xs font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">Save</button>
                  </div>
                </div>
              )}

              {selectedLead.followUps?.length > 0 ? (
                <div className="space-y-3 relative before:absolute before:left-[15px] before:top-2 before:bottom-2 before:w-[2px] before:bg-border">
                  {selectedLead.followUps.map((fu, i) => (
                    <div key={i} className="flex gap-3 relative">
                      <div className="w-[32px] h-[32px] rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0 z-10 border-2 border-background">
                        <Clock className="w-3.5 h-3.5 text-accent" />
                      </div>
                      <div className="flex-1 p-3 rounded-xl bg-surface">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-accent">Day {fu.day}</span>
                          <span className="text-[10px] text-muted">{fu.date}</span>
                        </div>
                        <p className="text-sm text-foreground">{fu.message}</p>
                        <span className={`badge text-[10px] mt-2 ${fu.sent ? 'bg-success-light text-success' : 'bg-surface-hover text-muted'}`}>{fu.sent ? '✓ Sent' : '⏳ Pending'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted text-center py-4">No follow-ups yet</p>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-border">
              <button onClick={() => handleDelete(selectedLead.id)}
                className="flex items-center gap-1.5 text-xs text-danger hover:text-danger/80 font-medium transition-colors">
                <Trash2 className="w-3.5 h-3.5" /> Move to Draft
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Add Lead Modal */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Add New Lead">
        <form className="space-y-4" onSubmit={handleCreateLead}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Full Name</label>
              <input type="text" name="fullName" required placeholder="Customer name" className="w-full" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Phone</label>
              <input type="tel" name="phone" required placeholder="+91..." className="w-full" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Email</label>
            <input type="email" name="email" placeholder="customer@email.com" className="w-full" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Source</label>
              <select name="source" className="w-full">
                <option>WhatsApp</option><option>WhatsApp Inquiry</option><option>Instagram</option><option>Facebook</option><option>Website</option><option>Showroom Visit</option><option>IndiaMART</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Budget</label>
              <input type="text" name="budget" placeholder="₹00,000" className="w-full" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Product Interest</label>
            <input type="text" name="interest" required placeholder={IS_TGM ? 'e.g., Granite kitchen platform, ~55 sq.ft' : 'e.g., L-Shaped Sofa'} className="w-full" />
          </div>
          {IS_TGM && <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div><label className="block text-xs font-medium text-muted mb-1.5">Material</label><select name="materialCategory" className="w-full"><option value="">Select material</option>{TGM_MATERIAL_OPTIONS.map(option => <option key={option}>{option}</option>)}</select></div>
            <div><label className="block text-xs font-medium text-muted mb-1.5">Application Area</label><select name="applicationArea" className="w-full"><option value="">Select area</option>{TGM_APPLICATION_OPTIONS.map(option => <option key={option}>{option}</option>)}</select></div>
            <div><label className="block text-xs font-medium text-muted mb-1.5">Approx. Area (sq.ft)</label><input type="number" min="0" step="0.01" name="areaSqft" placeholder="e.g. 250" className="w-full" /></div>
          </div>}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Notes</label>
            <textarea rows={3} name="notes" placeholder="Additional notes..." className="w-full" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
            <button type="submit" className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">Save Lead</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
