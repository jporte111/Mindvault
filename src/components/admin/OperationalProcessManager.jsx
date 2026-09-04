import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Workflow, Loader2, Archive, ArchiveRestore, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import ConceptHelp from '@/components/onboarding/ConceptHelp';
import {
  PROCESS_CRITICALITY_OPTIONS,
  CRITICALITY_LABEL,
  REVIEW_INTERVAL_OPTIONS,
  processScopeValue,
  resolveProcessScopeFields,
  processFreshness,
  SCOPE_GENERAL,
  SCOPE_UNCLASSIFIED,
  CLIENT_PREFIX,
} from '@/lib/operationalProcess';

const selectClass =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

const userLabel = (u) => u?.full_name || u?.email || u?.id || 'Unknown user';

function emptyForm() {
  return {
    name: '', description: '', department: '', criticality: '',
    review_interval_days: '', process_owner: '', subject_matter_expert: '',
    backup_sme: '', scopeValue: SCOPE_UNCLASSIFIED, tags: [],
  };
}

function formFromProcess(p) {
  return {
    name: p.name || '',
    description: p.description || '',
    department: p.department || '',
    criticality: p.criticality || '',
    review_interval_days: p.review_interval_days != null ? String(p.review_interval_days) : '',
    process_owner: p.process_owner || '',
    subject_matter_expert: p.subject_matter_expert || '',
    backup_sme: p.backup_sme || '',
    scopeValue: processScopeValue(p),
    tags: Array.isArray(p.tags) ? p.tags : [],
  };
}

