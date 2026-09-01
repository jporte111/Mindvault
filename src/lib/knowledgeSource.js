// Knowledge Source type + format vocabulary for the ingestion UI.
//
// CANONICAL source-type values live in base44/entities/Training.jsonc
// (`source_type.enum`). They are duplicated here and in
// base44/functions/syncFromDrive/entry.ts (`KNOWN_SOURCE_TYPES`) because the
// Vite frontend and the Deno backend cannot safely share a module across those
// runtime boundaries in Phase 1. This duplication is temporary;
// scripts/rag-eval/source-types.test.mjs enforces parity between the three.
//
// `legacy_unspecified` is deliberately NOT offered in the picker — it is only
// ever set by a future backfill for records whose type cannot be determined.
// New knowledge added through the UI must have an explicit type chosen.
//
// This UI accepts a text artifact (a transcript or a document). It does not
// accept audio or video uploads, and none is being added in this phase. PDF is
// excluded (unverified extraction) and legacy binary Word is excluded (only
// .docx extraction is verified).

export const SOURCE_TYPE_OPTIONS = [
  { value: 'recording', label: 'Meeting or training session' },
  { value: 'transcript', label: 'Transcript' },
  { value: 'sop', label: 'SOP document' },
  { value: 'process_doc', label: 'Process document' },
  { value: 'policy', label: 'Policy' },
  { value: 'checklist', label: 'Checklist' },
  { value: 'reference', label: 'Reference document' },
  { value: 'other', label: 'Other' },
];

export const SUPPORTED_UPLOAD_EXTENSIONS = ['.txt', '.md', '.vtt', '.srt', '.docx'];
export const SUPPORTED_UPLOAD_ACCEPT = SUPPORTED_UPLOAD_EXTENSIONS.join(',');
export const SUPPORTED_UPLOAD_HINT = 'Click to upload a .txt, .md, .vtt, .srt, or .docx file';

export function formatFromFilename(name = '') {
  const n = String(name).toLowerCase();
  if (n.endsWith('.docx')) return 'docx';
  if (n.endsWith('.md')) return 'md';
  if (n.endsWith('.vtt')) return 'vtt';
  if (n.endsWith('.srt')) return 'srt';
  if (n.endsWith('.txt')) return 'txt';
  return 'other';
}
