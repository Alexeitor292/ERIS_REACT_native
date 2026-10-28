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
    canvas.drawString(42, 29, "ERIS | Caltrans IT discussion copy | 28 Oct 2026")
    canvas.drawRightString(w - 42, 29, f"Page {doc.page}")
    canvas.restoreState()


story = []

# Page 1: the pitch and architecture.
story += [p("CALTRANS IT DISCUSSION / ARCHITECTURE", "KickerX"),
          p("ERIS deployment briefing", "TitleX"),
          p("One Linux Podman pod, five containers, two persistent data volumes. Staff sign in only through Caltrans Entra single sign-on, with no ERIS passwords. Caltrans owns the platform and security boundary; the ERIS team supplies application code and deployment artifacts."),
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
              ("Entra", "SSO only: no ERIS passwords. Web OIDC code + PKCE, single tenant. The API authenticates with a <b>certificate</b> (no client secret). ERIS roles are local; users link by tenant + object ID.", "Tenant/cloud, Web app, certificate issuer and rotation, first admin object ID. MFA via Conditional Access; Assignment required."),
              ("Mobile", "Native Swift iOS app (in development): MSAL via Microsoft Authenticator, public client, no secret. Server exchange to a revocable ERIS session is built.", "Register ERIS Mobile (iOS, bundle ID), SSO plug-in allow-list, distribution channel."),
              ("Sessions", "Server-side sessions in an HttpOnly, Secure, SameSite=Strict cookie that scripts cannot read; CSRF token on writes. 30 min idle / 12 h absolute. Per-device sign-out; admin revoke ends all.", "Confirm the limits. Disabling only in Entra blocks new sign-ins; offboarding also disables the ERIS account."),
              ("Files / TLS", "Private S3 buckets; 15-minute signed URLs. Internal pod traffic is localhost HTTP/TCP.", "TLS gateway, signed-URL forwarding, HSTS/CSP, rate limits/WAF, at-rest encryption and log redaction."),
              ("Supply chain", "All five images: CycloneDX SBOM, fixable HIGH/CRITICAL and secret gate (Trivy) before push, cosign signature and signed SBOM attestation. Hosts enforce signatures and pinned digests.", "Signing key owner, mirrored tool images, severity and exception approvals, digest approval."),
          ], [75, 224, 229], first_col_bold=True),
          Spacer(1, 11),
          callout("Implemented and tested in code, not yet approved by Caltrans: Entra-only sign-in, HttpOnly server-side sessions (OWASP), certificate client credential, signed and SBOM-attested images behind a vulnerability gate, and checksummed backup/restore. Each still needs a staging test in Caltrans's tenant and infrastructure."),
          Spacer(1, 10),
          p("First administrator and handover", "SubX"),
          p("Fresh install creates schema and roles, not demo users. One initial admin is seeded once from the Entra object ID IT supplies; ERIS refuses to set any password. Create and verify at least two named Entra admins (ERIS refuses to disable the last one), delete bootstrap.env, and record a passing eris-pod.sh handover-check."),
          p("Web callback: https://&lt;web-host&gt;/api/auth/entra/callback. iOS redirect (MSAL): msauth.&lt;bundle-id&gt;://auth, on the separate ERIS Mobile public client (iOS platform).", "SmallX"),
          PageBreak()]

# Page 3: release and handoffs.
story += [p("DELIVERY / ACCEPTANCE", "KickerX"),
          p("How the deployment would go", "TitleX"),
          table(["Step", "Work and evidence"], [
              ("1. Decide", "Agree Podman interpretation, data scope, host/storage, gateway names, Entra policy, Harbor/Jenkins gates, security review and recovery targets."),
              ("2. Stage", "Caltrans provisions Linux/rootless Podman, two volumes, DNS/TLS gateway, firewall/egress, Entra test registration, Harbor/Jenkins and backup target."),
              ("3. Build", "Jenkins builds API, worker and web from an immutable commit; all five images (with IT's MariaDB/SeaweedFS mirrors) pass the SBOM and vulnerability gate, then are pushed, signed and attested. IT approves the five digests."),
              ("4. Configure", "IT supplies runtime secrets and the Entra client certificate through its approved channel and installs the signature policy. Set exact web, S3 and callback URLs."),
              ("5. Install", "eris-pod.sh pull (signatures enforced), then up: schema, Alembic, private buckets, one Entra-linked admin, five containers. cert-check confirms the certificate."),
              ("6. Prove", "verify-rehearsal.sh in production mode, then manual: Entra linked/unknown/unassigned/disabled users and MFA, mobile sign-in, upload and signed download, restart, reboot, backup/restore, rollback."),
              ("7. Handover", "Two named Entra admins, passing handover-check, rotated handover secrets, monitoring/support owners. Production release: the staging-proven digests, after approval."),
          ], [83, 445], first_col_bold=True),
          Spacer(1, 12),
          p("Who hands over what", "SectionX"),
          table(["ERIS team supplies", "Caltrans IT supplies / approves"], [
              ("Approved source commit, Jenkinsfile, Podman scripts, env templates and operator runbook.", "Linux host/service account, DNS/TLS gateway, private networking, firewall and egress."),
              ("Architecture/data/security packet, application tests, bootstrap and rollback procedures.", "Harbor/Jenkins, cosign key, mirrored third-party and tool images, gate exceptions and five digests."),
              ("Application support and fixes found during staged acceptance.", "Entra web and mobile registrations, client certificate, backup/restore, logging, alerts and change approval."),
          ], [264, 264]),
          Spacer(1, 10),
          p("Never place populated env files, private keys, robot secrets or the cosign key in email, tickets, images or a repository. Releases: one command per host (eris-pod.sh release) pulls signed digests, backs up, migrates, verifies and rolls back by itself on failure. Jenkins can trigger it to staging, then production after approval, through a forced-command SSH key with no shell.", "SmallX"),
          PageBreak()]

