import ERISKit
import PhotosUI
import SwiftUI

/// The GISA editor, as in mobile/app/(tabs)/submissions/[id].tsx: five steps,
/// editable while the submission is a draft or returned and the server allows
/// it. Steps are ported one at a time; a step not yet ported shows its saved
/// values, and saving keeps them unchanged.
struct SubmissionDetailView: View {
    @EnvironmentObject private var model: AppModel
    let submissionId: Int
    @State private var detail: SubmissionDetail?
    @State private var editor: GisaEditor?
    @State private var lookups = GisaLookups.empty
    @State private var step = GisaStep.header
    @State private var error: String?
    @State private var alert: GisaEditor.SaveProblem?
    @State private var saving = false
    @State private var cameraSection: PhotoTarget?
    @State private var librarySection: String?
    @State private var libraryItem: PhotosPickerItem?
    @State private var uploadingSection: String?
    @State private var openPhoto: AttachmentRef?
    @State private var libraryForCrack = false
    /// The form's cracks: saved on their own, so kept apart from the form draft.
    @State private var cracks: [Crack] = []
    @State private var addingCrack = false
    @State private var openCrack: CrackRoute?
    /// Who else is in the form, the memos they hold, and their saves.
    @State private var presence: FormPresenceSession?
    @State private var openMemo: MemoRoute?
    @State private var sketching = false
    /// "Maria Garcia saved Project ID. Their changes are shown here."
    @State private var mergedNotice: String?
    @State private var choosingConflicts = false
    @State private var resaves = 0
    /// Notifying, submitting or deciding.
    @State private var working = false
    @State private var drafts = WorkflowDrafts()
    @State private var openAssessment: AssessmentRoute?
    /// The Gallery's own adding and opening of files.
    @State private var galleryPicking = false
    @State private var galleryItems: [PhotosPickerItem] = []
    @State private var importingFiles = false
    @State private var galleryUploading: String?
    @State private var openingFile: Int?
    @State private var previewURL: URL?

    /// The section a new photo will be filed under, and whether it starts a crack.
    /// The section a new photo will be filed under (none from the Gallery), and whether it starts a crack.
    struct PhotoTarget: Identifiable {
        let sectionKey: String?
        var forCrack = false
        var id: String { "\(sectionKey ?? "")-\(forCrack)" }
    }

    var body: some View {
        galleryFlows(photoFlows(screen)).modifier(prompts)
    }

    /// Alerts and the choice between versions, shown on the form or on an open memo.
    private var prompts: FormPrompts {
        FormPrompts(alert: $alert, choosing: $choosingConflicts, pending: editor?.pending) { theirs in
            editor?.resolve(takingTheirs: theirs)
            choosingConflicts = false
            resaves = 0
            Task { await save() }
        }
    }

    /// The assessment this form belongs to, opened from it.
    private func assessmentWiring<Content: View>(_ content: Content) -> some View {
        content.navigationDestination(item: $openAssessment) { route in
            if let me = model.me { AssessmentDetailView(assessmentId: route.id, me: me) }
        }
    }

    // The body is split into parts: as one expression it took the type
    // checker long enough to risk failing the slower Xcode 16 build in CI.

