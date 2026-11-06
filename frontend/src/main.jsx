import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './hooks/useAuth';
import { ToastProvider } from './hooks/useToast';
import { BillingProvider } from './hooks/useBilling';
import ErrorBoundary from './components/ErrorBoundary';
import { API_BASE } from './services/api';
import './index.css';

// A free API host sleeps when idle; this starts waking it while the person is still typing their password.
fetch(`${API_BASE}/api/health/live`, { cache: 'no-store' }).catch(() => {});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <BillingProvider><ErrorBoundary><App /></ErrorBoundary></BillingProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
