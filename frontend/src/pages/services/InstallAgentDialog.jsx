import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSession } from '@/lib/session';
import Command from '../add-server/Command';
import KeyPanel from '../add-server/KeyPanel';
import StepWait from '../add-server/StepWait';
import { getReleases } from '../add-server/api';
import { KEY_PATTERN, oneCommand } from '../add-server/model';

/** Small dialog: install the agent on a host (Linux), then wait for it to connect. */
export default function InstallAgentDialog({ onClose }) {
  const { isAdmin, apiPublicUrl } = useSession();
  const [keyValue, setKeyValue] = useState('');
  const [ran, setRan] = useState(false);
  const [openedAt] = useState(() => new Date().toISOString());
  const releases = useQuery({
    queryKey: ['add-server', 'releases', 'service-dialog'],
    queryFn: getReleases,
    staleTime: 5 * 60 * 1000,
  });
  const ready = KEY_PATTERN.test(keyValue);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Install the agent on that host</DialogTitle>
          <DialogDescription>
            The agent is a small program that reports what runs on the host. Once it is connected,
            pick it in the list.
          </DialogDescription>
        </DialogHeader>
        {!isAdmin ? (
          <Alert>
            <AlertDescription>Only owners and admins can add a host.</AlertDescription>
          </Alert>
        ) : ran ? (
          <div className="space-y-4">
            <StepWait startedAt={openedAt} />
            <Button variant="outline" onClick={onClose}>
              Back to adding the service
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <KeyPanel keyValue={keyValue} onKey={setKeyValue} />
            <p className="text-sm text-muted-foreground">
              Log in to the host over SSH and run this:
            </p>
            <Command
              code={oneCommand({ release: releases.data, key: keyValue, apiUrl: apiPublicUrl || '' })}
              label="install command"
            />
            {!ready && (
              <p className="text-sm text-muted-foreground">
                The command shows YOUR_API_KEY until you add your key above.
              </p>
            )}
            <Button onClick={() => setRan(true)}>I ran the command</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
