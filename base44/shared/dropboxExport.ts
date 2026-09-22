import { jsPDF } from 'npm:jspdf@4.2.1';
import { redact } from './redact.ts';

// Dropbox backup of published knowledge sources. Renders one PDF per source
// and uploads it to the shared company Dropbox (connector type 'dropbox'),
// overwriting the previous copy so the folder always mirrors the CURRENT
// published version of every source. Business language only — no internal
// lifecycle terminology in the document itself.

const DROPBOX_FOLDER = '/Namaste/ADMIN';
const MARGIN = 48;
const PAGE_BOTTOM = 842 - MARGIN; // A4, points

function sanitizeFilename(s: string): string {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|#%{}$&@+=~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'Untitled source';
}

function buildSourcePdf(t: any): ArrayBuffer {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const maxW = doc.internal.pageSize.getWidth() - MARGIN * 2;
  let y = MARGIN;

  const ensure = (needed: number) => {
    if (y + needed > PAGE_BOTTOM) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const heading = (text: string) => {
    ensure(50);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    y += 10;
    doc.text(text, MARGIN, y);
    y += 7;
    doc.setDrawColor(203, 213, 225);
    doc.line(MARGIN, y, MARGIN + maxW, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(51, 65, 85);
  };

  const paragraph = (text: string) => {
    const lines = doc.splitTextToSize(String(text || ''), maxW);
    for (const line of lines) {
      ensure(16);
      doc.text(line, MARGIN, y);
      y += 15;
    }
    y += 6;
  };

  const list = (items: any[], numbered = false) => {
    (items || []).forEach((item, i) => {
      const label = numbered ? `${i + 1}.  ` : '•  ';
      const lines = doc.splitTextToSize(String(item || ''), maxW - 16);
      lines.forEach((line: string, li: number) => {
        ensure(16);
        doc.text((li === 0 ? label : '    ') + line, MARGIN, y);
        y += 15;
      });
    });
    y += 6;
  };

  const section = (title: string, items: any[], numbered = false) => {
    if (!items || items.length === 0) return;
    heading(title);
    list(items, numbered);
  };

  // Title block
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(15, 23, 42);
  const titleLines = doc.splitTextToSize(String(t.title || 'Untitled source'), maxW);
  for (const line of titleLines) {
    ensure(24);
    doc.text(line, MARGIN, y);
    y += 24;
  }
  y += 4;

  const metaBits = [
    t.topic_category,
    t.presenter ? `Presented by ${t.presenter}` : null,
    t.department,
    t.client_segment,
  ].filter(Boolean);
  if (metaBits.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(100, 116, 139);
    paragraph(metaBits.join('  •  '));
  }
  y += 4;

  if (t.summary) {
    heading('Overview');
    paragraph(t.summary);
  }
  section('Key Takeaways', t.key_takeaways);
  section('Step-by-Step Procedure', t.sop_steps, true);
  section('Decision Rules', t.decision_rules);
  section('Common Mistakes & Watch-outs', t.common_mistakes);
  section('Exceptions & Special Situations', t.exceptions);
  section('Prerequisites', t.prerequisites);
  section('Required Inputs', t.required_inputs);
  section('Deadlines & Timing', t.deadlines);
  section('Roles Involved', t.roles_involved);
  section('Approvals Required', t.approvers);
  section('Escalation Paths', t.escalation_paths);
  section('Prohibited Actions', t.prohibited_actions);
  section('Verification Checkpoints', t.verification_checkpoints);
  if (t.final_output) {
    heading('Expected Result');
    paragraph(t.final_output);
  }
  section('Software & Systems', t.software_systems);
  if (t.ai_knowledge_entry) {
    heading('Knowledge Entry');
    paragraph(t.ai_knowledge_entry);
  }

  return doc.output('arraybuffer') as ArrayBuffer;
}

// Exports the CURRENT published version of one knowledge source to the
// company Dropbox. Callers treat failures as best-effort only.
export async function exportSourceToDropbox(
  base44: any,
  versionId: string,
): Promise<{ ok: boolean; error?: string; dropboxPath?: string }> {
  const t = await base44.asServiceRole.entities.Training.get(versionId).catch(() => null);
  if (!t) return { ok: false, error: 'source_not_found' };
  if (t.is_archived === true) return { ok: false, error: 'source_archived' };
  if (t.is_active_version === false) return { ok: false, error: 'not_the_published_version' };

  const { accessToken } = await base44.asServiceRole.connectors.getConnection('dropbox');
  if (!accessToken) return { ok: false, error: 'dropbox_not_connected' };

  // One stable filename per logical source (lineage id suffix keeps
  // same-named sources from overwriting each other; re-publishes overwrite
  // the old PDF with the newest version).
  const shortId = String(t.root_source_id || t.id).slice(-6);
  const dropboxPath = `${DROPBOX_FOLDER}/${sanitizeFilename(t.title)} - ${shortId}.pdf`;

  // Make sure the folder exists; an existing folder is fine.
  await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: DROPBOX_FOLDER, autorename: false }),
  }).catch(() => null);

  const pdf = buildSourcePdf(t);
  const upload = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'overwrite', autorename: false, mute: false }),
      'Content-Type': 'application/octet-stream',
    },
    body: pdf,
  });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    return { ok: false, error: `dropbox_upload_failed: ${redact(detail.slice(0, 300))}` };
  }
  return { ok: true, dropboxPath };
}