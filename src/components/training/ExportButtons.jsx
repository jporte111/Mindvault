import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

export function exportSOP(training) {
  const lines = [];
  lines.push(`SOP: ${training.title}`);
  lines.push('='.repeat(60));
  if (training.topic_category) lines.push(`Category: ${training.topic_category}`);
  if (training.client_segment) lines.push(`Client Segment: ${training.client_segment}`);
  if (training.presenter) lines.push(`Presenter: ${training.presenter}`);
  lines.push('');

  if (training.summary) {
    lines.push('SUMMARY');
    lines.push('-'.repeat(40));
    lines.push(training.summary);
    lines.push('');
  }

  if (training.sop_steps?.length) {
    lines.push('STEP-BY-STEP PROCEDURE');
    lines.push('-'.repeat(40));
    training.sop_steps.forEach((s, i) => lines.push(`${i + 1}. ${s.replace(/^\d+\.\s*/, '')}`));
    lines.push('');
  }

  if (training.decision_rules?.length) {
    lines.push('DECISION RULES');
    lines.push('-'.repeat(40));
    training.decision_rules.forEach(r => lines.push(`→ ${r}`));
    lines.push('');
  }

  if (training.common_mistakes?.length) {
    lines.push('COMMON MISTAKES & WATCHOUTS');
    lines.push('-'.repeat(40));
    training.common_mistakes.forEach(m => lines.push(`! ${m}`));
    lines.push('');
  }

  if (training.required_inputs?.length) {
    lines.push('REQUIRED INPUTS');
    lines.push('-'.repeat(40));
    training.required_inputs.forEach(inp => lines.push(`- ${inp}`));
    lines.push('');
  }

  if (training.final_output) {
    lines.push('FINAL OUTPUT');
    lines.push('-'.repeat(40));
    lines.push(training.final_output);
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SOP - ${training.title}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExportSOPButton({ training }) {
  return (
    <Button variant="outline" size="sm" onClick={() => exportSOP(training)} className="gap-2 text-xs">
      <Download className="w-3.5 h-3.5" />
      Export SOP
    </Button>
  );
}