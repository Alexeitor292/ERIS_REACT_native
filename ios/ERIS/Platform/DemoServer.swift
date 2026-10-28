#if DEBUG
import ERISKit
import Foundation
import UIKit

/// Debug builds only: run the app against built-in sample data, with no
/// sign-in and no network, to check screens in the simulator. Start it with the
/// launch argument `-ERISDemo YES` (add `-ERISDemoRoles OFFICE_CHIEF,STAFF` to
/// try other roles; the default is ADMIN). This file is compiled out of Release
/// builds, so the Intune build cannot enter demo mode.
enum DemoServer {
    static var isEnabled: Bool { UserDefaults.standard.bool(forKey: "ERISDemo") }

    static var roles: [String] {
        let value = UserDefaults.standard.string(forKey: "ERISDemoRoles") ?? "ADMIN"
        return value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    static func makeClient() -> APIClient {
        APIClient(baseURL: URL(string: "https://demo.eris.invalid/api")!, store: MemorySessionStore(token: "demo"),
                  transport: DemoTransport(roles: roles))
    }
}

/// Answers API requests from sample data. Workflow steps change the sample
/// assessments so a whole hand-off can be clicked through.
final class DemoTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let roles: [String]
    private var assessments: [[String: Any]]
    private var events: [Int: [[String: Any]]] = [:]
    private var nextEventId = 100
    private var gisa: [String: Any] = DemoData.gisa
    private var submissionActions: [String: Any] = ["immediate": [], "follow_up": []]
    private var incidentTypes: [String] = ["HEAVING"]
    /// Photos filed on the demo form: attachment record, image bytes, capture data.
    private var photos: [(record: [String: Any], data: Data, capture: [String: Any])] = [DemoData.samplePhoto]
    private var corrections: [Int: [String: Any]] = [:]
    private var nextAttachmentId = 900
    private var cracks: [[String: Any]] = [DemoData.sampleCrack]
    private var nextCrackId = 60

