'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { Contact, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { ContactForm } from '@/components/whatsapp/contacts/contact-form';
import { ContactDetailView } from '@/components/whatsapp/contacts/contact-detail-view';
import { ImportModal } from '@/components/whatsapp/contacts/import-modal';
import { confirmDialog } from '@/components/AlertToastProvider';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

export function ContactsTab() {
  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [cleaningSmoke, setCleaningSmoke] = useState(false);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTagIds, setEditContactTagIds] = useState<string[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Request failed');
    }
    return data as T;
  }

  const fetchContacts = useCallback(async () => {
    setLoading(true);

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });

    if (search.trim()) {
      params.set('search', search.trim());
    }

    try {
      const data = await fetchJson<{ data: ContactWithTags[]; count: number }>(
        `/api/whatsapp/contacts?${params.toString()}`,
      );
      setContacts(data.data ?? []);
      setTotalCount(data.count ?? 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load contacts';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  async function handleSyncFromCrm() {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/contacts', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Sync failed');
      }
      toast.success(
        `Synced contacts: ${data.created ?? 0} new, ${data.updated ?? 0} updated`,
      );
      fetchContacts();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      toast.error(message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleRemoveSmokeContacts() {
    if (!await confirmDialog('Remove all "WA Smoke Contact" test entries?')) return;
    setCleaningSmoke(true);
    try {
      const res = await fetch('/api/whatsapp/contacts', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Cleanup failed');
      }
      toast.success(`Removed ${data.removed ?? 0} smoke contacts`);
      fetchContacts();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cleanup failed';
      toast.error(message);
    } finally {
      setCleaningSmoke(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTagIds([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    try {
      const data = await fetchJson<{ tag_ids: string[] }>(
        `/api/whatsapp/contacts/${contact.id}`,
      );
      setEditContact(contact);
      setEditContactTagIds(data.tag_ids ?? []);
      setFormOpen(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load contact';
      toast.error(message);
    }
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      await fetchJson(`/api/whatsapp/contacts/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      toast.success('Contact deleted');
      fetchContacts();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete contact';
      toast.error(message);
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Contacts</h1>
          <p className="text-sm text-muted mt-1">
            Manage your contact list. {totalCount > 0 && `${totalCount} total contacts.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={handleSyncFromCrm}
            disabled={syncing}
            className="border-border text-foreground hover:bg-surface-light"
          >
            <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
            Sync CRM
          </Button>
          <Button
            variant="outline"
            onClick={handleRemoveSmokeContacts}
            disabled={cleaningSmoke}
            className="border-border text-foreground hover:bg-surface-light"
          >
            <Trash2 className="size-4" />
            Remove Smoke Contacts
          </Button>
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            className="border-border text-foreground hover:bg-surface-light"
          >
            <Upload className="size-4" />
            Import
          </Button>
          <Button
            onClick={openAddForm}
            className="bg-accent hover:bg-accent text-foreground"
          >
            <Plus className="size-4" />
            Add Contact
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            // Reset pagination when the query changes — the result
            // set shrinks/grows, page N may no longer be valid.
            setPage(0);
          }}
          placeholder="Search by name, phone, or email..."
          className="pl-8 bg-surface border-border text-foreground placeholder:text-muted"
        />
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-3 md:hidden">
        {loading ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Loader2 className="size-6 animate-spin text-accent" />
            <p className="text-sm text-muted">Loading contacts...</p>
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface py-12">
            <Users className="size-8 text-muted" />
            <p className="text-sm text-muted">
              {search ? 'No contacts match your search.' : 'No contacts yet.'}
            </p>
            {!search && (
              <Button
                variant="outline"
                size="sm"
                onClick={openAddForm}
                className="mt-2 border-border text-foreground hover:bg-surface-light"
              >
                <Plus className="size-3.5" />
                Add your first contact
              </Button>
            )}
          </div>
        ) : (
          contacts.map((contact) => (
            <div
              key={contact.id}
              role="button"
              tabIndex={0}
              onClick={() => openDetail(contact.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openDetail(contact.id);
                }
              }}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 transition-colors active:bg-surface-light"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-light text-sm font-semibold text-foreground">
                {(contact.name || contact.phone || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">
                  {contact.name || <span className="italic text-muted">Unnamed</span>}
                </p>
                <p className="mt-0.5 truncate font-mono text-xs text-muted">{contact.phone}</p>
                {contact.email && (
                  <p className="mt-0.5 truncate text-xs text-muted">{contact.email}</p>
                )}
                {contact.tags && contact.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {contact.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag.id}
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: tag.color + '20', color: tag.color }}
                      >
                        {tag.name}
                      </span>
                    ))}
                    {contact.tags.length > 3 && (
                      <span className="text-[10px] text-muted">+{contact.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="-mr-1 size-9 shrink-0 text-muted hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    />
                  }
                >
                  <MoreHorizontal className="size-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-surface border-border">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditForm(contact);
                    }}
                    className="text-foreground focus:bg-surface-light focus:text-foreground"
                  >
                    <Pencil className="size-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-surface-light" />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      confirmDelete(contact);
                    }}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>

      {/* Table */}
      <div className="hidden rounded-lg border border-border overflow-hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted">Name</TableHead>
              <TableHead className="text-muted">Phone</TableHead>
              <TableHead className="text-muted hidden md:table-cell">Email</TableHead>
              <TableHead className="text-muted hidden lg:table-cell">Company</TableHead>
              <TableHead className="text-muted hidden md:table-cell">Tags</TableHead>
              <TableHead className="text-muted hidden lg:table-cell">Created</TableHead>
              <TableHead className="text-muted w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-accent" />
                    <p className="text-sm text-muted">Loading contacts...</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted" />
                    <p className="text-sm text-muted">
                      {search ? 'No contacts match your search.' : 'No contacts yet.'}
                    </p>
                    {!search && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-foreground hover:bg-surface-light"
                      >
                        <Plus className="size-3.5" />
                        Add your first contact
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-border hover:bg-surface cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell className="text-foreground font-medium">
                    {contact.name || <span className="text-muted italic">Unnamed</span>}
                  </TableCell>
                  <TableCell className="text-foreground font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="text-muted hidden md:table-cell text-sm">
                    {contact.email || <span className="text-muted">-</span>}
                  </TableCell>
                  <TableCell className="text-muted hidden lg:table-cell text-sm">
                    {contact.company || <span className="text-muted">-</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted text-xs">-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-[10px] text-muted">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted text-xs hidden lg:table-cell">
                    {new Date(contact.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-surface border-border"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-foreground focus:bg-surface-light focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-surface-light" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted">
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, totalCount)} of{' '}
            {totalCount}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted hover:bg-surface-light hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-muted px-2">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted hover:bg-surface-light hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTagIds={editContactTagIds}
        onSaved={() => {
          fetchContacts();
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-surface border-border text-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Delete Contact</DialogTitle>
            <DialogDescription className="text-muted">
              Are you sure you want to delete{' '}
              <span className="text-foreground font-medium">
                {deleteTarget?.name || deleteTarget?.phone}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-surface border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-foreground hover:bg-surface-light"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
