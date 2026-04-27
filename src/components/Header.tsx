import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { useAuth } from "@/lib/use-auth";
import { useRoles } from "@/lib/use-roles";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";

const baseLinks = [
  { to: "/", label: "Editor" },
  { to: "/generate", label: "Generate" },
  { to: "/export", label: "Export" },
] as const;

export function Header() {
  const loc = useLocation();
  const { user } = useAuth();
  const { isAdmin, isStaff } = useRoles();
  const navigate = useNavigate();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const links = [
    ...baseLinks,
    ...(isStaff ? [{ to: "/attendance" as const, label: "Attendance" }] : []),
    ...(isStaff ? [{ to: "/dashboard" as const, label: "Dashboard" }] : []),
    ...(isAdmin ? [{ to: "/sessions" as const, label: "Sessions" }] : []),
  ];

  async function signOut() {
    await supabase.auth.signOut();
    router.invalidate();
    navigate({ to: "/login" });
  }

  function linkClass(active: boolean) {
    return (
      "rounded-md px-3 py-1.5 text-sm font-medium transition-all " +
      (active
        ? "bg-gradient-spider text-primary-foreground shadow-glow-pink"
        : "text-muted-foreground hover:bg-muted hover:text-foreground")
    );
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="gradient-bar w-full animate-shimmer" />
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-md bg-gradient-spider font-mono text-sm font-bold text-primary-foreground shadow-glow-pink">
            M7
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-xs font-bold tracking-tight sm:text-sm">
              <span className="text-gradient-spider">MAKE-A-THON 7.0</span>
            </div>
            <div className="hidden text-[10px] uppercase tracking-widest text-muted-foreground sm:block sm:text-[11px]">
              Operations Console
            </div>
          </div>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className={linkClass(loc.pathname === l.to)}>
              {l.label}
            </Link>
          ))}
          {user ? (
            <div className="ml-2 flex items-center gap-2 border-l border-border pl-2">
              <span className="hidden max-w-[160px] truncate text-xs text-muted-foreground xl:inline">
                {user.email}
              </span>
              <Button size="sm" variant="outline" onClick={signOut}>
                Sign out
              </Button>
            </div>
          ) : null}
        </nav>

        {/* Mobile toggle */}
        <button
          type="button"
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
          className="grid h-9 w-9 place-items-center rounded-md border border-border text-foreground lg:hidden"
        >
          {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </div>

      {/* Mobile menu panel */}
      {open ? (
        <div className="border-t border-border bg-background/95 px-4 py-3 lg:hidden">
          <nav className="flex flex-col gap-1">
            {links.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                onClick={() => setOpen(false)}
                className={linkClass(loc.pathname === l.to) + " w-full"}
              >
                {l.label}
              </Link>
            ))}
            {user ? (
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                <Button size="sm" variant="outline" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            ) : null}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