    private var screen: some View {
        Group {
            if let detail, let editor = Binding($editor) {
                content(detail, editor)
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle(detail?.submission.status == "DRAFT" ? "Draft" : "Submission")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: presence?.reply?.revision) { _, revision in
            // Someone else saved: bring their changes in.
            guard let revision, let editor, revision > editor.base.revision, !saving else { return }
            Task { await catchUp(savedBy: presence?.reply?.savedBy?.name, refused: false) }
        }
        .onChange(of: writingMemos) { _, memos in presence?.writing = memos }
    }

    /// The Gallery's library picker (photos and videos), Files, and Quick Look.
    private func galleryFlows<Screen: View>(_ screen: Screen) -> some View {
        screen
            .photosPicker(isPresented: $galleryPicking, selection: $galleryItems, maxSelectionCount: 10,
                          matching: .any(of: [.images, .videos]))
            .onChange(of: galleryItems) { _, items in
                guard !items.isEmpty else { return }
                galleryItems = []
                Task { await uploadToGallery(items) }
            }
            .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): Task { await uploadFiles(urls) }
                case .failure(let error): alert = .init(title: "Files unavailable", message: error.localizedDescription)
                }
            }
            .quickLookPreview($previewURL)
    }

    /// Opens a file: a photo with where and which way it was taken; anything
    /// else (sketches, videos, PDFs, CAD and Office files) in Quick Look.
    private func openFile(_ item: SubmissionLibrary.Item) async {
        if item.media == .photo, (item.attachment.kind ?? "PHOTO").uppercased() == "PHOTO" {
            openPhoto = item.attachment
            return
        }
        openingFile = item.id
        defer { openingFile = nil }
        do {
            previewURL = try await FileTransfer.localCopy(of: item.attachment, api: model.api)
        } catch {
            alert = .init(title: "File unavailable", message: model.handle(error))
        }
    }

    /// Photos and videos from the library, one after another.
    private func uploadToGallery(_ items: [PhotosPickerItem]) async {
        var problems: [String] = []
        for (index, item) in items.enumerated() {
            galleryUploading = items.count > 1 ? "Uploading \(index + 1) of \(items.count)…" : "Uploading…"
            do {
                if item.isVideo {
                    guard let video = try await FileTransfer.upload(fromVideo: item) else { problems.append("A video could not be read."); continue }
                    if let problem = await send(video) { problems.append(problem) }
                } else if let photo = try await LibraryPhoto.load(item) {
                    let kept = galleryUploading
                    if await upload(photo, to: nil) == nil { problems.append("A photo was not uploaded.") }
                    galleryUploading = kept
                } else {
                    problems.append("A photo could not be read.")
                }
            } catch {
                problems.append(error.localizedDescription)
            }
        }
        galleryUploading = nil
        if !problems.isEmpty { alert = .init(title: "Not everything was added", message: problems.joined(separator: "\n")) }
    }

    /// Documents and other files from Files.
    private func uploadFiles(_ urls: [URL]) async {
        var problems: [String] = []
        for (index, url) in urls.enumerated() {
            galleryUploading = urls.count > 1 ? "Uploading \(index + 1) of \(urls.count)…" : "Uploading \(url.lastPathComponent)…"
            do {
                if let problem = await send(try FileTransfer.upload(fromFile: url)) { problems.append(problem) }
            } catch {
                problems.append(error.localizedDescription)
            }
        }
        galleryUploading = nil
        if !problems.isEmpty { alert = .init(title: "Not everything was added", message: problems.joined(separator: "\n")) }
    }

    /// Sends one Gallery file with the kind its type gives it; the problem, if any.
    private func send(_ file: FileTransfer.Upload) async -> String? {
        if let problem = SubmissionLibrary.sizeProblem(fileName: file.fileName, bytes: file.data.count) { return problem }
        let submissions = SubmissionsAPI(api: model.api)
        do {
            _ = try await submissions.uploadAttachment(submissionId, file: file.data, fileName: file.fileName, mimeType: file.mimeType,
                                                       sectionKey: nil,
                                                       kind: SubmissionLibrary.uploadKind(fileName: file.fileName, mimeType: file.mimeType),
                                                       capture: nil)
            if let fresh = try? await submissions.detail(submissionId) { detail = fresh }
            return nil
        } catch {
            return "\(file.fileName): \(model.handle(error))"
        }
    }

    /// Taking, choosing and opening section photos.
    private func photoFlows<Screen: View>(_ screen: Screen) -> some View {
        screen
            .sheet(item: $openPhoto) { PhotoDetailView(submissionId: submissionId, attachment: $0) }
            .fullScreenCover(item: $cameraSection) { target in
                MappedCameraScreen(onCaptured: { capture in
                    cameraSection = nil
                    Task {
                        if target.forCrack { await addCrack(photo: capture) } else { await upload(capture, to: target.sectionKey) }
                    }
                }, onCancel: { cameraSection = nil })
            }
            .fullScreenCover(isPresented: $sketching) {
                SketchpadScreen(onSave: { png in
                    sketching = false
                    Task { await uploadSketch(png) }
                }, onCancel: { sketching = false })
            }
            .photosPicker(isPresented: libraryOpen, selection: $libraryItem, matching: .images)
            .onChange(of: libraryItem) { _, item in
                guard let item, let section = librarySection else { return }
                let forCrack = libraryForCrack
                libraryItem = nil
                librarySection = nil
                libraryForCrack = false
                Task { await uploadLibraryPhoto(item, to: section, forCrack: forCrack) }
            }
    }

    private var libraryOpen: Binding<Bool> {
        Binding(get: { librarySection != nil }, set: { if !$0 && libraryItem == nil { librarySection = nil } })
    }

    private func uploadLibraryPhoto(_ item: PhotosPickerItem, to section: String, forCrack: Bool) async {
        do {
            guard let photo = try await LibraryPhoto.load(item) else {
                alert = .init(title: "Photo unavailable", message: "That photo could not be read.")
                return
            }
            if forCrack { await addCrack(photo: photo) } else { await upload(photo, to: section) }
        } catch {
            alert = .init(title: "Photo unavailable", message: error.localizedDescription)
        }
    }

    private func content(_ detail: SubmissionDetail, _ editor: Binding<GisaEditor>) -> some View {
        let canEdit = detail.submission.isEditable
        let form = editor.wrappedValue.form
        // Built in parts: as one expression it took the type checker too long for CI.
        return assessmentWiring(memoWiring(crackWiring(List {
            FormPresenceSection(others: presence?.others ?? [], notice: mergedNotice, pending: editor.wrappedValue.pending,
                                choose: { choosingConflicts = true })
            GisaReviewStatusSections(detail: detail, comment: $drafts.reviewComment, working: working,
                                     decide: { decision in Task { await review(decision) } },
                                     openAssessment: { id in Task { await open(assessment: id, saving: false) } })
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(SubmissionDescriptor.text(district: form["district"], county: form["county"], route: form["route"],
                                                   postMile: form["post_mile"], createdAt: detail.submission.createdAt))
                        .font(.subheadline)
                    Text("Status: \(SubmissionLabels.status(detail.submission.status))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Picker("Step", selection: $step) {
                    ForEach(GisaStep.allCases) { Text($0.shortTitle).tag($0) }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text("Step \(step.rawValue + 1) of \(GisaStep.allCases.count): \(step.title)")
            }

            switch step {
            case .header:
                GisaHeaderSections(editor: editor, canEdit: canEdit)
            case .body:
                // Every Body field is editable here; saving keeps any the screen does not show.
                GisaBodySections(editor: editor, canEdit: canEdit, lookups: lookups)
            case .assessment:
                GisaAssessmentSections(editor: editor, canEdit: canEdit, writers: presence?.writers ?? [:],
                                       open: { openMemo = MemoRoute(key: $0) })
            case .actions:
                GisaActionsSections(editor: editor, message: $drafts.notifyMessage, canEdit: canEdit, lookups: lookups,
                                    notices: GisaWorkflow.coordinatorNotices(detail.workflowEvents ?? []),
                                    notifying: working, notify: { Task { await notifyCoordinator() } })
            case .gallery:
                GisaLibrarySection(detail: detail, canEdit: canEdit, uploading: galleryUploading, opening: openingFile,
                                   add: { source in
                                       switch source {
                                       case .camera: cameraSection = PhotoTarget(sectionKey: nil)
                                       case .library: galleryPicking = true
                                       case .files: importingFiles = true
                                       }
                                   },
                                   open: { item in Task { await openFile(item) } })
                GisaSubmitSections(detail: detail,
                                   requirements: GisaWorkflow.requirements(form: form, photoCount: detail.photos?.count ?? 0),
                                   canEdit: canEdit, comment: $drafts.submitComment, working: working || saving,
                                   fix: { kind in withAnimation { step = GisaStep.fixing(kind) } },
                                   submit: { Task { await submit() } },
                                   openAssessment: { id in Task { await open(assessment: id, saving: canEdit) } })
            }

            if let next = GisaStep(rawValue: step.rawValue + 1) {
                Section {
                    Button("Continue to \(next.title)") { withAnimation { step = next } }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .environment(\.gisaPhotos, GisaPhotoContext(
            detail: detail, canEdit: canEdit, busySection: uploadingSection,
            add: { section, source in
                switch source {
                case .camera: cameraSection = PhotoTarget(sectionKey: section)
                case .library: librarySection = section
                case .sketch: sketching = true
                }
            },
            open: { openPhoto = $0 })), canEdit: canEdit), detail: detail, canEdit: canEdit))
        .toolbar {
            if canEdit {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(saving)
            }
        }
        .keyboardDoneButton()
    }

    /// The memo screen the Assessment step opens.
    private func memoWiring<Content: View>(_ content: Content, detail: SubmissionDetail, canEdit: Bool) -> some View {
        let api = model.api
        return content.navigationDestination(item: $openMemo) { route in
            if let editor = Binding($editor) {
                MemoEditorScreen(editor: editor, key: route.key, canEdit: canEdit, writer: presence?.writers[route.key],
                                 photos: GisaPhotoSections.allPhotos(of: detail),
                                 figure: { id in try await Self.figure(id, api: api) },
                                 typed: { presence?.typed() }, save: { await save() })
                    .modifier(prompts)
            }
        }
    }

    /// A photo's bytes for a memo figure, fetched with the app's sign-in.
    private static func figure(_ id: Int, api: APIClient) async throws -> (Data, String) {
        let link = try await SubmissionsAPI(api: api).attachmentLink(id)
        guard let url = URL(string: link.downloadUrl) else { throw URLError(.badURL) }
        let (data, response) = try await URLSession.shared.data(from: url)
        return (data, response.mimeType ?? "image/jpeg")
    }

    /// The cracks' context for the Pavement / Ground Status section, and the
    /// crack screen it opens.
    private func crackWiring<Content: View>(_ content: Content, canEdit: Bool) -> some View {
        content
            .environment(\.gisaCracks, GisaCrackContext(
                submissionId: submissionId, cracks: cracks, canEdit: canEdit, adding: addingCrack,
                add: { source in
                    switch source {
                    case .camera: cameraSection = PhotoTarget(sectionKey: "pavement_ground_status", forCrack: true)
                    case .library:
                        libraryForCrack = true
                        librarySection = "pavement_ground_status"
                    case .noPhoto: Task { await addCrack(photo: nil) }
                    }
                },
                open: { openCrack = CrackRoute(id: $0.id) }))
            .navigationDestination(item: $openCrack) { route in
                if let index = cracks.firstIndex(where: { $0.id == route.id }) {
                    CrackEditorView(submissionId: submissionId, crack: cracks[index], index: index, canEdit: canEdit,
                                    onSaved: { saved in
                                        if let at = cracks.firstIndex(where: { $0.id == saved.id }) { cracks[at] = saved }
                                    },
                                    onDeleted: { cracks.removeAll { $0.id == route.id } })
                } else {
                    Text("This crack is no longer on the form.").foregroundStyle(.secondary)
                }
            }
    }

    private func load() async {
        let submissions = SubmissionsAPI(api: model.api)
        do {
            let loaded = try await submissions.detail(submissionId)
            // The lists are needed to check actions on save; an older cache is
            // part of the offline work, so a failure leaves them empty for now.
            if let fetched = try? await submissions.lookups() { lookups = fetched }
            detail = loaded
            editor = GisaEditor(detail: loaded)
            if presence == nil { presence = FormPresenceSession(api: model.api, submissionId: submissionId) }
            cracks = loaded.cracks ?? []
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    /// Checks the draft as the Expo editor's Save does and sends what changed,
    /// then reloads. A save refused because someone else changed the same
    /// fields catches up with theirs and lets this person choose. `quietly`,
    /// as a step before notifying or submitting, it says nothing when it
    /// works. True when everything is saved.
    @discardableResult
    private func save(quietly: Bool = false) async -> Bool {
        guard var current = editor else { return false }
        let prepared = current.prepareSave(lookups: lookups)
        editor = current
        switch prepared {
        case .failure(let problem):
            if GisaStep.header.owns(current.errors.keys) { step = .header }
            alert = problem
            return false
        case .success(let request):
            if current.pending != nil {
                choosingConflicts = true
                return false
            }
            guard !request.isEmpty else {
                if !quietly { alert = .init(title: "Saved", message: "There are no changes to save.") }
                return true
            }
            saving = true
            defer { saving = false }
            do {
                try await SubmissionsAPI(api: model.api).saveGisa(submissionId, request)
                resaves = 0
                await load()
                if !quietly { alert = .init(title: "Saved", message: "Draft saved.") }
                return true
            } catch FormRefusal.conflicts(let savedBy) {
                saving = false
                return await catchUp(savedBy: savedBy, refused: true, quietly: quietly)
            } catch FormRefusal.locked(let message) {
                alert = .init(title: "Not saved", message: message)
            } catch {
                alert = .init(title: "Save failed", message: model.handle(error))
            }
            return false
        }
    }

    /// Brings in what others saved where this person has not typed. Fields both
    /// changed wait for a choice; after a refused save with none left, it saves
    /// again, and says whether that worked.
    @discardableResult
    private func catchUp(savedBy: String?, refused: Bool, quietly: Bool = false) async -> Bool {
        guard let fresh = try? await SubmissionsAPI(api: model.api).detail(submissionId), var current = editor else {
            if refused { alert = .init(title: "Save failed", message: "The form changed and could not be reloaded. Try again.") }
            return false
        }
        let taken = current.catchUp(with: fresh, savedBy: savedBy)
        editor = current
        detail = fresh
        if !taken.isEmpty {
            let names = taken.prefix(4).joined(separator: ", ") + (taken.count > 4 ? " and \(taken.count - 4) more" : "")
            mergedNotice = "\(savedBy ?? "Someone") saved \(names). Their changes are shown here."
        }
        if current.pending != nil {
            if refused { choosingConflicts = true }
        } else if refused, resaves < 2 {
            resaves += 1
            return await save(quietly: quietly)
        }
        return false
    }

    // MARK: Notifying, sending for review and deciding

    /// Saves, then sends the immediate actions and the message to the
    /// maintenance coordinator, as the Expo editor's Notify Coordinator does.
    private func notifyCoordinator() async {
        guard let current = editor else { return }
        if let problem = GisaWorkflow.notifyProblem(immediate: current.actions.immediate, message: drafts.notifyMessage) {
            alert = problem
            return
        }
        guard await save(quietly: true) else { return }
        working = true
        defer { working = false }
        do {
            try await SubmissionsAPI(api: model.api).notifyCoordinator(
                submissionId, message: drafts.notifyMessage.trimmingCharacters(in: .whitespacesAndNewlines))
            drafts.notifyMessage = ""
            await load()
            alert = .init(title: "Coordinator Notified", message: "Immediate actions were sent to the maintenance coordinator.")
        } catch {
            alert = .init(title: "Notify failed", message: model.handle(error))
        }
    }

    /// Checks what review needs, saves, and sends the form for review.
    private func submit() async {
        guard var current = editor, let detail else { return }
        let requirements = GisaWorkflow.requirements(form: current.form, photoCount: detail.photos?.count ?? 0)
        if let problem = GisaWorkflow.submitProblem(requirements) {
            current.errors.merge(GisaValidation.submitErrors(current.form)) { _, new in new }
            editor = current
            if let first = requirements.first(where: { !$0.met }), first.kind != .photo {
                withAnimation { step = GisaStep.fixing(first.kind) }
            }
            alert = problem
            return
        }
        guard await save(quietly: true) else { return }
        working = true
        defer { working = false }
        do {
            let comment = drafts.submitComment.trimmingCharacters(in: .whitespacesAndNewlines)
            try await SubmissionsAPI(api: model.api).submit(submissionId, comment: comment.isEmpty ? nil : comment)
            drafts.submitComment = ""
            await load()
            alert = .init(title: "Submitted", message: "Sent for review.")
        } catch APIError.http(409, let detail?) {
            alert = .init(title: "Cannot Submit Yet", message: GisaWorkflow.submitRefusal(detail) ?? detail)
        } catch {
            alert = .init(title: "Submit failed", message: model.handle(error))
        }
    }

    private func review(_ decision: SubmissionsAPI.ReviewDecision) async {
        working = true
        defer { working = false }
        do {
            let comment = drafts.reviewComment.trimmingCharacters(in: .whitespacesAndNewlines)
            try await SubmissionsAPI(api: model.api).review(submissionId, decision: decision, comment: comment.isEmpty ? nil : comment)
            drafts.reviewComment = ""
            await load()
            alert = .init(title: "Updated", message: GisaWorkflow.reviewDone(decision))
        } catch {
            alert = .init(title: "Review failed", message: model.handle(error))
        }
    }

    /// Opens the assessment this form belongs to, saving first so it is sent with what is on screen.
    private func open(assessment id: Int, saving: Bool) async {
        if saving { guard await save(quietly: true) else { return } }
        openAssessment = AssessmentRoute(id: id)
    }

    /// The memos this person is writing (changed since opening or catching up): locked for everyone else.
    private var writingMemos: [String] {
        guard let editor else { return [] }
        return MemoContent.keys.filter { editor.form["\($0)_html"] != editor.base.form["\($0)_html"] }
    }

    /// Files a photo under its form section, or under none from the Gallery.
    /// Only the attachment list is refreshed afterwards, so unsaved form changes are kept.
    @discardableResult
    private func upload(_ photo: MappedPhotoCapture, to section: String?) async -> UploadedAttachment? {
        uploadingSection = section
        if section == nil { galleryUploading = "Uploading photo…" }
        defer {
            uploadingSection = nil
            if section == nil { galleryUploading = nil }
        }
        let submissions = SubmissionsAPI(api: model.api)
        do {
            let uploaded = try await submissions.uploadAttachment(submissionId, file: photo.jpeg, fileName: photo.fileName,
                                                                  mimeType: "image/jpeg", sectionKey: section, kind: "PHOTO",
                                                                  capture: photo.metadata)
            if let fresh = try? await submissions.detail(submissionId) { detail = fresh }
            return uploaded
        } catch {
            alert = .init(title: "Photo upload failed", message: model.handle(error))
            return nil
        }
    }

    /// Files a sketch under the Sketchpad, as the Expo editor did (kind SKETCH).
    private func uploadSketch(_ png: Data) async {
        uploadingSection = "sketchpad"
        defer { uploadingSection = nil }
        let submissions = SubmissionsAPI(api: model.api)
        do {
            let stamp = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false))
                .replacingOccurrences(of: ":", with: "")
            _ = try await submissions.uploadAttachment(submissionId, file: png, fileName: "gisa-sketch-\(stamp).png",
                                                       mimeType: "image/png", sectionKey: "sketchpad", kind: "SKETCH",
                                                       capture: nil)
            if let fresh = try? await submissions.detail(submissionId) { detail = fresh }
        } catch {
            alert = .init(title: "Sketch not saved", message: model.handle(error))
        }
    }

    /// Starts a crack, from a photo or without one, and opens it. A photo is
    /// filed under Pavement / Ground Status and its GPS is the crack's
    /// approximate location.
    private func addCrack(photo: MappedPhotoCapture?) async {
        addingCrack = true
        defer { addingCrack = false }
        var fields: [String: JSONValue] = [:]
        if let photo {
            guard let uploaded = await upload(photo, to: "pavement_ground_status") else { return }
            fields["photo_attachment_id"] = .number(Double(uploaded.attachmentId))
            if let latitude = photo.metadata?.latitude, let longitude = photo.metadata?.longitude {
                fields["latitude"] = .number(latitude)
                fields["longitude"] = .number(longitude)
                fields["location_source"] = .string("PHOTO")
            }
        }
        do {
            let crack = try await SubmissionsAPI(api: model.api).createCrack(submissionId, fields: fields)
            cracks.append(crack)
            // Answering "Pavement/Ground Cracks" is the server's; show it.
            editor?.form["pavement_ground_cracks"] = "YES"
            openCrack = CrackRoute(id: crack.id)
        } catch {
            alert = .init(title: "Crack not added", message: model.handle(error))
        }
    }

}

/// The editor's five steps.
enum GisaStep: Int, CaseIterable, Identifiable {
    case header, body, assessment, actions, gallery

    var id: Int { rawValue }

    var title: String {
        ["Header", "GISA Body", "Assessment", "Actions", "Gallery"][rawValue]
    }

    var shortTitle: String {
        ["Header", "Body", "Assess", "Actions", "Gallery"][rawValue]
    }

    static let headerKeys: Set = ["report_date", "district", "county", "route", "post_mile", "ea", "project_id",
                                  "date_incident_reported", "district_contact", "latitude", "longitude", "geometry_json"]
    /// The step where a requirement for review is met.
    static func fixing(_ kind: GisaWorkflow.Requirement.Kind) -> GisaStep {
        switch kind {
        case .location: return .header
        case .geotechnical: return .assessment
        case .soil, .debris: return .body
        case .photo: return .gallery
        }
    }

    /// Whether any of these field keys is on this step.
    func owns<S: Sequence>(_ keys: S) -> Bool where S.Element == String {
        guard self == .header else { return false }
        return keys.contains { Self.headerKeys.contains($0) }
    }
}

// MARK: - Step 1: Header and Location

struct GisaHeaderSections: View {
    @Environment(\.openURL) private var openURL
    @Binding var editor: GisaEditor
    let canEdit: Bool
    @State private var showCoordinates = false
    @State private var showNorthingEasting = false
    @State private var northing = ""
    @State private var easting = ""
    @State private var statePlaneError: String?
    @State private var openContacts: Set<UUID> = []

    private var form: GisaForm { editor.form }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    var body: some View {
        Section("GISA Header") {
            GisaDateField(label: "Report Date", value: binding("report_date"), editable: canEdit,
                          error: editor.errors["report_date"])
            GisaChoiceField(label: "District *", value: form["district"], editable: canEdit,
                            options: CaltransCounties.districts.map { ($0, "District \($0)") },
                            placeholder: "Select district", error: editor.errors["district"]) { editor.chooseDistrict($0) }
            GisaChoiceField(label: "County *", value: form["county"], editable: canEdit && !form["district"].isEmpty,
                            options: CaltransCounties.counties(inDistrict: form["district"]).map { ($0.code, $0.displayLabel) },
                            placeholder: form["district"].isEmpty ? "Select district first" : "Select county",
                            error: editor.errors["county"]) { editor.chooseCounty($0) }
            GisaChoiceField(label: "Route", value: form["route"], editable: canEdit && !form["county"].isEmpty,
                            options: CaltransCounties.routes(forCounty: form["county"]).map { ($0, $0) },
                            placeholder: form["county"].isEmpty ? "Select county first" : "Select route",
                            error: editor.errors["route"]) { editor.set("route", $0) }
            GisaTextField(label: "Post Mile", value: binding("post_mile"), editable: canEdit,
                          keyboard: .decimalPad, error: editor.errors["post_mile"]) {
                editor.set("post_mile", GisaPrecision.postMileInput(form["post_mile"]))
            }
            GisaTextField(label: "EA", value: binding("ea"), editable: canEdit, error: editor.errors["ea"])
            GisaTextField(label: "Project ID", value: binding("project_id"), editable: canEdit, keyboard: .numberPad,
                          error: editor.errors["project_id"])
            GisaDateField(label: "Date Incident Reported", value: binding("date_incident_reported"),
                          editable: canEdit, error: editor.errors["date_incident_reported"])
        }

        Section {
            if editor.contacts.isEmpty {
                Text("No district contacts added yet.").foregroundStyle(.secondary)
            }
            ForEach(Array(editor.contacts.enumerated()), id: \.element.id) { index, contact in
                DisclosureGroup(isExpanded: Binding(get: { openContacts.contains(contact.id) },
                                                    set: { if $0 { openContacts.insert(contact.id) } else { openContacts.remove(contact.id) } })) {
                    contactField("First Name", \.firstName, index)
                    contactField("Last Name", \.lastName, index)
                    contactField("S Number", \.sNumber, index)
                    contactField("Phone", \.phone, index, keyboard: .phonePad)
                    contactField("Cell Phone", \.cellPhone, index, keyboard: .phonePad)
                    if canEdit {
                        Button("Remove Contact", role: .destructive) {
                            editor.setContacts(editor.contacts.filter { $0.id != contact.id })
                        }
                    }
                } label: {
                    Text(contact.displayName(index: index))
                }
            }
            if canEdit {
                Button("Add District Contact") {
                    let added = DistrictContact()
                    editor.setContacts(editor.contacts + [added])
                    openContacts.insert(added.id)
                }
            }
        } header: {
            Text("District Contacts")
        } footer: {
            if let message = editor.errors["district_contact"] { Text(message).foregroundStyle(.red) }
        }

        Section("Location") {
            VStack(alignment: .leading, spacing: 6) {
                if let preview = form.mapPreviewURL {
                    AsyncImage(url: preview) { image in
                        image.resizable().aspectRatio(2, contentMode: .fit)
                    } placeholder: {
                        Color.gray.opacity(0.15).aspectRatio(2, contentMode: .fit)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("Satellite view of the location")
                } else {
                    Text("Awaiting location…").foregroundStyle(.secondary)
                }
                Text("Geometry: \(form["geometry_json"].trimmingCharacters(in: .whitespaces).isEmpty ? "None" : "Available")")
                    .font(.caption).foregroundStyle(.secondary)
                // The Expo app opens its ArcGIS map editor from this preview; that
                // and the Site Photo Map come with the ArcGIS Maps SDK port.
                Text("The map editor (pin and polygon) is not on iPhone yet. Set the location with Lat/Lon or Northing/Easting below.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button("Open in Google Maps") { if let url = form.googleMapsURL { openURL(url) } }
                .disabled(form.googleMapsURL == nil)
            Toggle("Show Lat/Lon", isOn: $showCoordinates)
            if showCoordinates || editor.errors["latitude"] != nil || editor.errors["longitude"] != nil {
                GisaTextField(label: "Latitude *", value: binding("latitude"), editable: canEdit,
                              keyboard: .numbersAndPunctuation, error: editor.errors["latitude"]) {
                    editor.set("latitude", GisaPrecision.formatCoordinate(form["latitude"]))
                }
                GisaTextField(label: "Longitude *", value: binding("longitude"), editable: canEdit,
                              keyboard: .numbersAndPunctuation, error: editor.errors["longitude"]) {
                    editor.set("longitude", GisaPrecision.formatCoordinate(form["longitude"]))
                }
            }
            Toggle("Show Northing/Easting", isOn: $showNorthingEasting)
                .disabled(form.statePlane == nil)
            if showNorthingEasting, let plane = form.statePlane {
                Text("CCS83 Zone \(plane.zone) · US survey ft").font(.caption).foregroundStyle(.secondary)
                GisaTextField(label: "Northing", value: $northing, editable: canEdit, keyboard: .numbersAndPunctuation,
                              error: statePlaneError) { applyStatePlane() }
                GisaTextField(label: "Easting", value: $easting, editable: canEdit, keyboard: .numbersAndPunctuation,
                              error: nil) { applyStatePlane() }
            }
        }
        .onAppear(perform: refreshStatePlane)
        .onChange(of: "\(form["latitude"])|\(form["longitude"])|\(form["county"])") { refreshStatePlane() }
    }

    private func contactField(_ label: String, _ path: WritableKeyPath<DistrictContact, String>, _ index: Int,
                              keyboard: UIKeyboardType = .default) -> some View {
        GisaTextField(label: label, value: Binding(get: { editor.contacts[index][keyPath: path] }, set: { value in
            var next = editor.contacts
            next[index][keyPath: path] = value
            editor.setContacts(next)
        }), editable: canEdit, keyboard: keyboard, error: nil)
    }

    private func refreshStatePlane() {
        northing = form.statePlane?.northing ?? ""
        easting = form.statePlane?.easting ?? ""
        statePlaneError = nil
    }

    private func applyStatePlane() {
        var next = editor.form
        if let problem = next.applyStatePlane(northing: northing, easting: easting) {
            statePlaneError = problem
            return
        }
        editor.set("latitude", next["latitude"])
        editor.set("longitude", next["longitude"])
        refreshStatePlane()
    }
}

// MARK: - Step 2: GISA Body

struct GisaBodySections: View {
    @Binding var editor: GisaEditor
    let canEdit: Bool
    let lookups: GisaLookups

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    var body: some View {
        Section("Distribution") {
            ChipFlow {
                ForEach(lookups.distribution) { option in
                    GisaChip(label: option.label, icon: "Distribution/\(option.code)",
                             on: editor.form["distribution_code"] == option.code, enabled: canEdit) {
                        editor.toggleDistribution(option.code)
                    }
                }
            }
            GisaSectionPhotos(sectionKey: "distribution")
        }

        Section {
            GisaTextField(label: "Cause Of Highway Status", value: binding("highway_status_cause"), editable: canEdit,
                          error: editor.errors["highway_status_cause"])
            if editor.showsHighwayStatusOptions {
                ChipFlow {
                    ForEach(lookups.highwayStatus) { option in
                        GisaChip(label: option.label, on: editor.form["highway_status_code"] == option.code,
                                 enabled: canEdit) { editor.toggleHighwayStatus(option.code) }
                    }
                }
                if editor.asksLanesClosedCount {
                    GisaChoiceField(label: "Lane(s) Closed Count", value: editor.form["lanes_closed_count"],
                                    editable: canEdit, options: GisaEditor.lanesClosedCounts.map { ($0, $0) },
                                    placeholder: "Select lanes closed", error: editor.errors["lanes_closed_count"]) {
                        editor.set("lanes_closed_count", $0)
                    }
                }
            } else {
                Text("Enter the cause above to reveal the highway status options.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            GisaSectionPhotos(sectionKey: "highway_status")
        } header: {
            Text("Highway Status")
        }

        Section("Incident Type") {
            ChipFlow {
                ForEach(GisaEditor.incidentTypeOptions) { option in
                    GisaChip(label: option.label, on: editor.isIncidentTypeOn(option), enabled: canEdit) {
                        editor.toggleIncidentType(option)
                    }
                }
            }
            GisaTextField(label: "Incident Type Description", value: binding("incident_type_description"),
                          editable: canEdit, error: editor.errors["incident_type_description"], axis: .vertical)
            GisaSectionPhotos(sectionKey: "incident_type")
        }

        GisaMaterialSection(editor: $editor, canEdit: canEdit)
        GisaPavementSection(editor: $editor, canEdit: canEdit)
        GisaVegetationWaterSections(editor: $editor, canEdit: canEdit)
        GisaMeasurementsSection(editor: $editor, canEdit: canEdit)
    }
}

/// Vegetation on Slope, Water / Drainage and Water Content.
struct GisaVegetationWaterSections: View {
    @Binding var editor: GisaEditor
    let canEdit: Bool

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    // Three parts rather than one body: kept small for Xcode 16's type checker in CI.
    var body: some View {
        vegetation
        drainage
        waterContent
    }

    private var vegetation: some View {
        Section("Vegetation on Slope") {
            ForEach(GisaEditor.vegetationKeys, id: \.0) { key, label in
                GisaTextField(label: "\(label) Coverage %", value: binding(key), editable: canEdit,
                              keyboard: .decimalPad, error: editor.errors[key])
            }
            GisaSectionPhotos(sectionKey: "vegetation_slope")
        }
    }

    private var drainage: some View {
        Section("Water / Drainage") {
            ChipFlow {
                ForEach(GisaEditor.drainageChoices, id: \.0) { key, label in
                    GisaChip(label: label, on: editor.form[key] == "YES", enabled: canEdit) { editor.toggleDrainage(key) }
                }
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow {
                    Text("Impacted").font(.caption.weight(.semibold))
                    Text("May be").font(.caption.weight(.semibold))
                    Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                }
                ForEach(GisaEditor.impactRows, id: \.2) { impacted, maybe, label in
                    GridRow {
                        impactBox(on: editor.form[impacted] == "YES", label: "\(label) impacted") {
                            editor.toggleImpact(impactedKey: impacted, maybeKey: maybe, .impacted)
                        }
                        impactBox(on: editor.form[maybe] == "YES", label: "\(label) may be impacted") {
                            editor.toggleImpact(impactedKey: impacted, maybeKey: maybe, .maybe)
                        }
                        Text(label)
                    }
                }
            }
            GisaSectionPhotos(sectionKey: "water_drainage")
        }
    }

    private var waterContent: some View {
        Section("Water Content") {
            ChipFlow {
                ForEach(GisaEditor.waterContentChoices, id: \.0) { key, label in
                    GisaChip(label: label, on: editor.form[key] == "YES", enabled: canEdit) { editor.toggleWaterContent(key) }
                }
            }
            if editor.form["water_flowing"] == "YES" {
                ChipFlow {
                    ForEach(GisaEditor.flowingChoices, id: \.0) { key, label in
                        GisaChip(label: label, on: editor.form[key] == "YES", enabled: canEdit) { editor.toggleFlowing(key) }
                    }
                }
            }
            GisaSectionPhotos(sectionKey: "water_content")
        }
    }

    /// A tick box in the impact table, as on the paper form.
    private func impactBox(on: Bool, label: String, toggle: @escaping () -> Void) -> some View {
        Button(action: toggle) {
            Image(systemName: on ? "checkmark.square.fill" : "square")
                .font(.title3)
                .foregroundStyle(on ? Color.accentColor : Color.secondary)
                .frame(minWidth: 44, minHeight: 32)
        }
        .buttonStyle(.borderless)
        .disabled(!canEdit)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Material: slope (soil and rock formation), pavement type and landslide debris.
struct GisaMaterialSection: View {
    @Binding var editor: GisaEditor
    let canEdit: Bool
    @State private var part = Part.slope

    enum Part: String, CaseIterable, Identifiable {
        case slope = "Slope", pavement = "Pavement", debris = "Landslide Debris"
        var id: String { rawValue }
    }

    private func slider(_ label: String, _ key: String) -> some View {
        GisaPercentSlider(label: label, value: GisaEditor.steppedPercent(editor.form[key]), enabled: canEdit) {
            editor.setPercent(key, $0)
        }
    }

    var body: some View {
        Section {
            Picker("Material", selection: $part) {
                ForEach(Part.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            switch part {
            case .slope:
                Toggle("Soil", isOn: Binding(get: { editor.form["material_soil"] == "YES" },
                                             set: { _ in editor.toggleMaterial("material_soil") }))
                    .disabled(!canEdit)
                if editor.form["material_soil"] == "YES" {
                    slider("Soil Est %", "est_soil_pct")
                    GisaPercentSlider(label: "Clay/Silt Est %", value: GisaEditor.steppedPercent(editor.claySiltPercent),
                                      enabled: canEdit) { editor.setClaySiltPercent($0) }
                    slider("Sand Est %", "est_sand_pct")
                    slider("Gravel/Cobbles Est %", "est_gravel_pct")
                    slider("Boulder Est %", "est_boulder_pct")
                    GisaShareTotal(what: "Clay/silt, sand, gravel/cobbles and boulder", total: editor.soilShareTotal)
                }
                Toggle("Rock Formation", isOn: Binding(get: { editor.form["material_rock"] == "YES" },
                                                       set: { _ in editor.toggleMaterial("material_rock") }))
                    .disabled(!canEdit)
                if editor.form["material_rock"] == "YES" {
                    slider("Rock Formation Est %", "est_rock_pct")
                    ChipFlow {
                        ForEach(GisaEditor.rockSubtypes, id: \.0) { key, label in
                            GisaChip(label: label, on: editor.form[key] == "YES", enabled: canEdit) {
                                editor.toggleRockSubtype(key)
                            }
                        }
                    }
                }
            case .pavement:
                ChipFlow {
                    ForEach([("CONCRETE", "Concrete"), ("ASPHALT", "Asphalt")], id: \.0) { code, label in
                        GisaChip(label: label, on: editor.form["material_pavement_type"] == code, enabled: canEdit) {
                            editor.togglePavementType(code)
                        }
                    }
                }
            case .debris:
                slider("Clay/Silt Est %", "est_debris_clay_silt_pct")
                slider("Sand Est %", "est_debris_sand_pct")
                slider("Gravel/Cobbles Est %", "est_debris_gravel_pct")
                slider("Boulder Est %", "est_debris_boulder_pct")
                GisaShareTotal(what: "Landslide debris", total: editor.debrisShareTotal)
            }
            GisaSectionPhotos(sectionKey: "material")
        } header: {
            Text("Material")
        }
    }
}

/// A 0–100% share in steps of 5, as the Expo editor's SteppedPercentInput.
struct GisaPercentSlider: View {
    let label: String
    let value: Int
    let enabled: Bool
    let change: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                Spacer()
                Text("\(value)%").monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: Binding(get: { Double(value) }, set: change), in: 0...100, step: 5) {
                Text(label)
            } minimumValueLabel: {
                Text("0%").font(.caption2).foregroundStyle(.secondary)
            } maximumValueLabel: {
                Text("100%").font(.caption2).foregroundStyle(.secondary)
            }
            .disabled(!enabled)
            .sensoryFeedback(.selection, trigger: value)
        }
    }
}

/// The running total of a group of shares, which must reach 100% to submit.
struct GisaShareTotal: View {
    let what: String
    let total: Double?

    var body: some View {
        if let total {
            let done = total == 100
            Label("\(what): \(JSNumberText.text(total))% of 100%", systemImage: done ? "checkmark.circle" : "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(done ? Color.green : Color.secondary)
        } else {
            Label("\(what): a share is not a number", systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(.red)
        }
    }
}

/// 80 -> "80", 72.5 -> "72.5".
enum JSNumberText {
    static func text(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.2f", value)
    }
}

/// A choice shown as a capsule that is on or off, as the Expo editor's Chip.
struct GisaChip: View {
    let label: String
    var icon: String?
    let on: Bool
    let enabled: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                if let icon, UIImage(named: icon) != nil {
                    Image(icon).resizable().scaledToFit().frame(width: 22, height: 22)
                }
                Text(label).font(.subheadline.weight(on ? .semibold : .regular))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(on ? Color.white : Color.primary)
            .background(on ? Color.accentColor : Color.secondary.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled || on ? 1 : 0.6)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Lays chips out in rows, wrapping at the edge.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // Spelled out step by step: as one expression it outran the type
        // checker of Xcode 16 in CI.
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        var widest: CGFloat = 0
        var height: CGFloat = 0
        for row in rows {
            widest = max(widest, row.width)
            height += row.height
        }
        let gaps = CGFloat(max(rows.count - 1, 0)) * spacing
        return CGSize(width: proposal.width ?? widest, height: height + gaps)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if let last = rows.last, last.width + spacing + size.width <= width {
                rows[rows.count - 1] = (last.indices + [index], last.width + spacing + size.width, max(last.height, size.height))
            } else {
                rows.append(([index], size.width, size.height))
            }
        }
        return rows
    }
}

// MARK: - Fields

/// A labelled text field with its error. `onEndEditing` runs when the field
/// loses focus or Return is pressed, where the Expo editor normalised on blur.
struct GisaTextField: View {
    let label: String
    @Binding var value: String
    var editable = true
    var keyboard: UIKeyboardType = .default
    let error: String?
    var axis: Axis = .horizontal
    var onEndEditing: (() -> Void)?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            // The label sits above the field, so it is not repeated inside it.
            TextField(label, text: $value, prompt: Text(""), axis: axis)
                .accessibilityLabel(label)
                .keyboardType(keyboard)
                .focused($focused)
                .disabled(!editable)
                .foregroundStyle(editable ? .primary : .secondary)
                .onSubmit { onEndEditing?() }
                .onChange(of: focused) { _, now in if !now { onEndEditing?() } }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}

/// A choice from a fixed list, shown as a menu. A saved value that is not in
/// the list is kept and shown, not silently dropped.
struct GisaChoiceField: View {
    let label: String
    let value: String
    let editable: Bool
    let options: [(value: String, title: String)]
    let placeholder: String
    let error: String?
    let choose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Menu {
                ForEach(options, id: \.value) { option in
                    Button { choose(option.value) } label: {
                        if option.value == value { Label(option.title, systemImage: "checkmark") } else { Text(option.title) }
                    }
                }
            } label: {
                HStack {
                    Text(label).foregroundStyle(.primary)
                    Spacer()
                    Text(options.first { $0.value == value }?.title ?? (value.isEmpty ? placeholder : value))
                        .foregroundStyle(value.isEmpty ? .tertiary : .secondary)
                    if editable { Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.tertiary) }
                }
            }
            .disabled(!editable)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}

/// A YYYY-MM-DD date, chosen on a calendar; it can be left blank.
struct GisaDateField: View {
    let label: String
    @Binding var value: String
    let editable: Bool
    let error: String?
    @State private var choosing = false
    @State private var draft = Date()

    private static let format: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                draft = Self.format.date(from: value) ?? Date()
                choosing = true
            } label: {
                HStack {
                    Text(label).foregroundStyle(.primary)
                    Spacer()
                    Text(value.isEmpty ? "Select date" : value).foregroundStyle(value.isEmpty ? .tertiary : .secondary)
                }
            }
            .disabled(!editable)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .sheet(isPresented: $choosing) {
            NavigationStack {
                DatePicker(label, selection: $draft, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                    .navigationTitle(label)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Clear") { value = ""; choosing = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { value = Self.format.string(from: draft); choosing = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
    }
}