    init(roles: [String]) {
        self.roles = roles
        assessments = DemoData.assessments
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await Task.sleep(nanoseconds: 150_000_000)
        let url = request.url!
        let path = url.path.hasPrefix("/api") ? String(url.path.dropFirst(4)) : url.path
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let (status, object) = lock.locked {
            if request.httpMethod == "POST", path == "/submissions/501/attachments" {
                return upload(request, sectionKey: query.first { $0.name == "section_key" }?.value)
            }
            return route(request.httpMethod ?? "GET", path, query, body)
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        return (data, response)
    }

    private func route(_ method: String, _ path: String, _ query: [URLQueryItem], _ body: [String: Any]) -> (Int, Any) {
        let parts = path.split(separator: "/").map(String.init)
        // Split in two: as one switch it took the type checker too long for CI.
        if let answer = formPhotoAndCrackRoute(method, parts, body) { return answer }
        switch (method, parts) {
        case ("GET", ["auth", "me"]):
            return (200, DemoData.me(roles: roles))
        case ("GET", ["auth", "config"]):
            return (200, ["local_login_enabled": false, "entra_enabled": true, "entra_mobile": NSNull()])
        case ("POST", ["auth", "logout"]), ("POST", ["notifications", "devices", "unregister"]):
            return (200, [:])
        case ("GET", ["notifications", "unread"]):
            return (200, ["unread": 2])
        case ("GET", ["notifications"]):
            return (200, DemoData.feed)
        case ("POST", ["notifications", "read"]):
            return (200, ["unread": 0])
        case ("GET", ["incidents"]):
            return (200, ["items": DemoData.incidents])
        case ("GET", let p) where p.count == 2 && p[0] == "incidents":
            return DemoData.incidents.first { "\($0["id"]!)" == p[1] }.map { (200, $0) } ?? notFound
        case ("GET", ["submissions"]):
            return (200, ["items": DemoData.submissions])
        case ("GET", let p) where p.count == 2 && p[0] == "submissions":
            return p[1] == "501" ? (200, submissionDetail) : notFound
        case ("POST", ["submissions", "501", "gisa", "elevation-profile"]):
            let bearing = body["road_bearing_deg"] as? Double
            let profile = DemoData.elevationProfile(bearing: bearing ?? 47.6, source: bearing == nil ? "arcgis_postmile_geometry" : "request")
            gisa["elevation_profile"] = profile
            return (200, ["elevation_profile": profile])
        case ("GET", ["gisa", "lookups"]):
            return (200, DemoData.lookups)
        case ("PATCH", ["submissions", "501", "gisa"]):
            gisa.merge(body) { _, new in new }
            return (200, ["submission_id": 501, "gisa": gisa])
        case ("PUT", ["submissions", "501", "gisa", "incident-types"]):
            incidentTypes = body["items"] as? [String] ?? []
            return (200, ["items": incidentTypes])
        case ("PUT", ["submissions", "501", "gisa", "actions"]):
            submissionActions = body
            return (200, body)
        case ("GET", ["assessments"]):
            return (200, ["items": assessments.filter { matches($0, queue: query.first { $0.name == "queue" }?.value) }])
        case ("GET", let p) where p.count == 2 && p[0] == "assessments":
            guard let id = Int(p[1]), let item = assessments.first(where: { $0["id"] as? Int == id }) else { return notFound }
            return (200, ["assessment": item, "assignments": [], "events": events[id] ?? DemoData.events(for: item)])
        case ("GET", let p) where p.count == 3 && p[0] == "assessments" && p[2] == "branch-options":
            return (200, DemoData.branchChiefOptions)
        case ("GET", let p) where p.count == 3 && p[0] == "admin" && p[1] == "assessment-assignment-options":
            return (200, DemoData.staffOptions)
        case ("POST", let p) where p.count == 3 && p[0] == "assessments":
            return step(Int(p[1]) ?? 0, p[2], body)
        default:
            return notFound
        }
    }

    private var notFound: (Int, Any) { (404, ["detail": "Not in the demo data"]) }

    /// The demo form's photo map, photo corrections, attachment links and cracks.
    private func formPhotoAndCrackRoute(_ method: String, _ parts: [String], _ body: [String: Any]) -> (Int, Any)? {
        switch (method, parts) {
        case ("GET", ["submissions", "501", "photo-map"]):
            return (200, photoMap)
        case ("PUT", let p) where p.count == 6 && p[2] == "photo-map" && p[5] == "correction":
            guard let id = Int(p[4]) else { return notFound }
            corrections[id] = body
            return (200, ["attachment_id": id, "idempotent_replay": false])
        case ("GET", let p) where p.count == 3 && p[0] == "attachments" && p[2] == "download-url":
            guard let photo = photos.first(where: { "\($0.record["id"]!)" == p[1] }) else { return notFound }
            return (200, ["download_url": "data:image/jpeg;base64,\(photo.data.base64EncodedString())"])
        case ("GET", ["submissions", "501", "cracks"]):
            return (200, ["items": cracks])
        case ("POST", ["submissions", "501", "cracks"]):
            nextCrackId += 1
            var crack: [String: Any] = ["id": nextCrackId, "submission_id": 501, "client_uuid": body["client_uuid"] ?? "",
                                        "sort_order": cracks.count + 1, "revision": 1, "created_by_user_id": DemoData.meId,
                                        "created_by_name": "Demo User"]
            for (key, value) in body where key != "client_uuid" { crack[key] = value }
            cracks.append(crack)
            gisa["pavement_ground_cracks"] = 1
            return (201, ["crack": crack, "idempotent_replay": false])
        case ("PATCH", let p) where p.count == 4 && p[2] == "cracks":
            guard let index = cracks.firstIndex(where: { "\($0["id"]!)" == p[3] }) else { return notFound }
            guard body["revision"] as? Int == cracks[index]["revision"] as? Int else {
                return (409, ["detail": ["message": "Someone else saved this crack after you opened it.", "crack": cracks[index]]])
            }
            for (key, value) in body where key != "revision" { cracks[index][key] = value }
            cracks[index]["revision"] = (cracks[index]["revision"] as? Int ?? 1) + 1
            return (200, ["crack": cracks[index]])
        case ("DELETE", let p) where p.count == 4 && p[2] == "cracks":
            cracks.removeAll { "\($0["id"]!)" == p[3] }
            return (200, ["deleted": Int(p[3]) ?? 0])
        default:
            return nil
        }
    }

    /// A multipart upload: the file and, for a photo, its capture data.
    private func upload(_ request: URLRequest, sectionKey: String?) -> (Int, Any) {
        let contentType = request.value(forHTTPHeaderField: "Content-Type") ?? ""
        guard let boundary = contentType.components(separatedBy: "boundary=").last, let body = request.httpBody else {
            return (400, ["detail": "Expected a multipart upload"])
        }
        var file = Data(), fileName = "upload.jpg", capture: [String: Any] = [:]
        for part in body.split(separator: Data("--\(boundary)".utf8)) {
            guard let headerEnd = part.range(of: Data("\r\n\r\n".utf8)) else { continue }
            let header = String(decoding: part[part.startIndex..<headerEnd.lowerBound], as: UTF8.self)
            var content = Data(part[headerEnd.upperBound...])
            if content.suffix(2) == Data("\r\n".utf8) { content.removeLast(2) }
            if header.contains("name=\"capture_metadata_json\"") {
                capture = (try? JSONSerialization.jsonObject(with: content) as? [String: Any]) ?? [:]
            } else if header.contains("name=\"file\"") {
                file = content
                if let range = header.range(of: "filename=\"") {
                    fileName = String(header[range.upperBound...].prefix { $0 != "\"" })
                }
            }
        }
        nextAttachmentId += 1
        let record: [String: Any] = ["id": nextAttachmentId, "file_name": fileName, "mime_type": "image/jpeg",
                                     "kind": "PHOTO", "section_key": sectionKey as Any? ?? NSNull()]
        photos.append((record, file, capture))
        return (200, ["attachment_id": nextAttachmentId, "section_key": sectionKey as Any? ?? NSNull(), "kind": "PHOTO"])
    }

    /// The photo map: each photo's capture data with the latest correction applied.
    private var photoMap: [String: Any] {
        let items: [[String: Any]] = photos.map { photo in
            let id = photo.record["id"] as? Int ?? 0
            var item: [String: Any] = ["attachment_id": id, "file_name": photo.record["file_name"]!,
                                       "mime_type": "image/jpeg", "section_key": photo.record["section_key"]!,
                                       "source_scope": "SUBMISSION", "can_edit_correction": true,
                                       "download_url": "data:image/jpeg;base64,\(photo.data.base64EncodedString())"]
            for key in ["captured_at", "latitude", "longitude", "horizontal_accuracy_m", "camera_heading_deg",
                        "camera_heading_accuracy_code", "location_source", "heading_source"] {
                item[key] = photo.capture[key] ?? NSNull()
            }
            if let correction = corrections[id] {
                let location = correction["location_override"] as? [String: Any]
                let heading = correction["heading_override_deg"] as? Double
                if let location {
                    item["latitude"] = location["latitude"]
                    item["longitude"] = location["longitude"]
                    item["horizontal_accuracy_m"] = NSNull()
                    item["location_source"] = "MANUAL"
                }
                if let heading {
                    item["camera_heading_deg"] = heading
                    item["heading_source"] = "MANUAL"
                }
                item["correction"] = ["has_history": true, "location_overridden": location != nil,
                                      "heading_overridden": heading != nil, "location_override": location as Any? ?? NSNull(),
                                      "heading_override_deg": heading as Any? ?? NSNull()]
            }
            return item
        }
        return ["submission_id": 501, "can_edit_corrections": true, "photos": items]
    }

    private var submissionDetail: [String: Any] {
        ["submission": ["id": 501, "created_by_user_id": DemoData.meId, "status": "DRAFT",
                        "title": "I-880 slope failure GISA", "created_at": "2026-10-28T09:00:00",
                        "updated_at": "2026-10-28T09:00:00", "can_edit": true, "can_review": false],
         "gisa": gisa, "incident_types": incidentTypes, "actions": submissionActions, "cracks": cracks,
         "photos": photos.map(\.record), "attachments": photos.map(\.record), "workflow_events": []]
    }

    private func matches(_ item: [String: Any], queue: String?) -> Bool {
        let state = item["state"] as? String
        switch queue {
        case "office_chief": return state == "PENDING_OFFICE_DELEGATION"
        case "branch_chief": return state == "PENDING_ENGINEER_ASSIGNMENT" && item["routing_path"] as? String == "BRANCH"
        case "engineer", "assignee": return item["assigned_engineer_user_id"] as? Int == DemoData.meId
        case "reviewer": return state == "SUBMITTED"
        default: return true
        }
    }

    /// A workflow step, applied to the sample assessment with a timeline entry.
    private func step(_ id: Int, _ action: String, _ body: [String: Any]) -> (Int, Any) {
        guard let index = assessments.firstIndex(where: { $0["id"] as? Int == id }) else { return notFound }
        var item = assessments[index]
        let from = item["state"] as? String ?? ""
        switch action {
        case "delegate-branch":
            item["state"] = "PENDING_ENGINEER_ASSIGNMENT"
            item["routing_path"] = "BRANCH"
            item["branch_chief_user_id"] = body["branch_chief_user_id"]
            item["routed_branch_id"] = 3
            item["routed_branch_name"] = "Branch C"
        case "assign-engineer":
            item["state"] = "DRAFT"
            item["assigned_engineer_user_id"] = body["engineer_user_id"]
        case "submit":
            item["state"] = "SUBMITTED"
            item["can_review"] = true
        case "review":
            item["state"] = body["action"] as? String == "APPROVE" ? "APPROVED" : "REVISION_REQUESTED"
        default:
            return notFound
        }
        assessments[index] = item
        var history = events[id] ?? DemoData.events(for: assessments[index])
        nextEventId += 1
        history.append(["id": nextEventId, "incident_id": item["incident_id"]!, "actor_user_id": DemoData.meId,
                        "actor_name": "Demo User", "event_type": action.uppercased().replacingOccurrences(of: "-", with: "_"),
                        "from_state": from, "to_state": item["state"]!, "notes": body["notes"] ?? NSNull(),
                        "created_at": "2026-10-28T12:00:00Z"])
        events[id] = history
        return (200, ["assessment": item])
    }
}

/// Sample records, in the shapes the server returns.
enum DemoData {
    static let meId = 41

