import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="border-t border-border bg-card">
      <div className="px-4 md:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} Knowledge Base. Built with Base44.
        </p>
        <nav className="flex items-center gap-5 text-sm">
          <Link to="/about" className="text-muted-foreground hover:text-foreground transition-colors">About</Link>
          <Link to="/contact" className="text-muted-foreground hover:text-foreground transition-colors">Contact</Link>
        </nav>
      </div>
    </footer>
  );
}