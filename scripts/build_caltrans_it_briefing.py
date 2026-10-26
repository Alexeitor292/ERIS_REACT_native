"""Build the concise Caltrans IT meeting handout from verified ERIS facts."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "eris-caltrans-it-briefing.pdf"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#12649B")
TEAL = colors.HexColor("#087D76")
PALE = colors.HexColor("#EFF5F8")
LINE = colors.HexColor("#CFDAE2")
GRAY = colors.HexColor("#445768")
AMBER = colors.HexColor("#FFF4D8")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="KickerX", fontName="Helvetica-Bold", fontSize=8, leading=11,
                          textColor=TEAL, spaceAfter=7))
styles.add(ParagraphStyle(name="TitleX", fontName="Helvetica-Bold", fontSize=23, leading=27,
                          textColor=NAVY, spaceAfter=9))
styles.add(ParagraphStyle(name="SectionX", fontName="Helvetica-Bold", fontSize=14, leading=17,
                          textColor=NAVY, spaceBefore=5, spaceAfter=8, keepWithNext=True))
styles.add(ParagraphStyle(name="SubX", fontName="Helvetica-Bold", fontSize=10, leading=13,
                          textColor=BLUE, spaceBefore=9, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle(name="BodyX", fontName="Helvetica", fontSize=8.5, leading=12,
                          textColor=NAVY, spaceAfter=5))
styles.add(ParagraphStyle(name="SmallX", fontName="Helvetica", fontSize=7.7, leading=10.4,
                          textColor=GRAY, spaceAfter=3))
styles.add(ParagraphStyle(name="CellX", fontName="Helvetica", fontSize=7.6, leading=10,
                          textColor=NAVY))
styles.add(ParagraphStyle(name="CellBoldX", fontName="Helvetica-Bold", fontSize=7.6, leading=10,
                          textColor=NAVY))
styles.add(ParagraphStyle(name="TableHeadX", fontName="Helvetica-Bold", fontSize=7.5, leading=9.5,
                          textColor=colors.white))
styles.add(ParagraphStyle(name="NoteX", fontName="Helvetica-Bold", fontSize=8.1, leading=11,
                          textColor=NAVY))


def p(value, style="BodyX"):
    return Paragraph(value, styles[style])


def rule():
    return HRFlowable(width="100%", thickness=0.7, color=LINE, spaceBefore=3, spaceAfter=8)


def table(headers, rows, widths, *, first_col_bold=False):
    data = [[p(item, "TableHeadX") for item in headers]]
    for row in rows:
        data.append([p(item, "CellBoldX" if first_col_bold and idx == 0 else "CellX")
                     for idx, item in enumerate(row)])
    result = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    result.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, NAVY),
        ("LINEBELOW", (0, 1), (-1, -1), 0.35, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return result


def callout(text):
    box = Table([[p(text, "NoteX")]], colWidths=[528])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), AMBER),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#E3BB58")),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return box


def box(drawing, x, y, w, h, title, subtitle="", fill=PALE, stroke=LINE):
    drawing.add(Rect(x, y, w, h, rx=8, ry=8, fillColor=fill, strokeColor=stroke, strokeWidth=1))
    drawing.add(String(x + w / 2, y + h / 2 + (4 if subtitle else -2), title,
                       textAnchor="middle", fontName="Helvetica-Bold", fontSize=9.2, fillColor=NAVY))
    if subtitle:
        drawing.add(String(x + w / 2, y + h / 2 - 10, subtitle,
                           textAnchor="middle", fontName="Helvetica", fontSize=7.1, fillColor=GRAY))


def arrow(drawing, x1, y1, x2, y2, label=""):
    drawing.add(Line(x1, y1, x2, y2, strokeColor=BLUE, strokeWidth=1.7))
    drawing.add(Polygon([x2, y2, x2 - 6, y2 + 3, x2 - 6, y2 - 3],
                        fillColor=BLUE, strokeColor=BLUE))
    if label:
        drawing.add(String((x1 + x2) / 2, y1 + 7, label, textAnchor="middle",
                           fontName="Helvetica", fontSize=6.9, fillColor=BLUE))


def runtime_diagram():
    d = Drawing(528, 214)
    d.add(Rect(0, 0, 528, 214, rx=10, ry=10, fillColor=colors.white,
               strokeColor=LINE, strokeWidth=1))
    d.add(String(12, 197, "RUNTIME TOPOLOGY", fontName="Helvetica-Bold", fontSize=8,
                 fillColor=TEAL))
    box(d, 13, 112, 86, 48, "Staff browser", "HTTPS 443")
    box(d, 117, 105, 105, 62, "Caltrans TLS", "web + file names", fill=colors.HexColor("#E3F2F0"))
    d.add(Rect(242, 18, 273, 176, rx=10, ry=10, fillColor=colors.HexColor("#F7FAFC"),
               strokeColor=BLUE, strokeWidth=1.2))
    d.add(String(254, 177, "ONE ROOTLESS PODMAN POD", fontName="Helvetica-Bold", fontSize=7.7,
                 fillColor=BLUE))
    box(d, 255, 116, 103, 42, "nginx + web", "port 80", fill=colors.white)
    box(d, 382, 116, 118, 42, "FastAPI", "port 8000", fill=colors.white)
    box(d, 255, 57, 103, 42, "Terrain worker", "background jobs", fill=colors.white)
    box(d, 382, 57, 118, 42, "MariaDB 11", "persistent volume", fill=colors.white)
    box(d, 382, 20, 118, 29, "SeaweedFS S3", "", fill=colors.white)
    arrow(d, 99, 136, 117, 136, "")
    arrow(d, 222, 136, 255, 136, "8080")
    arrow(d, 358, 136, 382, 136, "")
    arrow(d, 358, 78, 382, 78, "")
    d.add(Line(441, 116, 441, 99, strokeColor=BLUE, strokeWidth=1.4))
    d.add(Line(169, 105, 169, 35, strokeColor=BLUE, strokeWidth=1.3))
    arrow(d, 169, 35, 382, 35, "9800")
    d.add(String(14, 72, "Signed downloads", fontName="Helvetica-Bold", fontSize=7.5,
                 fillColor=NAVY))
    d.add(String(14, 57, "gateway to host 9800", fontName="Helvetica", fontSize=7,
                 fillColor=GRAY))
    d.add(String(14, 29, "Outside pod: Entra ID, Harbor,", fontName="Helvetica", fontSize=7,
                 fillColor=GRAY))
    d.add(String(14, 17, "DNS/TLS gateway and backups", fontName="Helvetica", fontSize=7,
                 fillColor=GRAY))
    return d


def page_frame(canvas, doc):
    canvas.saveState()
    w, h = letter
    canvas.setFillColor(NAVY)
    canvas.rect(0, h - 10, w, 10, fill=1, stroke=0)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(GRAY)
    canvas.drawString(42, 29, "ERIS | Caltrans IT discussion copy | 26 Oct 2026")
    canvas.drawRightString(w - 42, 29, f"Page {doc.page}")
    canvas.restoreState()


story = []

# Page 1: the pitch and architecture.
story += [p("CALTRANS IT DISCUSSION / ARCHITECTURE", "KickerX"),
          p("ERIS deployment briefing", "TitleX"),
          p("One Linux Podman pod, five containers, two persistent data volumes. Caltrans owns the platform and security boundary; the ERIS team supplies application code and deployment artifacts."),
          callout("First decision: does Caltrans mean a Podman pod on a Linux VM, or a Kubernetes/OpenShift Pod? These artifacts implement Podman. Confirm that MariaDB and object storage may run in the same pod."),
          Spacer(1, 13), runtime_diagram(), Spacer(1, 8),
          p("Evidence uploads follow browser to FastAPI to private S3. The separate file hostname serves short-lived signed downloads through the TLS gateway.", "SmallX"),
          p("Stack at a glance", "SubX"),
          table(["Inside the pod", "Outside the pod / Caltrans-owned"], [
              ("nginx + React web; Python/FastAPI API; terrain worker", "DNS/TLS gateway, firewall and public HTTPS names"),
              ("MariaDB 11 metadata + SeaweedFS 4.50 S3 objects", "Entra ID, Jenkins, Harbor, backup and monitoring"),
              ("Host publishes only 8080 (web/API) and 9800 (S3)", "Gateway exposes HTTPS 443; internal DB/API ports stay private"),
          ], [264, 264]),
          Spacer(1, 6),
          p("Current Campos Labs Proxmox pod is a packaging rehearsal, not Caltrans acceptance: it uses local image tags, Cloudflare/Caddy and password sign-in. Harbor, Caltrans Entra, security policy and off-host recovery still need joint tests.", "SmallX"),
          PageBreak()]

# Page 2: data and security.
story += [p("DATA / IDENTITY / SECURITY", "KickerX"),
          p("What is implemented, and what needs approval", "TitleX"),
          table(["Area", "ERIS today", "Caltrans decision"], [
              ("Data", "MariaDB holds accounts, roles, incidents, assessments, workflows and metadata. SeaweedFS holds photos, attachments, PDFs and terrain packages.", "Classification, retention, legal hold, and whether to import any existing data."),
              ("Recovery", "Two persistent named volumes; the database and object store must be restored together with runtime secrets.", "Encrypted off-host backup, RPO/RTO, restore drill and single-host failure plan."),
              ("Entra", "Web OIDC authorization code + PKCE, single tenant, exact callback. ERIS roles are local; users link by tenant + object ID.", "Tenant/cloud, Web app, first admin object ID, MFA/Conditional Access tests. Current server exchange requires a client secret."),
              ("Sessions", "ERIS HS256 bearer token, 120-minute default, currently kept in browser localStorage. API checks ERIS active flag and roles every request.", "Review token storage, lifetime and offboarding. Entra disable alone does not revoke an already-issued ERIS token."),
              ("Files / TLS", "Private S3 buckets; 15-minute signed URLs. Internal pod traffic is localhost HTTP/TCP.", "TLS gateway, signed-URL forwarding, HSTS/CSP, rate limits/WAF, at-rest encryption and log redaction."),
              ("Supply chain", "Jenkinsfile builds and pushes three ERIS images; IT mirrors MariaDB and SeaweedFS.", "Scan/license/SBOM/signing policy, digest approval and release promotion owner."),
          ], [75, 224, 229], first_col_bold=True),
          Spacer(1, 11),
          callout("Security gate: ERIS browser tokens are in localStorage. OWASP advises against storing authentication tokens there. If Caltrans requires HttpOnly server sessions or certificate-based Entra client authentication, plan and test those code changes before production."),
          Spacer(1, 10),
          p("First administrator and handover", "SubX"),
          p("Fresh install creates schema and roles, not demo users. One initial admin is seeded once, preferably linked to the supplied Entra object ID. Create and verify at least two named SSO admins, disable the initial admin, remove its temporary credential, and then disable local password sign-in in the API and rebuilt web image."),
          p("Web callback: https://&lt;web-host&gt;/api/auth/entra/callback. A future mobile app needs a separate native/public Entra registration and PKCE flow; it is not part of this release.", "SmallX"),
          PageBreak()]

# Page 3: release and handoffs.
story += [p("DELIVERY / ACCEPTANCE", "KickerX"),
          p("How the deployment would go", "TitleX"),
          table(["Step", "Work and evidence"], [
              ("1. Decide", "Agree Podman interpretation, data scope, host/storage, gateway names, Entra policy, Harbor/Jenkins gates, security review and recovery targets."),
              ("2. Stage", "Caltrans provisions Linux/rootless Podman, two volumes, DNS/TLS gateway, firewall/egress, Entra test registration, Harbor/Jenkins and backup target."),
              ("3. Build", "On an approved Linux Podman agent, Jenkins builds and pushes API, worker and web from an immutable commit. IT mirrors MariaDB/SeaweedFS; scans/approves and pins five digests."),
              ("4. Configure", "IT supplies runtime secrets through its approved channel. Set exact web, S3 and callback URLs; match DB and S3 credentials across env files."),
              ("5. Install", "Run eris-pod.sh up. It initializes schema/roles, runs Alembic, creates private buckets, seeds one admin, and starts the five containers."),
              ("6. Prove", "Check HTTPS web/API, evidence upload through API and signed S3 download, Entra linked/unknown/disabled users, roles, incident path, restart, reboot, matched backup/restore and rollback."),
              ("7. Handover", "Verify two named Entra admins, disable initial admin and local login, rotate handover secrets, record monitoring/support owners, then schedule production cutover."),
          ], [83, 445], first_col_bold=True),
          Spacer(1, 12),
          p("Who hands over what", "SectionX"),
          table(["ERIS team supplies", "Caltrans IT supplies / approves"], [
              ("Approved source commit, Jenkinsfile, Podman scripts, env templates and operator runbook.", "Linux host/service account, DNS/TLS gateway, private networking, firewall and egress."),
              ("Architecture/data/security packet, application tests, bootstrap and rollback procedures.", "Harbor/Jenkins, mirrored third-party images, scan/sign/SBOM gate and five image digests."),
              ("Application support and fixes found during staged acceptance.", "Entra app registration, secret delivery, backup/restore, logging, alerts and change approval."),
          ], [264, 264]),
          Spacer(1, 10),
          p("Never place populated env files, passwords, robot secrets or the initial admin credential in email, tickets, images or a repository. The supplied Jenkins pipeline does not deploy or perform a complete security scan.", "SmallX"),
          PageBreak()]

# Page 4: call sheet.
story += [p("CALL SHEET / DECISION LOG", "KickerX"),
          p("Ask these questions first", "TitleX"),
          table(["Priority", "Question to Caltrans IT"], [
              ("1", "Podman pod or Kubernetes/OpenShift Pod? Can DB and S3 be stateful containers in it?"),
              ("1", "What data classification and network zone apply? Clean install or approved data import?"),
              ("1", "Who owns host, rootless service account, CPU/RAM/disk, patching and SELinux policy?"),
              ("1", "What are the web and file HTTPS names, gateway placement, certificates and firewall rules?"),
              ("1", "Which Entra tenant/cloud, Web app owner, callback, first admin object ID and credential policy?"),
              ("1", "Will security accept localStorage JWTs, 120-minute sessions and manual ERIS offboarding?"),
              ("1", "Who owns Harbor/Jenkins, image mirroring, digest pinning, scans, licenses, SBOMs and signing?"),
              ("1", "What are the matched backup target, retention, RPO/RTO and restore-test owner?"),
              ("1", "Is one host's service interruption acceptable, or is a failover target required?"),
              ("1", "Is browser 3D ArcGIS or Esri offline processing in scope? Who supplies the restricted API key?"),
              ("2", "Which Entra, GIS, SMTP and future mobile services may the host and clients reach?"),
              ("2", "Who owns SIEM, WAF/security headers, incident response, accessibility/privacy review and go-live approval?"),
          ], [47, 481]),
          Spacer(1, 12),
          p("Likely questions from IT", "SectionX"),
          table(["They may ask", "Your answer"], [
              ("Is it one image?", "No. One Podman pod, five containers, two persistent volumes."),
              ("Who provides images?", "Caltrans Jenkins builds our three images; IT mirrors MariaDB/SeaweedFS; host pulls approved Harbor digests."),
              ("SeaweedFS license?", "Upstream 4.50 source is Apache-2.0; IT must review the exact image and dependencies. Enterprise is not proposed."),
              ("Is it highly available?", "No. One host needs a tested matched backup and recovery plan."),
              ("Is Entra live already?", "Implemented and tested in code, but not validated against Caltrans's tenant; current Proxmox uses local login."),
              ("Is mobile ready?", "No Caltrans mobile release yet. Reserve API/S3 reachability; native Entra flow is future work."),
          ], [130, 398]),
          Spacer(1, 10),
          p("Take into the meeting: this handout, the editable technical packet, Podman runbook, Jenkinsfile, env templates (unpopulated), and a specific source commit. The Jenkins job needs a Linux Podman agent, Harbor access, its push credential and capacity for a 4 GiB Node heap. After decisions: circulate hostnames/ports, approved digests, a non-secret config worksheet and staged acceptance/restore evidence.", "SmallX"),
          ]

doc = SimpleDocTemplate(str(OUTPUT), pagesize=letter,
                        leftMargin=42, rightMargin=42, topMargin=42, bottomMargin=43,
                        title="ERIS Caltrans IT Deployment Briefing",
                        author="ERIS project")
doc.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
print(OUTPUT)
