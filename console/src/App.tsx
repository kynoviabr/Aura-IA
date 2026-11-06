import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import LoginPage from '@/pages/LoginPage';
import NewPasswordPage from '@/pages/NewPasswordPage';

const OverviewPage = lazy(() => import('@/pages/OverviewPage'));
const WorkspacesPage = lazy(() => import('@/pages/WorkspacesPage'));
const WorkspaceDetailPage = lazy(() => import('@/pages/WorkspaceDetailPage'));
const AppsPage = lazy(() => import('@/pages/AppsPage'));
const ProvidersPage = lazy(() => import('@/pages/ProvidersPage'));
const CreditsPage = lazy(() => import('@/pages/CreditsPage'));
const AlertsPage = lazy(() => import('@/pages/AlertsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } } });

function Loading() {
  return <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
}

function Guard() {
  const { session, me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!session || !me) return <LoginPage />;
  return <Layout />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/nova-senha" element={<NewPasswordPage />} />
                <Route element={<Guard />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="empresas" element={<WorkspacesPage />} />
                  <Route path="empresas/:id" element={<WorkspaceDetailPage />} />
                  <Route path="aplicacoes" element={<AppsPage />} />
                  <Route path="ia" element={<ProvidersPage />} />
                  <Route path="creditos" element={<CreditsPage />} />
                  <Route path="alertas" element={<AlertsPage />} />
                  <Route path="configuracoes" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
