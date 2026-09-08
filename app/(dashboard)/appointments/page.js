'use client';

import { useState, useEffect } from 'react';
import { Calendar as CalIcon, Plus, Clock, User, Check, X, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { getAppointments, createAppointment, updateAppointmentStatus, cancelAppointment } from '@/app/actions/appointments';
import { moveAppointmentToDraft } from '@/app/actions/drafts';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getActiveVertical } from '@/lib/brand';

const IS_TGM = getActiveVertical() === 'tiles';

const statusColors = {
  Scheduled: 'bg-info-light text-info',
  Completed: 'bg-success-light text-success',
  Cancelled: 'bg-danger-light text-danger',
};

const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const { notify } = useAlertToast();
  const [appointmentToCancel, setAppointmentToCancel] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [appointmentToDraft, setAppointmentToDraft] = useState(null);
  const [deletingAppointment, setDeletingAppointment] = useState(false);
  const now = new Date();
  const [currentMonth, setCurrentMonth] = useState(now.getMonth());
  const [currentYear, setCurrentYear] = useState(now.getFullYear());
  const [selectedDate, setSelectedDate] = useState(now.toISOString().split('T')[0]);
  const [showBookModal, setShowBookModal] = useState(false);

  const refresh = async () => {
    const res = await getAppointments();
    if (res.success) setAppointments(res.data);
  };

  useEffect(() => {
    getAppointments().then(res => {
      if (res.success) setAppointments(res.data);
      setLoading(false);
    });
  }, []);

  // AI bookings happen outside this browser tab. Keep the calendar current
  // while it is open, without requiring a manual page reload.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const getDaysInMonth = (m, y) => new Date(y, m + 1, 0).getDate();
  const getFirstDay = (m, y) => new Date(y, m, 1).getDay();
  const daysInMonth = getDaysInMonth(currentMonth, currentYear);
  const firstDay = getFirstDay(currentMonth, currentYear);
  const calendarDays = [];
  for (let i = 0; i < firstDay; i++) calendarDays.push(null);
  for (let i = 1; i <= daysInMonth; i++) calendarDays.push(i);

  const getDateStr = (day) => !day ? '' : `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const getAptsForDate = (dateStr) => appointments.filter(a => a.date === dateStr);
  const selectedApts = getAptsForDate(selectedDate);

  const prevMonth = () => { if (currentMonth === 0) { setCurrentMonth(11); setCurrentYear(y => y-1); } else setCurrentMonth(m => m-1); };
  const nextMonth = () => { if (currentMonth === 11) { setCurrentMonth(0); setCurrentYear(y => y+1); } else setCurrentMonth(m => m+1); };

  const handleComplete = async (id) => {
    await updateAppointmentStatus(id, 'Completed');
    await refresh();
  };

  const handleCancel = (id) => {
    setAppointmentToCancel(id);
  };

  const confirmCancel = async () => {
    if (!appointmentToCancel) return;
    setCancelling(true);
    try {
      await cancelAppointment(appointmentToCancel);
      await refresh();
      notify('Appointment cancelled', { variant: 'info' });
    } catch (err) {
      notify(err?.message || 'Failed to cancel appointment', { variant: 'danger' });
    } finally {
      setCancelling(false);
      setAppointmentToCancel(null);
    }
  };

  const handleMoveToDraft = (id) => {
    setAppointmentToDraft(id);
  };

  const confirmMoveToDraft = async () => {
    if (!appointmentToDraft) return;
    setDeletingAppointment(true);
    try {
      const res = await moveAppointmentToDraft(appointmentToDraft);
      if (res.success) {
        await refresh();
        notify('Appointment moved to drafts', { variant: 'success' });
      } else {
        notify(res.error || 'Failed to move appointment to drafts', { variant: 'danger' });
      }
    } catch (err) {
      notify(err?.message || 'Failed to move appointment to drafts', { variant: 'danger' });
    } finally {
      setDeletingAppointment(false);
      setAppointmentToDraft(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 h-96 bg-surface rounded-2xl" />
          <div className="h-96 bg-surface rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Appointments</h1>
          <p className="text-sm text-muted mt-1">{appointments.filter(a => a.status === 'Scheduled').length} upcoming · {appointments.filter(a => a.status === 'Completed').length} completed</p>
        </div>
        <button onClick={() => setShowBookModal(true)} className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
          <Plus className="w-4 h-4" /> Book Appointment
        </button>
      </div>

      <Modal isOpen={!!appointmentToCancel} onClose={() => setAppointmentToCancel(null)} title="Cancel Appointment" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Are you sure you want to cancel this appointment?</p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setAppointmentToCancel(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">No</button>
            <button onClick={confirmCancel} disabled={cancelling} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{cancelling ? 'Cancelling...' : 'Yes, Cancel'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!appointmentToDraft} onClose={() => setAppointmentToDraft(null)} title="Move Appointment to Draft" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Move this appointment to drafts? It will be permanently deleted after 30 days.</p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setAppointmentToDraft(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
            <button onClick={confirmMoveToDraft} disabled={deletingAppointment} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{deletingAppointment ? 'Moving...' : 'Move to Draft'}</button>
          </div>
        </div>
      </Modal>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Calendar */}
        <div className="lg:col-span-2 glass-card p-5">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-foreground">{months[currentMonth]} {currentYear}</h2>
            <div className="flex gap-1">
              <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-foreground transition-colors"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={nextMonth} className="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-foreground transition-colors"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 mb-2">
            {days.map(d => <div key={d} className="text-center text-xs font-semibold text-muted py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((day, i) => {
              const dateStr = getDateStr(day);
              const dayApts = day ? getAptsForDate(dateStr) : [];
              const isSelected = dateStr === selectedDate;
              const isToday = dateStr === new Date().toISOString().split('T')[0];
              return (
                <button key={i} onClick={() => day && setSelectedDate(dateStr)} disabled={!day}
                  className={`aspect-square rounded-xl flex flex-col items-center justify-center gap-0.5 text-sm transition-all ${
                    !day ? '' : isSelected ? 'bg-accent text-white font-bold' :
                    isToday ? 'bg-accent/10 text-accent font-semibold ring-1 ring-accent/30' :
                    'text-foreground hover:bg-surface-hover'
                  }`}>
                  {day && (
                    <>
                      <span>{day}</span>
                      {dayApts.length > 0 && (
                        <div className="flex gap-0.5">
                          {dayApts.slice(0, 3).map((_, j) => <div key={j} className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white/60' : 'bg-accent'}`} />)}
                        </div>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Appointments for selected date */}
        <div className="glass-card p-5">
          <h2 className="text-base font-semibold text-foreground mb-1">
            {selectedDate ? new Date(selectedDate + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'Select a date'}
          </h2>
          <p className="text-xs text-muted mb-4">{selectedApts.length} appointment{selectedApts.length !== 1 ? 's' : ''}</p>
          {selectedApts.length > 0 ? (
            <div className="space-y-3">
              {selectedApts.map(apt => (
                <div key={apt.id} className="p-4 rounded-xl bg-surface border border-border">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-accent" />
                      <span className="text-sm font-semibold text-foreground">{apt.time}</span>
                    </div>
                    <span className={`badge text-[10px] ${statusColors[apt.status]}`}>{apt.status}</span>
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    <User className="w-3.5 h-3.5 text-muted" />
                    <span className="text-sm text-foreground">{apt.customer}</span>
                  </div>
                  <p className="text-xs text-accent mb-2">{apt.purpose}</p>
                  {apt.notes && <p className="text-xs text-muted mb-3">{apt.notes}</p>}
                  {apt.status === 'Scheduled' && (
                    <div className="flex gap-2">
                      <button onClick={() => handleComplete(apt.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-success-light text-success text-xs font-medium hover:bg-success/20 transition-colors">
                        <Check className="w-3.5 h-3.5" /> Complete
                      </button>
                      <button onClick={() => handleMoveToDraft(apt.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-red-500/10 text-red-700 text-xs font-medium hover:bg-red-500/20 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" /> Draft
                      </button>
                      <button onClick={() => handleCancel(apt.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-danger-light text-danger text-xs font-medium hover:bg-danger/20 transition-colors">
                        <X className="w-3.5 h-3.5" /> Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted">
              <CalIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No appointments on this date</p>
            </div>
          )}
        </div>
      </div>

      {/* All Appointments Table */}
      <div className="glass-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">All Appointments</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="crm-table">
            <thead>
              <tr><th>Customer</th><th>Date</th><th>Time</th><th>Purpose</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {appointments.map(apt => (
                <tr key={apt.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-teal-light flex items-center justify-center text-xs font-semibold text-teal">
                        {apt.customer.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{apt.customer}</p>
                        <p className="text-xs text-muted">{apt.phone}</p>
                      </div>
                    </div>
                  </td>
                  <td>{apt.date}</td>
                  <td className="text-foreground font-medium">{apt.time}</td>
                  <td>{apt.purpose}</td>
                  <td><span className={`badge ${statusColors[apt.status]}`}>{apt.status}</span></td>
                  <td>
                    {apt.status === 'Scheduled' && (
                      <div className="flex gap-1">
                        <button onClick={() => handleComplete(apt.id)} title="Mark Complete"
                          className="p-1.5 rounded-lg bg-success-light text-success hover:bg-success/20 transition-colors">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleMoveToDraft(apt.id)} title="Move to Draft"
                          className="p-1.5 rounded-lg bg-red-500/10 text-red-700 hover:bg-red-500/20 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleCancel(apt.id)} title="Cancel"
                          className="p-1.5 rounded-lg bg-danger-light text-danger hover:bg-danger/20 transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Book Appointment Modal */}
      <Modal isOpen={showBookModal} onClose={() => setShowBookModal(false)} title="Book Appointment">
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          const f = e.target;
          const res = await createAppointment({
            customer: f.customerName.value, phone: f.phone.value,
            date: f.date.value, time: f.time.value,
            purpose: f.purpose.value, notes: f.notes.value,
          });
          if (res.success) { setShowBookModal(false); await refresh(); }
        }}>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Customer Name</label>
            <input type="text" name="customerName" required placeholder="Customer name" className="w-full" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Phone</label>
            <input type="tel" name="phone" required placeholder="+91..." className="w-full" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Date</label>
              <input type="date" name="date" required className="w-full" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Time</label>
              <input type="time" name="time" required className="w-full" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Purpose</label>
            <select name="purpose" className="w-full">
              {IS_TGM ? <><option>Tile & Surface Consultation</option><option>Slab Selection & Lot Approval</option><option>Kitchen Platform Site Measurement</option><option>Fabrication Template Visit</option><option>Flooring / Cladding Consultation</option></> : <><option>Sofa Collection Viewing</option><option>Bed Selection</option><option>Dining Table Measurement</option><option>Kitchen Design Consultation</option><option>Wardrobe Design Discussion</option></>}
              <option>General Showroom Visit</option>
              <option>Order Pickup</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Notes</label>
            <textarea rows={3} name="notes" placeholder="Additional notes..." className="w-full" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowBookModal(false)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
            <button type="submit" className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">Book Appointment</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
