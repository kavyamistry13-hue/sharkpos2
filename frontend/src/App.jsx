import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import AppLayout from './layouts/AppLayout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import PublicLayout from './pages/public/PublicLayout';
const Landing = lazy(() => import('./pages/public/Landing'));
const Pricing = lazy(() => import('./pages/public/Pricing'));
const Legal = lazy(() => import('./pages/public/Legal'));
const Contact = lazy(() => import('./pages/public/Contact'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Pos = lazy(() => import('./pages/Pos'));
const Products = lazy(() => import('./pages/Products'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Purchasing = lazy(() => import('./pages/Purchasing'));
const Sales = lazy(() => import('./pages/Sales'));
const Customers = lazy(() => import('./pages/Customers'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Copilot = lazy(() => import('./pages/Copilot'));
const Risk = lazy(() => import('./pages/Risk'));
const Employees = lazy(() => import('./pages/Employees'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Why = lazy(() => import('./pages/Why'));
const Present = lazy(() => import('./pages/Present'));
import Register from './pages/Register';
const Audit = lazy(() => import('./pages/Audit'));
const Udhaar = lazy(() => import('./pages/Udhaar'));
const Closing = lazy(() => import('./pages/Closing'));
const Shifts = lazy(() => import('./pages/Shifts'));
const Intelligence = lazy(() => import('./pages/Intelligence'));
const Billing = lazy(() => import('./pages/Billing'));
const Platform = lazy(() => import('./pages/Platform'));

function Guard({ roles, children }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="grid h-full place-items-center"><Spinner className="size-8" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={home(user)} replace />;
  return children;
}

const home = (u) => (u.role === 'cashier' ? '/pos' : u.role === 'platform_admin' ? '/platform' : '/dashboard');

export default function App() {
  const { user, ready } = useAuth();
  const mgr = ['business_owner', 'manager'];
  return (
    <Suspense fallback={<div className="grid h-full place-items-center p-10"><Spinner className="size-8" /></div>}>
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={!ready ? <div className="grid place-items-center p-20"><Spinner className="size-8" /></div> : user ? <Navigate to={home(user)} replace /> : <Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/terms" element={<Legal doc="terms" />} />
        <Route path="/privacy" element={<Legal doc="privacy" />} />
        <Route path="/refunds" element={<Legal doc="refunds" />} />
      </Route>
      <Route path="/login" element={ready && user ? <Navigate to={home(user)} replace /> : <Login />} />
      <Route path="/register" element={ready && user ? <Navigate to={home(user)} replace /> : <Register />} />
      <Route path="/platform" element={<Guard roles={['platform_admin']}><Platform /></Guard>} />
      <Route path="/present" element={<Guard roles={mgr}><Present /></Guard>} />
      <Route element={<Guard><AppLayout /></Guard>}>
        <Route path="/dashboard" element={<Guard roles={mgr}><Dashboard /></Guard>} />
        <Route path="/pos" element={<Pos />} />
        <Route path="/products" element={<Guard roles={mgr}><Products /></Guard>} />
        <Route path="/inventory" element={<Guard roles={mgr}><Inventory /></Guard>} />
        <Route path="/purchasing" element={<Guard roles={mgr}><Purchasing /></Guard>} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/udhaar" element={<Guard roles={mgr}><Udhaar /></Guard>} />
        <Route path="/closing" element={<Guard roles={mgr}><Closing /></Guard>} />
        <Route path="/shifts" element={<Shifts />} />
        <Route path="/intelligence" element={<Guard roles={mgr}><Intelligence /></Guard>} />
        <Route path="/customers" element={<Guard roles={mgr}><Customers /></Guard>} />
        <Route path="/analytics" element={<Guard roles={mgr}><Analytics /></Guard>} />
        <Route path="/copilot" element={<Guard roles={mgr}><Copilot /></Guard>} />
        <Route path="/risk" element={<Guard roles={mgr}><Risk /></Guard>} />
        <Route path="/employees" element={<Guard roles={mgr}><Employees /></Guard>} />
        <Route path="/audit" element={<Guard roles={['business_owner']}><Audit /></Guard>} />
        <Route path="/billing" element={<Guard roles={['business_owner']}><Billing /></Guard>} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/why" element={<Why />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? home(user) : '/'} replace />} />
    </Routes>
    </Suspense>
  );
}
