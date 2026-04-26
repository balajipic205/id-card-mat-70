import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
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
  const { isAdmin } = useRoles();
  const navigate = useNavigate();
  const router = useRouter();

  const links = isAdmin
    ? [...baseLinks, { to: "/attendance" as const, label: "Attendance" }]
    : baseLinks;

  async function signOut() {
    await supabase.auth.signOut();
    router.invalidate();
    navigate({ to: "/login" });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="gradient-bar w-full animate-shimmer" />
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <Link to="/" className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-gradient-spider font-mono text-sm font-bold text-primary-foreground shadow-glow-pink">
            M7
          </div>
          <div>
            <div className="font-display text-sm font-bold tracking-tight">
              <span className="text-gradient-spider">MAKE-A-THON 7.0</span>
            </div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Operations Console
            </div>
          </div>
        </Link>
        <nav className="flex items-center gap-1">
          {links.map((l) => {
            const active = loc.pathname === l.to;
            return (
              <Link
                key={l.to}
                to={l.to}
                className={
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-all " +
                  (active
                    ? "bg-gradient-spider text-primary-foreground shadow-glow-pink"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {l.label}
              </Link>
            );
          })}
          {user ? (
            <div className="ml-3 flex items-center gap-2 border-l border-border pl-3">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {user.email}
              </span>
              <Button size="sm" variant="outline" onClick={signOut}>
                Sign out
              </Button>
            </div>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
