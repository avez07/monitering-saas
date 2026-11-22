import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, LayoutTemplate, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, ErrorState, TableSkeleton, notify } from '@/components/app';
import { useSession } from '@/lib/session';
import { deleteRule, ruleFromTemplate, updateRule, useAction, useRules, useTemplates } from './api';
import RuleEditor from './RuleEditor';

function TemplateGallery({ open, onOpenChange, onCreated }) {
  const templates = useTemplates();
  const action = useAction();
  function pick(template) {
    action.mutate(ruleFromTemplate(template.key), {
      onSuccess: (rule) => {
        onOpenChange(false);
        onCreated(rule);
        notify.success(`"${rule.name}" added. You can change anything below.`);
      },
    });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Start from a ready-made alert</DialogTitle>
          <DialogDescription>
            Pick one and it is added straight away. You can change it afterwards.
          </DialogDescription>
        </DialogHeader>
        {templates.isLoading ? (
          <TableSkeleton rows={4} />
        ) : templates.error ? (
          <ErrorState error={templates.error} onRetry={templates.refetch} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {templates.data.items.map((template) => (
              <li key={template.key}>
                <button
                  type="button"
                  disabled={action.isPending}
                  onClick={() => pick(template)}
                  className="flex h-full w-full flex-col items-start gap-1 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <span className="flex w-full items-center justify-between gap-2 font-medium">
                    {template.name}
                    {template.alreadyCreated && <Badge variant="secondary">Already added</Badge>}
                  </span>
                  <span className="text-sm text-muted-foreground">{template.summary}</span>
                  {!template.available && (
                    <span className="text-sm text-muted-foreground">
                      Starts working once data arrives.
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuleCard({ rule, canEdit, onEdit, onDelete }) {
  const action = useAction();
  return (
    <Card className="surface card-accent transition-shadow duration-150 hover:shadow-md">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-serif text-base font-semibold leading-tight">{rule.name}</h2>
            {rule.openIncidents > 0 && (
              <Badge variant="outline" className="gap-1.5">
                <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
                {rule.openIncidents} open
              </Badge>
            )}
          </div>
          <p className="text-base">{rule.summary}</p>
          <p className="text-sm text-muted-foreground">
            Sends to: {rule.sendTo || 'all your contacts'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={rule.enabled}
            disabled={!canEdit || action.isPending}
            aria-label={`${rule.name} is ${rule.enabled ? 'on' : 'off'}`}
            onCheckedChange={(enabled) =>
              action.mutate(updateRule(rule.id, { enabled }), {
                onSuccess: () =>
                  notify.success(enabled ? 'Alert switched on' : 'Alert switched off'),
              })
            }
          />
          <span className="w-8 text-sm text-muted-foreground" aria-hidden="true">
            {rule.enabled ? 'On' : 'Off'}
          </span>
          {canEdit && (
            <>
              <Button variant="outline" size="sm" onClick={() => onEdit(rule)}>
                <Pencil className="size-4" aria-hidden="true" />
                Edit
                <span className="sr-only"> {rule.name}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${rule.name}`}
                onClick={() => onDelete(rule)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function RulesTab() {
  const { isAdmin } = useSession();
  const rules = useRules();
  const action = useAction();
  const [editing, setEditing] = useState(null); // rule object, or {} for new
  const [gallery, setGallery] = useState(false);
  const [removing, setRemoving] = useState(null);

  if (rules.isLoading) return <TableSkeleton rows={3} />;
  if (rules.error) return <ErrorState error={rules.error} onRetry={rules.refetch} />;
  const { items, limit } = rules.data;
  const atLimit =
    !!limit && limit.max !== null && limit.max !== undefined && limit.used >= limit.max;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {limit?.max ? `${limit.used} of ${limit.max} alerts used on your plan.` : 'Your alerts'}
          {atLimit && (
            <>
              {' '}
              <Link to="/settings/plan" className="font-medium text-foreground underline">
                Upgrade for more
              </Link>
              .
            </>
          )}
        </p>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setGallery(true)} disabled={atLimit}>
              <LayoutTemplate className="size-4" aria-hidden="true" />
              Add from template
            </Button>
            <Button onClick={() => setEditing({})} disabled={atLimit}>
              <Plus className="size-4" aria-hidden="true" />
              New alert
            </Button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="No alerts yet"
          text="Pick a ready-made alert, such as “Disk almost full”, and we will tell you before it becomes a problem."
          action={
            isAdmin ? { label: 'Add from template', onClick: () => setGallery(true) } : undefined
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((rule) => (
            <li key={rule.id}>
              <RuleCard rule={rule} canEdit={isAdmin} onEdit={setEditing} onDelete={setRemoving} />
            </li>
          ))}
        </ul>
      )}

      <TemplateGallery open={gallery} onOpenChange={setGallery} onCreated={setEditing} />
      {editing && (
        <RuleEditor rule={editing.id ? editing : null} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete “${removing?.name}”?`}
        description="You will stop getting this alert. Past alerts stay in your history."
        confirmLabel="Delete alert"
        destructive
        loading={action.isPending}
        onConfirm={() =>
          action.mutate(deleteRule(removing.id), {
            onSuccess: () => {
              setRemoving(null);
              notify.success('Alert deleted');
            },
          })
        }
      />
    </div>
  );
}
