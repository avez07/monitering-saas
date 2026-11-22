import { useNavigate } from 'react-router-dom';
import { LogOut, Settings, ShieldCheck, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '@/lib/session';

const initials = (name = '?') =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** Account dropdown: profile, org switcher, settings, sign out. */
export function UserMenu({ side = 'bottom', align = 'end', className }) {
  const { user, organization, organizations, switchOrganization, signOut, isPlatformAdmin } = useSession();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('rounded-full', className)}
          aria-label={`${initials(user?.name)} account menu`}
        >
          <Avatar className="size-7">
            <AvatarFallback className="text-[11px]">{initials(user?.name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{user?.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
          {organization?.name && (
            <p className="mt-1 truncate text-xs text-muted-foreground" title="Your organization">
              {organization.name}
            </p>
          )}
        </DropdownMenuLabel>
        {organizations.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Switch organization</DropdownMenuLabel>
            {organizations.map((org) => (
              <DropdownMenuItem key={org.id} onSelect={() => switchOrganization(org.id)}>
                <span className="truncate">{org.name}</span>
                {org.id === organization?.id && (
                  <span className="ml-auto text-xs text-muted-foreground">Current</span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {isPlatformAdmin && (
          <>
            <DropdownMenuSeparator />
            {/* Staff only: the Yukti platform admin. */}
            <DropdownMenuItem onSelect={() => navigate('/admin')}>
              <ShieldCheck className="mr-2 size-4" aria-hidden="true" /> Yukti Admin
            </DropdownMenuItem>
          </>
        )}
        {organization && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/settings/account')}>
              <User className="mr-2 size-4" aria-hidden="true" /> Account
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate('/settings')}>
              <Settings className="mr-2 size-4" aria-hidden="true" /> Settings
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut className="mr-2 size-4" aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