# Page 4: call sheet.
story += [p("CALL SHEET / DECISION LOG", "KickerX"),
          p("Ask these questions first", "TitleX"),
          table(["Priority", "Question to Caltrans IT"], [
              ("1", "Podman pod or Kubernetes/OpenShift Pod? Can DB and S3 be stateful containers in it?"),
              ("1", "What data classification and network zone apply? Clean install or approved data import?"),
              ("1", "Who owns host, rootless service account, CPU/RAM/disk, patching and SELinux policy?"),
              ("1", "What are the web and file HTTPS names, gateway placement, certificates and firewall rules?"),
              ("1", "Which Entra tenant/cloud, Web app owner, callback, first admin object ID, client certificate issuer and rotation?"),
              ("1", "Do 30-minute idle / 12-hour sessions meet policy? Who disables ERIS accounts at offboarding?"),
              ("1", "Who owns Harbor/Jenkins, the cosign key, gate exceptions? May Jenkins release over SSH, and who approves production?"),
              ("1", "What are the matched backup target, retention, RPO/RTO and restore-test owner?"),
              ("1", "Is one host's service interruption acceptable, or is a failover target required?"),
              ("1", "Is browser 3D ArcGIS or Esri offline processing in scope? Who supplies the restricted API key?"),
              ("2", "iOS app: compliant-device CA for ERIS, SSO allow-list, ERIS Mobile, enterprise profile renewal, APNs key, egress."),
              ("2", "Who owns SIEM, WAF/security headers, incident response, accessibility/privacy review and go-live approval?"),
          ], [47, 481]),
          Spacer(1, 12),
          p("Likely questions from IT", "SectionX"),
          table(["They may ask", "Your answer"], [
              ("Is it one image?", "No. One Podman pod, five containers, two persistent volumes."),
              ("Who provides images?", "Caltrans Jenkins builds our three; IT mirrors MariaDB/SeaweedFS. All five are gated, signed and pulled by digest."),
              ("SeaweedFS license?", "Upstream 4.50 source is Apache-2.0; IT must review the exact image and dependencies. Enterprise is not proposed."),
              ("Is it highly available?", "No. One host needs a tested matched backup and recovery plan."),
              ("Do people use passwords?", "No. Entra SSO only; MFA and device rules come from Caltrans Conditional Access."),
              ("Is Entra live already?", "Implemented and tested in code, not yet against Caltrans's tenant; the Proxmox rehearsal has no Entra."),
              ("Is mobile ready?", "Not yet: native Swift iPhone app (MSAL, APNs push) via Intune/Company Portal. Server side is done."),
          ], [130, 398]),
          Spacer(1, 10),
          p("Take into the meeting: this handout, the technical packet, Podman runbook, readiness audit, Jenkinsfile, env templates (unpopulated) and a specific source commit. The Jenkins job needs a Linux Podman agent, Harbor push robot, cosign key credentials and a 4 GiB Node heap. After decisions: hostnames/ports, signed digests with SBOMs, a non-secret config worksheet and staged acceptance/restore evidence.", "SmallX"),
          ]

doc = SimpleDocTemplate(str(OUTPUT), pagesize=letter,
                        leftMargin=42, rightMargin=42, topMargin=42, bottomMargin=43,
                        title="ERIS Caltrans IT Deployment Briefing",
                        author="ERIS project")
doc.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
print(OUTPUT)
