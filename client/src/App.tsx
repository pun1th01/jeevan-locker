import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AuthBootstrap from './components/auth/AuthBootstrap';
import Layout from './components/layout/Layout';
import ProtectedRoute from './components/routing/ProtectedRoute';
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';
import AdminDashboard from './pages/dashboard/AdminDashboard';
import DashboardRedirect from './pages/dashboard/DashboardRedirect';
import DoctorDashboard from './pages/dashboard/DoctorDashboard';
import LabDashboard from './pages/dashboard/LabDashboard';
import PatientDashboard from './pages/dashboard/PatientDashboard';
import Landing from './pages/Landing';

function App() {
  return (
    <BrowserRouter>
      <AuthBootstrap>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Landing />} />
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />
            <Route
              path="dashboard"
              element={
                <ProtectedRoute>
                  <DashboardRedirect />
                </ProtectedRoute>
              }
            />
            <Route
              path="dashboard/patient"
              element={
                <ProtectedRoute allowedRoles={['patient']}>
                  <PatientDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="dashboard/doctor"
              element={
                <ProtectedRoute allowedRoles={['doctor']}>
                  <DoctorDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="dashboard/admin"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="dashboard/lab"
              element={
                <ProtectedRoute allowedRoles={['lab']}>
                  <LabDashboard />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthBootstrap>
    </BrowserRouter>
  );
}

export default App;
