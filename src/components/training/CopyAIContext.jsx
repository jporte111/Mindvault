import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Copy, Check } from 'lucide-react';

export default function CopyAIContext({ training }) {
  const [copied, setCopied] = useState(false);

  const buildContext = () => {
    const lines = [];
    lines.push(`# ${training.title}`);
    if (training.topic_category) lines.push(`Category: ${training.topic_category}`);
    if (training.client_segment) lines.push(`Client Segment: ${training.client_segment}`);
    lines.push('');

    if (training.summary) {
      lines.push('## Summary');
      lines.push(training.summary);
      lines.push('');
    }

    if (training.key_takeaways?.length) {
      lines.push('## Key Takeaways');
      training.key_takeaways.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
      lines.push('');
    }

    if (training.sop_steps?.length) {
      lines.push('## Step-by-Step SOP');
      training.sop_steps.forEach((s, i) => lines.push(`${i + 1}. ${s.replace(/^\d+\.\s*/, '')}`));
      lines.push('');
    }

    if (training.decision_rules?.length) {
      lines.push('## Decision Rules');
      training.decision_rules.forEach(r => lines.push(`→ ${r}`));
      lines.push('');
    }

    if (training.common_mistakes?.length) {
      lines.push('## Common Mistakes & Watchouts');
      training.common_mistakes.forEach(m => lines.push(`! ${m}`));
      lines.push('');
    }

    if (training.required_inputs?.length) {
      lines.push('## Required Inputs');
      training.required_inputs.forEach(inp => lines.push(`- ${inp}`));
      lines.push('');
    }

    if (training.final_output) {
      lines.push('## Final Output');
      lines.push(training.final_output);
      lines.push('');
    }

    if (training.app_feature_opportunities?.length) {
      lines.push('## App Feature Opportunities');
      training.app_feature_opportunities.forEach(f => {
        lines.push(`### ${f.feature_name} [${f.priority} Priority | ${f.facing}]`);
        lines.push(`Problem: ${f.problem_solved}`);
        lines.push(`Users: ${f.user_type}`);
        lines.push(`Inputs: ${f.required_inputs}`);
        lines.push(`Output: ${f.output}`);
        lines.push('');
      });
    }

    if (training.ai_knowledge_entry) {
      lines.push('## AI Knowledge Entry');
      lines.push(training.ai_knowledge_entry);
    }

    return lines.join('\n');
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(buildContext());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <Button variant="outline" size="sm" onClick={handleCopy} className="gap-2 text-xs">
      {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied!' : 'Copy AI Context'}
    </Button>
  );
}