    static func me(roles: [String]) -> [String: Any] {
        ["id": meId, "email": "demo.user@dot.ca.gov", "full_name": "Demo User", "roles": roles,
         "maintenance_districts": [],
         "org": ["office_name": "Office of Geotechnical Design West", "office_short_name": "OGD West",
                 "branch_name": "Branch C", "home_district": "04", "job_title": "Transportation Engineer"]]
    }

    static let feed: [String: Any] = [
        "unread": 2,
        "items": [
            ["id": 1, "kind": "ASSESSMENT_ASSIGNED", "title": "Assessment #3 is waiting for a Staff member",
             "body": "Incident #12, Branch C", "link": "/assessments/3", "actor": "Office Chief",
             "created_at": "2026-10-28T08:15:00Z", "read": false],
            ["id": 2, "kind": "INCIDENT_CREATED", "title": "New incident reported on I-880",
             "body": "Slope failure near PM 12.3", "link": "/incidents/12", "actor": "Maintenance Crew",
             "created_at": "2026-10-27T16:40:00Z", "read": false],
        ],
    ]

    static let incidents: [[String: Any]] = [
        ["id": 12, "incident_key": "INC-2026-0012", "title": "Slope failure above I-880", "incident_type": "LANDSLIDE",
         "description": "Cut slope failed onto the right shoulder after overnight rain.",
         "first_observed_at": "2026-10-27T14:05:00Z", "latitude": 37.7312, "longitude": -122.1975,
         "district": "04", "county": "ALA", "route": "880", "post_mile": "12.3", "office_code": "WEST",
         "current_stage": "BRANCH_CHIEF_REVIEW", "status": "IN_PROGRESS", "reporter_user_id": 7,
         "created_at": "2026-10-27T14:20:00Z", "updated_at": "2026-10-28T08:15:00Z"],
        ["id": 14, "incident_key": "INC-2026-0014", "title": "Rockfall on SR-1", "incident_type": "ROCKFALL",
         "description": "Rocks up to 0.5 m in the northbound lane.", "first_observed_at": "2026-10-28T06:30:00Z",
         "latitude": 37.5900, "longitude": -122.5100, "district": "04", "county": "SM", "route": "1",
         "post_mile": "38.2", "current_stage": "COORDINATOR_REVIEW", "status": "NEW", "reporter_user_id": 7,
         "created_at": "2026-10-28T06:45:00Z"],
    ]

