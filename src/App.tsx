import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom"
import { DashboardLayout } from "./components/DashboardLayout"
import UserSettingsPage from "./pages/Settings"
import OrganizationSettingsPage from "./pages/admin/OrganizationSettings"
import OrganizationsPage from "./pages/admin/Organizations"
import { LanguageProvider } from "./lib/i18n/language-context"
import LoginPage from "./pages/Login/Login"

function App() {
  return (
    <LanguageProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          {/* Protected Dashboard Routes */}
          <Route element={<DashboardLayout />}>
            <Route path="/dashboard" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2 text-primary">Healthcare Overview Dashboard</div>} />
            <Route path="/dashboard/admin" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Admin Dashboard Placeholder</div>} />
            <Route path="/dashboard/provider" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Provider Dashboard Placeholder</div>} />
            <Route path="/dashboard/patient" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Patient Dashboard Placeholder</div>} />
            <Route path="/dashboard/frontdesk" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Front Desk Dashboard Placeholder</div>} />

            {/* Support pages matching sidebar links */}
            <Route path="/patient/dashboard" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2 text-blue-800">Patient Dashboard Placeholder</div>} />
            <Route path="/appointments" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Appointments List</div>} />
            <Route path="/patients" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Patient Records</div>} />
            <Route path="/medical-records" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">Medical Records View</div>} />
            <Route path="/notifications" element={<div className="p-8 font-semibold text-2xl animate-in fade-in slide-in-from-bottom-2">System Notifications</div>} />

            {/* Real Settings Pages */}
            <Route path="/settings" element={<UserSettingsPage />} />
            <Route path="/admin/settings/organization" element={<OrganizationSettingsPage />} />
            <Route path="/Allorganizations" element={<OrganizationsPage />} />

            <Route path="/admin/users" element={<div className="p-8 font-bold text-2xl animate-in fade-in slide-in-from-bottom-2">User Management</div>} />
          </Route>

          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/register" element={<div className="p-8 font-bold text-2xl">Register Placeholder</div>} />
        </Routes>
      </Router>
    </LanguageProvider>
  )
}

export default App
