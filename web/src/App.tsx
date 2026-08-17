import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import SubmissionsPage from "./pages/SubmissionsPage";
import SubmissionDetailPage from "./pages/SubmissionDetailPage";
import SubmissionPhotoEvidencePage from "./pages/SubmissionPhotoEvidencePage";
import AdminUsersPage from "./pages/AdminUsersPage";
import RoadInventoryPage from "./pages/RoadInventoryPage";
import SettingsPage from "./pages/SettingsPage";
import IncidentsPage from "./pages/IncidentsPage";
import AssessmentsPage from "./pages/AssessmentsPage";
import MissionCenterPage from "./pages/MissionCenterPage";
import { AuthProvider } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import RoleRoute from "./auth/RoleRoute";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/submissions" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/submissions"
            element={
              <ProtectedRoute>
                <SubmissionsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/incidents"
            element={
              <ProtectedRoute>
                <IncidentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/assessments"
            element={
              <ProtectedRoute>
                <AssessmentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/mission-center"
            element={
              <ProtectedRoute>
                <MissionCenterPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/submissions/:id/photo-evidence"
            element={
              <ProtectedRoute>
                <SubmissionPhotoEvidencePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/submissions/:id"
            element={
              <ProtectedRoute>
                <SubmissionDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RoleRoute roles={["ADMIN"]}>
                <AdminUsersPage />
              </RoleRoute>
            }
          />
          <Route
            path="/admin/road-inventory"
            element={
              <RoleRoute roles={["ADMIN"]}>
                <RoadInventoryPage />
              </RoleRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
