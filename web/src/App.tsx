import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
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
import EventGroupsPage from "./pages/EventGroupsPage";
import EventGroupDetailPage from "./pages/EventGroupDetailPage";
import TerrainCrossSectionsPage from "./pages/TerrainCrossSectionsPage";
import MyWorkPage from "./features/myWork/MyWorkPage";
import NotFoundPage from "./pages/NotFoundPage";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import RoleRoute from "./auth/RoleRoute";
import { hasWorkQueue, OPERATIONAL_ROLE_NAMES } from "./utils/roleModel";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/my-work"
            element={
              <ProtectedRoute>
                <MyWorkPage />
              </ProtectedRoute>
            }
          />
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
            path="/incidents/:id"
            element={
              <ProtectedRoute>
                <IncidentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/event-groups"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <EventGroupsPage />
              </RoleRoute>
            }
          />
          <Route
            path="/event-groups/:id"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <EventGroupDetailPage />
              </RoleRoute>
            }
          />
          <Route path="/projects" element={<Navigate to="/event-groups" replace />} />
          <Route path="/projects/:id" element={<LegacyProjectRedirect />} />
          <Route
            path="/assessments"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <AssessmentsPage />
              </RoleRoute>
            }
          />
          <Route
            path="/assessments/:id"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <AssessmentsPage />
              </RoleRoute>
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
            path="/mission-center/:gid"
            element={
              <ProtectedRoute>
                <MissionCenterPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/mission-center/:gid/:iid"
            element={
              <ProtectedRoute>
                <MissionCenterPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/gis/terrain-cross-sections"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <TerrainCrossSectionsPage />
              </RoleRoute>
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
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

/** Roles with a work queue land on My Work; maintenance reporters land on their incidents. */
function HomeRedirect() {
  const { me } = useAuth();
  return <Navigate to={hasWorkQueue(me?.roles) ? "/my-work" : "/incidents"} replace />;
}

function LegacyProjectRedirect() {
  const { id } = useParams();
  return <Navigate to={`/event-groups/${id ?? ""}`} replace />;
}
