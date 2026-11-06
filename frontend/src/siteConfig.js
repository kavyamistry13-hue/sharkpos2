// Public-site details that must be filled in by the business owner before launch. Nothing here is a secret.
// Set them as Vite env vars (VITE_*) at build time; the placeholders below are what shows until you do.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
export const site = {
  brand: 'SHARKPOS',
  supportEmail: env.VITE_SUPPORT_EMAIL || '',
  legalEntity: env.VITE_LEGAL_ENTITY || '[Legal name of the business — to be added]',
  address: env.VITE_BUSINESS_ADDRESS || '[Registered address — to be added]',
  grievanceOfficer: env.VITE_GRIEVANCE_OFFICER || '[Name of grievance officer — to be added]',
  lastUpdated: '11 October 2026',
};