    static let submissions: [[String: Any]] = [
        ["id": 501, "created_by_user_id": meId, "status": "DRAFT", "title": "I-880 slope failure GISA",
         "district": "04", "county": "ALA", "route": "880", "post_mile": "12.3", "created_at": "2026-10-28T09:00:00Z"],
    ]

    /// A crack on the sample photo, traced and labelled.
    static let sampleCrack: [String: Any] = [
        "id": 51, "submission_id": 501, "client_uuid": "6f1c2a3e-0000-4000-8000-000000000051", "sort_order": 1,
        "label": "NB shoulder", "latitude": 37.73135, "longitude": -122.19731, "location_source": "PHOTO",
        "trend_deg": 75.0, "orientation": "TRANSVERSE", "length_ft": 12.5, "width_in": 0.75,
        "horizontal_disp_in": NSNull(), "vertical_disp_in": 1.5, "depth_in": 6.0, "notes": "Opened since last week.",
        "photo_attachment_id": 801, "revision": 1, "created_by_user_id": meId, "created_by_name": "Demo User",
        "annotations_json": ["version": 1, "shapes": [
            ["type": "path", "points": [[0.15, 0.70], [0.325, 0.633], [0.4125, 0.75], [0.5875, 0.667], [0.7, 0.783], [0.875, 0.717]]],
            ["type": "label", "at": [0.5, 0.55], "measure": "length_ft"],
        ]],
    ]

