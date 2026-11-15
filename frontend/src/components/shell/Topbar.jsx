import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Menu, Plus, Settings, User } from 'lucide-react';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useSession } from '@/lib/session';
import { Logo } from './Logo';
import { SidebarNav } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';

const initials = (name = '?') =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export function Topbar() {
  const { user, organization, organizations, switchOrganization, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur sm:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
            <Menu className="size-5" aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-72 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
        >
          <SheetHeader className="px-6 py-4 text-left">
            <SheetTitle>
              <Logo />
            </SheetTitle>
            <SheetDescription className="sr-only">Main navigation</SheetDescription>
          </SheetHeader>
          <SidebarNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <p
        className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground"
        title="Your organization"
      >
        {organization?.name}
      </p>

      <Button asChild size="sm" className="shrink-0">
        <Link to="/add-server">
          <Plus className="size-4" aria-hidden="true" /> Add server
        </Link>
      </Button>
      <ThemeToggle />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={`${initials(user?.name)} account menu`}>
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">{initials(user?.name)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
          </DropdownMenuLabel>
          {organizations.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Switch organization
              </DropdownMenuLabel>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate('/settings/account')}>
            <User className="mr-2 size-4" aria-hidden="true" /> Account
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/settings')}>
            <Settings className="mr-2 size-4" aria-hidden="true" /> Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={signOut}>
            <LogOut className="mr-2 size-4" aria-hidden="true" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
