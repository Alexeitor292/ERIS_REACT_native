import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import SubmissionsPage from "./pages/SubmissionsPage";
import SubmissionDetailPage from "./pages/SubmissionDetailPage";
import SubmissionPhotoEvidencePage from "./pages/SubmissionPhotoEvidencePage";
import AdminUsersPage from "./pages/AdminUsersPage";
import OrganizationPage from "./features/admin/org/OrganizationPage";
import RoadInventoryPage from "./pages/RoadInventoryPage";
import SettingsPage from "./pages/SettingsPage";
import IncidentsPage from "./pages/IncidentsPage";
import IncidentDetailPage from "./features/incidents/IncidentDetailPage";
import AssessmentsPage from "./pages/AssessmentsPage";
import MissionCenterPage from "./pages/MissionCenterPage";
import EventGroupsPage from "./pages/EventGroupsPage";
import EventGroupDetailPage from "./pages/EventGroupDetailPage";
import TerrainCrossSectionsPage from "./pages/TerrainCrossSectionsPage";
import MyWorkPage from "./features/myWork/MyWorkPage";
import NotFoundPage from "./pages/NotFoundPage";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import RoleRoute from "./auth/RoleRoute";
import {
  ASSESSMENT_READ_ROLE_NAMES,
  landingPathFor,
  OPERATIONAL_ROLE_NAMES,
  RECORD_READ_ROLE_NAMES,
  WORKFORCE_ROLE_NAMES,
  WORK_QUEUE_ROLE_NAMES,
} from "./utils/roleModel";

/**
 * Route gates, in three bands.
 *
 *  - OPERATIONAL: the working surface — Mission Center, Incident Groups, GIS Tools.
 *    A read-only viewer sees none of it: it is full of work in flight.
 *  - ASSESSMENT_READ / RECORD_READ: the record surface. The viewer belongs here,
 *    and the server narrows what they get to APPROVED records; the gate only
 *    decides which pages open at all.
 *  - WORK_QUEUE: My Work. A viewer has no queue, so the route refuses them
 *    rather than showing them an empty one.
 *
 * `/my-work`, `/mission-center` and `/submissions/:id` carried no role gate at
 * all before the org model — they were `ProtectedRoute`-only, which meant "any
 * account that happens to be signed in" (org model design §8).
 */
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppErrorBoundary>
        <Routes>
          <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/my-work"
            element={
              <RoleRoute roles={[...WORK_QUEUE_ROLE_NAMES]}>
                <MyWorkPage />
              </RoleRoute>
            }
          />
          <Route
            path="/submissions"
            element={
              <RoleRoute roles={[...WORKFORCE_ROLE_NAMES]}>
                <SubmissionsPage />
              </RoleRoute>
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
                <IncidentDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/incident-groups"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <EventGroupsPage />
              </RoleRoute>
            }
          />
          <Route
            path="/incident-groups/:id"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <EventGroupDetailPage />
              </RoleRoute>
            }
          />
          {/* Old addresses: Event Groups were renamed Incident Groups. */}
          <Route path="/event-groups" element={<Navigate to="/incident-groups" replace />} />
          <Route path="/event-groups/:id" element={<LegacyProjectRedirect />} />
          <Route path="/projects" element={<Navigate to="/incident-groups" replace />} />
          <Route path="/projects/:id" element={<LegacyProjectRedirect />} />
          <Route
            path="/assessments"
            element={
              <RoleRoute roles={[...ASSESSMENT_READ_ROLE_NAMES]}>
                <AssessmentsPage />
              </RoleRoute>
            }
          />
          <Route
            path="/assessments/:id"
            element={
              <RoleRoute roles={[...ASSESSMENT_READ_ROLE_NAMES]}>
                <AssessmentsPage />
              </RoleRoute>
            }
          />
          <Route
            path="/mission-center"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <MissionCenterPage />
              </RoleRoute>
            }
          />
          <Route
            path="/mission-center/:gid"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <MissionCenterPage />
              </RoleRoute>
            }
          />
          <Route
            path="/mission-center/:gid/:iid"
            element={
              <RoleRoute roles={[...OPERATIONAL_ROLE_NAMES]}>
                <MissionCenterPage />
              </RoleRoute>
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
          {/* Photos are part of the approved record (owner decision 4), and this
              page only reads — the correction write lives on the map panel and is
              refused server-side — so a viewer belongs here. */}
          <Route
            path="/submissions/:id/photo-evidence"
            element={
              <RoleRoute roles={[...RECORD_READ_ROLE_NAMES]}>
                <SubmissionPhotoEvidencePage />
              </RoleRoute>
            }
          />
          <Route
            path="/submissions/:id"
            element={
              <RoleRoute roles={[...RECORD_READ_ROLE_NAMES]}>
                <SubmissionDetailPage />
              </RoleRoute>
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
            path="/organization"
            element={
              <RoleRoute roles={["ADMIN", "OFFICE_CHIEF", "BRANCH_CHIEF"]}>
                <OrganizationPage />
              </RoleRoute>
            }
          />
          {/* The Offices, Branches and Coverage pages became the Organization page. */}
          <Route path="/admin/org/offices" element={<Navigate to="/organization" replace />} />
          <Route path="/admin/org/branches" element={<Navigate to="/organization" replace />} />
          <Route path="/admin/org/coverage" element={<Navigate to="/organization?tab=maintenance" replace />} />
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
        </AppErrorBoundary>
      </BrowserRouter>
    </AuthProvider>
  );
}

/**
 * Roles with a work queue land on My Work; maintenance reporters and read-only
 * viewers land on their incidents — a viewer has no Home and no queue, so
 * Records opening on Incidents is their destination.
 */
function HomeRedirect() {
  const { me } = useAuth();
  return <Navigate to={landingPathFor(me?.roles)} replace />;
}

function LegacyProjectRedirect() {
  const { id } = useParams();
  return <Navigate to={`/incident-groups/${id ?? ""}`} replace />;
}