function ProcessForm({ form, setForm, users, clients, onSubmit, onCancel, saving, submitLabel }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const scopeOptions = [
    { value: SCOPE_UNCLASSIFIED, label: 'Unclassified' },
    { value: SCOPE_GENERAL, label: 'Organization-wide' },
    ...clients.filter((c) => c.status !== 'archived').map((c) => ({ value: CLIENT_PREFIX + c.id, label: `Client: ${c.name}` })),
  ];
  const userOptions = [{ id: '', label: '— none —' }, ...users.map((u) => ({ id: u.id, label: userLabel(u) }))];

  return (
    <div className="rounded-xl border border-border p-4 space-y-3 bg-muted/20">
      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">Name (required)</Label>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Monthly bank reconciliation" className="bg-background" disabled={saving} />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">Description</Label>
        <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What it is and when it runs" className="bg-background" disabled={saving} />
      </div>
      <div data-tour="process-criticality-cadence">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Department</Label>
            <Input value={form.department} onChange={(e) => set('department', e.target.value)} className="bg-background" disabled={saving} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              Criticality <ConceptHelp term="criticality" />
            </Label>
            <select className={selectClass} value={form.criticality} onChange={(e) => set('criticality', e.target.value)} disabled={saving}>
              <option value="">Not set</option>
              {PROCESS_CRITICALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              Review interval (days) <ConceptHelp term="review_cadence" />
            </Label>
            <Input type="number" min={1} value={form.review_interval_days} onChange={(e) => set('review_interval_days', e.target.value)} placeholder={REVIEW_INTERVAL_OPTIONS.join(' / ')} className="bg-background" disabled={saving} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Scope</Label>
            <select className={selectClass} value={form.scopeValue} onChange={(e) => set('scopeValue', e.target.value)} disabled={saving}>
              {scopeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="grid sm:grid-cols-3 gap-3" data-tour="process-people">
        {[
          ['process_owner', 'Owner', 'owner'],
          ['subject_matter_expert', 'SME', 'sme'],
          ['backup_sme', 'Backup SME', 'backup_sme'],
        ].map(([key, label, term]) => (
          <div key={key}>
            <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              {label} <ConceptHelp term={term} />
            </Label>
            <select className={selectClass} value={form[key]} onChange={(e) => set(key, e.target.value)} disabled={saving}>
              {userOptions.map((u) => <option key={u.id || 'none'} value={u.id}>{u.label}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">Tags (comma separated)</Label>
        <Input
          value={form.tags.join(', ')}
          onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
          className="bg-background"
          disabled={saving}
        />
      </div>
      <div className="flex gap-2 pt-1">
        <Button size="sm" className="bg-primary hover:bg-primary/90 gap-2" disabled={saving || !form.name.trim()} onClick={onSubmit}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="outline" className="gap-1.5" disabled={saving} onClick={onCancel}>
            <X className="w-3.5 h-3.5" /> Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export default function OperationalProcessManager() {
  const queryClient = useQueryClient();
  const [createForm, setCreateForm] = useState(emptyForm());
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const { data: processes = [] } = useQuery({
    queryKey: ['operational-processes'],
    queryFn: async () => {
      const res = await base44.functions.invoke('listOperationalProcesses');
      return res?.data?.processes ?? res?.processes ?? [];
    },
  });
  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: () => base44.entities.Client.list('name') });
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list().catch(() => []),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['operational-processes'] });

  const buildFields = (form) => ({
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    department: form.department.trim() || undefined,
    criticality: form.criticality || undefined,
    review_interval_days: form.review_interval_days ? Math.max(1, Number(form.review_interval_days)) : undefined,
    process_owner: form.process_owner || undefined,
    subject_matter_expert: form.subject_matter_expert || undefined,
    backup_sme: form.backup_sme || undefined,
    tags: form.tags.length ? form.tags : undefined,
    ...resolveProcessScopeFields(form.scopeValue),
  });

  const create = async () => {
    setSaving(true);
    try {
      await base44.entities.OperationalProcess.create(buildFields(createForm));
      setCreateForm(emptyForm());
      invalidate();
      toast.success('Operational process created');
    } catch (err) {
      toast.error('Failed to create: ' + (err?.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await base44.entities.OperationalProcess.update(editId, buildFields(editForm));
      setEditId(null);
      invalidate();
      toast.success('Operational process updated');
    } catch (err) {
      toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (p) => {
    try {
      await base44.entities.OperationalProcess.update(p.id, { status: p.status === 'archived' ? 'active' : 'archived' });
      invalidate();
    } catch (err) {
      toast.error('Failed to update: ' + (err?.message || 'Unknown error'));
    }
  };

  const scopeLabel = (p) => {
    const v = processScopeValue(p);
    if (v === SCOPE_GENERAL) return 'Organization-wide';
    if (v.startsWith(CLIENT_PREFIX)) {
      const c = clients.find((x) => x.id === v.slice(CLIENT_PREFIX.length));
      return c ? `Client: ${c.name}` : 'Client';
    }
    return 'Unclassified';
  };

  return (
    <Card className="border-border" data-tour="operational-processes">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Workflow className="w-4 h-4 text-primary" />
          Operational Processes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          A process owns its governance (owner, SME, review cadence, criticality). Knowledge sources link to a process rather than repeating this on every record.
        </p>

        <ProcessForm
          form={createForm}
          setForm={setCreateForm}
          users={users}
          clients={clients}
          onSubmit={create}
          saving={saving && editId === null}
          submitLabel="Add process"
        />

        {processes.length > 0 && (
          <div className="divide-y divide-border border border-border rounded-xl">
            {processes.map((p) => (
              <div key={p.id} className="px-4 py-3 space-y-2">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {p.name}
                      {p.status === 'archived' && <span className="text-muted-foreground font-normal"> · archived</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[p.department, p.criticality && CRITICALITY_LABEL[p.criticality], scopeLabel(p), processFreshness(p)]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => { setEditId(p.id); setEditForm(formFromProcess(p)); }}>
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={() => toggleArchive(p)}>
                    {p.status === 'archived' ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                    {p.status === 'archived' ? 'Restore' : 'Archive'}
                  </Button>
                </div>
                {p.criticality && (
                  <Badge variant="outline" className="text-[10px]">{CRITICALITY_LABEL[p.criticality]} criticality</Badge>
                )}
                {editId === p.id && (
                  <ProcessForm
                    form={editForm}
                    setForm={setEditForm}
                    users={users}
                    clients={clients}
                    onSubmit={saveEdit}
                    onCancel={() => setEditId(null)}
                    saving={saving}
                    submitLabel="Save changes"
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
