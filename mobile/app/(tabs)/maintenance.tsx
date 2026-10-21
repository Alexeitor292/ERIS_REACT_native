import { useCallback, useState } from "react";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiFetch } from "@/src/api/client";
import { maintenanceDetail, maintenanceWork, type MaintenanceDetail, type MaintenanceWorkItem } from "@/src/api/maintenanceWorkflows";
import { getToken } from "@/src/auth/tokenStore";
import { useUiSettings } from "@/src/ui/UiSettingsContext";

type Report = { title: string; description: string | null; district: string; county: string; route: string; post_mile: string };
type Evidence = { attachment_id: number; file_name: string; download_url: string; mime_type: string };
const labels: Record<string, string> = { APPROVE: "Complete review and continue", REQUEST_INFORMATION: "Ask reporter for information", MAINTENANCE: "Maintenance handles it — end review", GEOTECH: "Send to GeoTech", RESUBMIT: "Supply information and return for review", EDIT: "Edit report description", RESTART: "Restart with current district workflow" };

export default function MaintenanceScreen() {
  const { palette, textScale } = useUiSettings();
  const params = useLocalSearchParams<{ incident?: string }>();
  const [items, setItems] = useState<MaintenanceWorkItem[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [workflow, setWorkflow] = useState<MaintenanceDetail | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [description, setDescription] = useState("");
  const [choice, setChoice] = useState("");
  const [notes, setNotes] = useState("");
  const [group, setGroup] = useState<number | null>(null);
  const [groupTitle, setGroupTitle] = useState("");
  const [mine, setMine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = { color: palette.text, fontSize: 14 * textScale };
  const field = { borderWidth: 1, borderColor: palette.border, borderRadius: 8, padding: 10, color: palette.text, backgroundColor: palette.panel, fontSize: 14 * textScale };
  const card = { borderWidth: 1, borderColor: palette.border, borderRadius: 10, padding: 14, gap: 10, backgroundColor: palette.panel };
  const load = useCallback(async (id?: number) => {
    setBusy(true); setError("");
    try {
      const token = await getToken(); if (!token) return;
      const queue = await maintenanceWork(token); setItems(queue.items);
      if (id) {
        const [next, detail, files] = await Promise.all([maintenanceDetail(token, id), apiFetch<{ incident: Report }>(`/incidents/${id}`, { token }), apiFetch<{ items: Evidence[] }>(`/incidents/${id}/attachments`, { token })]);
        setWorkflow(next); setReport(detail.incident); setDescription(detail.incident.description || ""); setEvidence(files.items);
        setGroup(next.state.decision?.event_group_id || null); setGroupTitle(next.state.decision?.new_group_title || "");
        setSelected(id); setChoice(""); setNotes("");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load maintenance work"); }
    finally { setBusy(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(Number(params.incident) || undefined); }, [load, params.incident]));
  async function record() {
    if (!workflow || !selected || !choice || !notes.trim()) return;
    const perform = async () => {
      setBusy(true); setError("");
      try {
        const token = await getToken(); if (!token) return;
        await apiFetch(`/maintenance-work/incidents/${selected}/actions`, { token, method: "POST", body: JSON.stringify({ version: workflow.version, action: choice, notes,
          ...(['EDIT', 'RESUBMIT'].includes(choice) ? { description } : {}),
          ...(choice === 'GEOTECH' ? { event_group_id: group, new_group_title: group ? null : groupTitle.trim() || null } : {}),
        }) });
        await load(selected);
      } catch (e) { setError(e instanceof Error ? e.message : "Could not record action"); }
      finally { setBusy(false); }
    };
    if (choice === 'RESTART') Alert.alert("Restart review?", "This uses the current district workflow and starts reviews again. Earlier reviews remain in history.", [{ text: "Cancel", style: "cancel" }, { text: "Restart", onPress: () => void perform() }]);
    else await perform();
  }
  const options: string[] = [];
  if (workflow?.can_act) {
    if (workflow.step.kind === 'REVIEW' && !workflow.state.pending_outcome) options.push('APPROVE');
    if (workflow.step.allow_maintenance && (!workflow.state.pending_outcome || workflow.state.pending_outcome === 'MAINTENANCE')) options.push('MAINTENANCE');
    if (workflow.step.allow_geotech && (!workflow.state.pending_outcome || workflow.state.pending_outcome === 'GEOTECH')) options.push('GEOTECH');
    if (workflow.step.request_information) options.push('REQUEST_INFORMATION');
  }
  if (workflow?.can_resubmit) options.push('RESUBMIT');
  if (workflow?.can_edit) options.push('EDIT');
  if (workflow?.can_restart) options.push('RESTART');
  const press = (label: string, onPress: () => void, active = false) => <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={{ ...field, backgroundColor: active ? palette.panelSoft : palette.panel, borderColor: active ? palette.primary : palette.border }}><Text style={text}>{label}</Text></Pressable>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}><ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
    <Text style={{ ...text, fontSize: 22 * textScale, fontWeight: '700' }}>Maintenance work</Text>
    {busy && <ActivityIndicator color={palette.primary} />}{!!error && <Text accessibilityRole="alert" style={{ ...text, color: palette.danger }}>{error}</Text>}
    {press("Refresh", () => void load(selected || undefined))}
    {selected && workflow && report ? <>
      {press("← Back to reports", () => { setSelected(null); setWorkflow(null); setReport(null); })}
      <Text style={{ ...text, fontWeight: '700' }}>{report.title}</Text>
      <View style={card}><Text style={text}>District {Number(workflow.district)} · Workflow revision {workflow.revision}</Text>
        {workflow.steps.map((s, i) => <Text key={i} style={{ ...text, fontWeight: i === workflow.state.step_index ? '700' : '400' }}>{i + 1}. {s.name}{i < workflow.state.step_index ? ' ✓' : ''}</Text>)}
        <Text style={text}>{workflow.outcome ? workflow.outcome === 'GEOTECH' ? 'Sent to GeoTech' : 'Maintenance handles the repair' : workflow.state.waiting_reporter ? 'Waiting on reporter information' : workflow.step.rule === 'ALL' ? 'Every assigned person must agree' : 'Any assigned person may act'}</Text>
        <Text style={text}>Assigned: {workflow.assigned.map(p => `${p.full_name}${!p.is_active ? ' (inactive)' : ''}`).join(', ')}</Text>
        {!!workflow.state.approved_user_ids.length && <Text style={text}>{workflow.state.approved_user_ids.length} review(s) recorded.</Text>}
        {options.map(action => <View key={action}>{press(labels[action], () => setChoice(action), choice === action)}</View>)}
        {['EDIT', 'RESUBMIT'].includes(choice) && <><Text style={text}>Report description (updating restarts review)</Text><TextInput accessibilityLabel="Report description" multiline value={description} onChangeText={setDescription} style={{ ...field, minHeight: 100 }} /></>}
        {choice === 'GEOTECH' && <><Text style={text}>Incident Group</Text>{press("Create a new Incident Group", () => { if (!workflow.state.decision) setGroup(null); }, group === null)}{workflow.groups.map(g => <View key={g.id}>{press(g.title, () => { if (!workflow.state.decision) setGroup(g.id); }, group === g.id)}</View>)}{group === null && <TextInput accessibilityLabel="New Incident Group name" editable={!workflow.state.decision} placeholder="New group name (optional)" placeholderTextColor={palette.muted} value={groupTitle} onChangeText={setGroupTitle} style={field} />}</>}
        {!!choice && <><Text style={text}>Review notes / reason (required)</Text><TextInput accessibilityLabel="Review notes" multiline value={notes} onChangeText={setNotes} style={{ ...field, minHeight: 90 }} />{!!notes.trim() && press("Record action", () => void record())}</>}
      </View>
      <View style={card}><Text style={{ ...text, fontWeight: '700' }}>What was reported</Text><Text style={text}>{report.description || 'No description'}</Text><Text style={text}>{report.district} · {report.county} · {report.route} · PM {report.post_mile}</Text></View>
      <View style={card}><Text style={{ ...text, fontWeight: '700' }}>Evidence</Text>{!evidence.length && <Text style={text}>No evidence attached</Text>}{evidence.map(file => <Pressable key={file.attachment_id} accessibilityRole="link" onPress={() => void Linking.openURL(file.download_url)}>{file.mime_type?.startsWith('image/') && <Image source={{ uri: file.download_url }} resizeMode="contain" style={{ height: 190, width: '100%' }} />}<Text style={{ ...text, color: palette.primary }}>{file.file_name}</Text></Pressable>)}</View>
      <View style={card}><Text style={{ ...text, fontWeight: '700' }}>Review history</Text>{workflow.events.map(e => <View key={e.id}><Text style={text}>{labels[e.action] || e.action.replaceAll('_', ' ')} · {e.actor_name}</Text><Text style={{ ...text, color: palette.muted }}>{e.notes}</Text></View>)}</View>
    </> : <>{press(mine ? 'Showing: waiting on me' : 'Showing: all accessible reports', () => setMine(!mine))}{items.filter(i => !mine || i.my_turn).map(item => <View key={item.id}>{press(`${item.title}\nDistrict ${Number(item.district)} · ${item.outcome || (item.waiting_reporter ? 'Waiting on reporter' : item.step_name)}`, () => void load(item.id))}</View>)}{!items.some(i => !mine || i.my_turn) && <Text style={text}>No reports match this filter.</Text>}</>}
  </ScrollView></SafeAreaView>;
}