    /// A field photo filed under Material, facing south-east.
    static var samplePhoto: (record: [String: Any], data: Data, capture: [String: Any]) {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600)).image { context in
            UIColor(red: 0.55, green: 0.47, blue: 0.36, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
            UIColor(red: 0.42, green: 0.62, blue: 0.85, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 800, height: 220))
            UIColor.darkGray.setStroke()
            let crack = UIBezierPath()
            crack.move(to: CGPoint(x: 120, y: 420))
            for point in [(260, 380), (330, 450), (470, 400), (560, 470), (700, 430)] {
                crack.addLine(to: CGPoint(x: point.0, y: point.1))
            }
            crack.lineWidth = 6
            crack.stroke()
        }
        return (["id": 801, "file_name": "field-photo-sample.jpg", "mime_type": "image/jpeg", "kind": "PHOTO",
                 "section_key": "material"],
                image.jpegData(compressionQuality: 0.8) ?? Data(),
                ["captured_at": "2026-10-28T09:20:00", "latitude": 37.73135, "longitude": -122.19731,
                 "horizontal_accuracy_m": 4.0, "camera_heading_deg": 135.0, "camera_heading_accuracy_code": 3,
                 "location_source": "DEVICE_AT_CAPTURE", "heading_source": "DEVICE_TRUE_HEADING"])
    }

    /// A saved GISA row: DECIMAL columns as numbers and flags as 0/1, as the server sends them.
    static let gisa: [String: Any] = [
        "report_date": "2026-10-27", "district": "04", "county": "ALA", "route": "880", "post_mile": "12.3",
        "date_incident_reported": "2026-10-27", "latitude": 37.7312, "longitude": -122.1975,
        "district_contact": "[{\"first_name\":\"Ana\",\"last_name\":\"Ruiz\",\"s_number\":\"S1234\",\"phone\":\"510-555-0100\",\"cell_phone\":\"\"}]",
        "failure_slide": 1, "material_soil": 1, "est_clay_pct": 40.0, "est_silt_pct": 60.0, "vegetation_trees": 30.0,
        "pavement_ground_cracks": 1, "settlement_in": 2.0,
        "geotechnical_assessment_notes": "Cut slope failure onto the shoulder.",
        "measure_slope_height_ft": 32.0, "measure_original_slope_deg": 34.0,
        "road_inventory_context": roadInventoryContext,
        "elevation_profile": elevationProfile(bearing: 47.6, source: "arcgis_postmile_geometry"),
    ]

    // Literals are typed and kept small: mixed-type ones are slow for Xcode 16's type checker in CI.
    static let roadInventorySnapshot: [String: Any] = [
        "county_code": "ALA", "route_name": "880", "begin_pm": 11.2, "end_pm": 13.0,
        "terrain_code": "R", "left_lanes": 4, "right_lanes": 4,
    ]
    static let roadInventoryContext: [String: Any] = [
        "dataset_version_id": 3, "segment_id": 812, "match_method": "nearest_segment",
        "checked_at": "2026-10-27 15:05:00", "snapshot": roadInventorySnapshot,
    ]

    /// Ground across the road: a cut slope rising on the right.
    static func elevationProfile(bearing: Double, source: String) -> [String: Any] {
        var points: [[String: Any]] = []
        for offset in stride(from: -30.0, through: 30.0, by: 5.0) {
            let rise: Double = offset > 0 ? offset * 0.9 : offset * 0.1
            let elevation: Double = 40 + rise
            var point: [String: Any] = ["offset_m": offset, "lat": 37.7312, "lon": -122.1975]
            point["source"] = "usgs_3dep"
            point["elevation_ft"] = elevation
            points.append(point)
        }
        var metadata: [String: Any] = ["road_bearing_deg_used": bearing, "road_bearing_source": source]
        metadata["half_width_m"] = 30
        metadata["spacing_m"] = 5
        metadata["classification_requires_bearing"] = true
        let profile: [String: Any] = ["points": points, "metadata": metadata]
        var out: [String: Any] = ["source": "usgs_3dep", "checked_at": "2026-10-27 15:05:00", "classification": "CUT"]
        out["classification_reason"] = NSNull()
        out["confidence"] = 0.82
        out["error"] = NSNull()
        out["profile"] = profile
        return out
    }

    static let lookups: [String: Any] = [
        // As backend/app/constants/gisa_lookups.py lists them.
        "distribution": [["code": "ADVANCING", "label": "Advancing"], ["code": "RETROGRESSING", "label": "Retrogressing"],
                         ["code": "ENLARGING", "label": "Enlarging"], ["code": "WIDENING", "label": "Widening"],
                         ["code": "MOVING", "label": "Moving"], ["code": "CONFINED", "label": "Confined"]],
        "highway_status": [["code": "OPEN", "label": "Open"], ["code": "SHOULDER_CLOSED", "label": "Shoulder Closed"],
                           ["code": "LANES_CLOSED", "label": "Lane(s) Closed"],
                           ["code": "ONE_WAY_CLOSED", "label": "One-way Closed"],
                           ["code": "TWO_WAY_CLOSED", "label": "Two-way Closed"]],
        "incident_types": [["code": "SLIDE", "label": "Slide"], ["code": "HEAVING", "label": "Heaving"]],
        "actions": ["immediate": [["code": "CLOSE_LANE", "label": "Close lane"]],
                    "follow_up": [["code": "MONITOR", "label": "Monitor"]]],
        "requested_by_user_id": meId,
    ]

    static let assessments: [[String: Any]] = [
        assessment(3, incident: 12, state: "PENDING_OFFICE_DELEGATION", path: nil),
        assessment(4, incident: 14, state: "PENDING_ENGINEER_ASSIGNMENT", path: "BRANCH", branch: "Branch C"),
        assessment(5, incident: 9, state: "DRAFT", path: "BRANCH", branch: "Branch C", assignee: meId, submission: 501),
        assessment(6, incident: 8, state: "SUBMITTED", path: "SENIOR_ENGINEER", assignee: 52, canReview: true),
        assessment(7, incident: 5, state: "APPROVED", path: "BRANCH", branch: "Branch A", assignee: 44),
    ]

    private static func assessment(_ id: Int, incident: Int, state: String, path: String?, branch: String? = nil,
                                   assignee: Int? = nil, submission: Int? = nil, canReview: Bool = false) -> [String: Any] {
        ["id": id, "assessment_uuid": "demo-\(id)", "incident_id": incident, "submission_id": submission ?? NSNull(),
         "district": "04", "office_code": "WEST", "routed_office_name": "Office of Geotechnical Design West",
         "routed_branch_id": branch == nil ? NSNull() : 3, "routed_branch_name": branch ?? NSNull(),
         "routing_path": path ?? NSNull(), "assigned_engineer_user_id": assignee ?? NSNull(),
         "can_review": canReview, "state": state, "created_by_user_id": 2,
         "created_at": "2026-10-27T15:00:00Z", "updated_at": "2026-10-28T08:15:00Z"]
    }

    static func events(for item: [String: Any]) -> [[String: Any]] {
        [["id": (item["id"] as? Int ?? 0) * 10, "incident_id": item["incident_id"]!, "actor_user_id": 2,
          "actor_name": "Coordinator", "event_type": "TRIAGED", "disposition": "ASSESSMENT_REQUIRED",
          "from_state": NSNull(), "to_state": "PENDING_OFFICE_DELEGATION", "notes": "Needs a geotechnical look.",
          "created_at": "2026-10-27T15:00:00Z"]]
    }

    static let branchChiefOptions: [String: Any] = [
        "assessment_id": 3, "office_code": "WEST",
        "groups": [
            group("b:1", "Branch A", id: 1, letter: "A", city: "Oakland"),
            group("b:3", "Branch C", id: 3, letter: "C", city: "San Jose"),
            group("b:5", "Branch E", id: 5, letter: "E", city: "Sacramento", accepts: false),
        ],
        "items": [
            person(21, "M. Okafor", branch: 1, letter: "A", city: "Oakland", open: 6, waiting: 1),
            person(23, "L. Chen", branch: 3, letter: "C", city: "San Jose", open: 3, waiting: 0,
                   availability: "ROTATION_OUT", until: "2027-02-05"),
            person(25, "R. Duarte", branch: 5, letter: "E", city: "Sacramento", open: 0, waiting: 0),
        ],
    ]

    static let staffOptions: [String: Any] = [
        "assessment_id": 4, "office_code": "WEST", "kind": "ENGINEER",
        "groups": [group("b:3", "Branch C", id: 3, letter: "C", city: "San Jose"),
                   group("b:1", "Branch A", id: 1, letter: "A", city: "Oakland")],
        "items": [
            person(meId, "Demo User", branch: 3, letter: "C", city: "San Jose", open: 2, waiting: 1),
            person(44, "A. Rivera", branch: 3, letter: "C", city: "San Jose", open: 4, waiting: 0),
            person(46, "B. Nakamura", branch: 1, letter: "A", city: "Oakland", open: 1, waiting: 0),
        ],
    ]

    private static func group(_ key: String, _ label: String, id: Int, letter: String, city: String,
                              accepts: Bool = true) -> [String: Any] {
        ["group_key": key, "label": label, "branch_id": id, "branch_letter": letter, "branch_name": label,
         "home_city": city, "home_district": "04", "accepts_assignments": accepts, "is_active": true]
    }

    private static func person(_ id: Int, _ name: String, branch: Int, letter: String, city: String, open: Int,
                               waiting: Int, availability: String = "AVAILABLE", until: String? = nil) -> [String: Any] {
        ["id": id, "email": name.lowercased().replacingOccurrences(of: ". ", with: ".").replacingOccurrences(of: " ", with: ".")
            + "@dot.ca.gov",
         "full_name": name, "office_code": "WEST", "office_name": "Office of Geotechnical Design West",
         "branch_id": branch, "branch_letter": letter, "branch_name": "Branch \(letter)", "home_city": city,
         "home_district": "04", "open_assessment_count": open, "awaiting_action_count": waiting,
         "availability": availability, "available_until": until ?? NSNull(), "group_key": "b:\(branch)"]
    }
}

private extension NSLock {
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
#endif
