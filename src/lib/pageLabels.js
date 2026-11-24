// Human page names for the Help assistant's context — so it knows what the
// admin is looking at without reading the DOM.

const PAGE_LABELS = {
  '/': 'Home',
  '/library': 'Knowledge',
  '/chat': 'AI Assistant',
  '/my-questions': 'My Questions',
  '/overview': 'Overview',
  '/knowledge': 'Knowledge (admin)',
  '/processes': 'Processes',
  '/assistant': 'Assistant settings',
  '/company': 'Company & Team',
  '/connections': 'Connections',
  '/continuity': 'Operational Continuity',
  '/roadmap': 'Product Strategy Engine',
  '/admin': 'Platform settings',
  '/setup': 'Getting Started',
  '/manage': 'Manage',
  '/team': 'Team',
  '/about': 'About',
  '/contact': 'Contact',
  '/connect': 'Connect',
};

export function pageLabelFor(pathname = '') {
  const path = String(pathname || '').split('#')[0].split('?')[0];
  if (PAGE_LABELS[path]) return PAGE_LABELS[path];
  if (path.startsWith('/training/')) return 'Knowledge source detail';
  return '';
}