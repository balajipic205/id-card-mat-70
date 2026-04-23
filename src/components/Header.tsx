import { Link, useLocation } from "@tanstack/react-router";

const links = [
  { to: "/", label: "Editor" },
  { to: "/generate", label: "Generate Sheet" },
] as const;

export function Header() {
  const loc = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
            M7
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Makeathon 7.0</div>
            <div className="text-xs text-muted-foreground">ID Card Studio</div>
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
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                  (active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
