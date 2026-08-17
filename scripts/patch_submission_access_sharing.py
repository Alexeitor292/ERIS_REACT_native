from pathlib import Path

path = Path("web/src/pages/SubmissionDetailPage.tsx")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        'import type { GisaElevationProfile, GisaLookups, GisaTerrainGrid, SubmissionDetail } from "../api/types";\n',
        'import type { GisaElevationProfile, GisaLookups, GisaTerrainGrid, SubmissionDetail, SubmissionPermissionGrant, SubmissionPermissions, SubmissionPermissionUser } from "../api/types";\n',
        "api type import",
    ),
    (
        'import SubmissionReviewerSupport from "../features/submissions/SubmissionReviewerSupport";\n',
        'import SubmissionReviewerSupport from "../features/submissions/SubmissionReviewerSupport";\nimport SubmissionAccessSharing from "../features/submissions/SubmissionAccessSharing";\n',
        "access sharing import",
    ),
    (
        '  type AdminUser,\n',
        '',
        "legacy AdminUser import",
    ),
    (
        '  type SharedUser,\n',
        '',
        "legacy SharedUser import",
    ),
    (
        '  const [shareCandidates, setShareCandidates] = useState<AdminUser[]>([]);\n  const [sharedWith, setSharedWith] = useState<SharedUser[]>([]);\n',
        '  const [shareCandidates, setShareCandidates] = useState<SubmissionPermissionUser[]>([]);\n  const [sharedWith, setSharedWith] = useState<SubmissionPermissionGrant[]>([]);\n',
        "sharing state types",
    ),
    (
        '  const canManageSharing = !!me?.roles?.includes("ADMIN");\n',
        '  const canManageSharing = data?.submission.can_manage_permissions === true;\n',
        "backend sharing capability",
    ),
    (
        '  useEffect(() => { if (!invalid) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sid, canManageSharing]);\n',
        '  useEffect(() => { if (!invalid) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sid]);\n',
        "load effect dependency",
    ),
]

for old, new, label in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one {label}; found {count}")
    text = text.replace(old, new, 1)

old_load = '''      if (canManageSharing) {
        const sharedRes = await api<{ items: SharedUser[] }>(`/submissions/${sid}/shared-with`);
        setSharedWith(sharedRes.items ?? []);
      } else {
        setSharedWith([]);
      }
'''
new_load = '''      const loadedCanManageSharing = d.submission.can_manage_permissions === true;
      if (loadedCanManageSharing) {
        const permissions = await api<SubmissionPermissions>(`/submissions/${sid}/permissions`);
        setShareCandidates(permissions.available_users ?? []);
        setSharedWith(permissions.readers ?? []);
      } else {
        setShareCandidates([]);
        setSharedWith([]);
      }
'''
if text.count(old_load) != 1:
    raise SystemExit(f"Expected exactly one legacy sharing load block; found {text.count(old_load)}")
text = text.replace(old_load, new_load, 1)

search_start = '  async function searchShareCandidates() {\n'
add_start = '  async function addShare(userId: number) {\n'
if text.count(search_start) != 1 or text.count(add_start) != 1:
    raise SystemExit("Could not uniquely locate legacy share-search function boundaries")
start = text.index(search_start)
end = text.index(add_start, start)
legacy_search = text[start:end]
if '/admin/users?q=' not in legacy_search:
    raise SystemExit("Legacy sharing search no longer uses the expected admin directory endpoint")
text = text[:start] + text[end:]

section_start = '            {canManageSharing && (\n              <Section title="Access Sharing">\n'
section_end = '            )}\n          </div>\n        )}\n'
if text.count(section_start) != 1:
    raise SystemExit(f"Expected one Access Sharing section start; found {text.count(section_start)}")
start = text.index(section_start)
end = text.index(section_end, start)
legacy_section = text[start:end + len('            )}\n')]
for required in ['Search users by email or name', 'Grant Access', 'Users with explicit access', 'Revoke']:
    if required not in legacy_section:
        raise SystemExit(f"Legacy Access Sharing section missing expected marker: {required}")
replacement_section = '''            {canManageSharing ? (
              <SubmissionAccessSharing
                query={shareQuery}
                availableUsers={shareCandidates}
                sharedWith={sharedWith}
                busy={busy}
                onQueryChange={setShareQuery}
                onGrant={addShare}
                onRevoke={removeShare}
              />
            ) : null}
'''
text = text[:start] + replacement_section + text[end + len('            )}\n'):]

checks = {
    'SubmissionAccessSharing import': 'SubmissionAccessSharing from "../features/submissions/SubmissionAccessSharing"',
    'backend capability': 'data?.submission.can_manage_permissions === true',
    'submission permissions directory': '`/submissions/${sid}/permissions`',
    'sharing component': '<SubmissionAccessSharing',
}
for label, marker in checks.items():
    if text.count(marker) != 1:
        raise SystemExit(f"Expected exactly one {label}; found {text.count(marker)}")

for forbidden in [
    '/admin/users?q=',
    '<Section title="Access Sharing">',
    'searchShareCandidates',
    'type AdminUser,',
    'type SharedUser,',
]:
    if forbidden in text:
        raise SystemExit(f"Legacy sharing marker is still present: {forbidden}")

path.write_text(text, encoding="utf-8")
