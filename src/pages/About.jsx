import { BookOpen } from 'lucide-react';

export default function About() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10 md:py-16">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
          <BookOpen className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-3xl md:text-4xl font-sora font-bold text-foreground">About Knowledge Base</h1>
      </div>
      <div className="space-y-5 text-muted-foreground leading-relaxed">
        <p>
          Knowledge Base is an intelligent training repository built for boutique financial services firms. It transforms the knowledge captured in your team's Google Meet recordings—internal trainings, client reviews, and process walkthroughs—into a searchable, structured library your entire organization can learn from and act on.
        </p>
        <p>
          Instead of letting valuable training recordings sit idle in Drive, Knowledge Base automatically transcribes, summarizes, and organizes every session. It extracts standard operating procedures, decision rules, common mistakes, and key takeaways, so new team members ramp up faster and experienced staff can reference exact guidance in seconds.
        </p>
        <p>
          Beyond simple search, the platform powers a built-in AI assistant that answers questions grounded in your own training transcripts, plus a Product Strategy Engine that analyzes recurring workflows, pain points, and judgment-based decisions to surface new product and automation opportunities tailored to a boutique practice.
        </p>
        <p>
          Knowledge Base is built and maintained by the Base44 team, with a focus on helping financial practices turn everyday conversations into durable, actionable institutional knowledge.
        </p>
      </div>
    </div>
  );
}