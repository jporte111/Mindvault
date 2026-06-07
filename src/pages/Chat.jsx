import { Link } from 'react-router-dom';
import { Sparkles, BookOpen, Zap, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Chat() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <div className="max-w-lg w-full text-center">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-5">
          <Sparkles className="w-8 h-8 text-primary" />
        </div>
        <h1 className="font-sora text-2xl font-bold text-foreground mb-3">AI Assistant</h1>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-left">
          <p className="text-amber-800 text-sm font-medium mb-1">Requires Builder+ Subscription</p>
          <p className="text-amber-700 text-sm leading-relaxed">
            AI Assistant requires Builder+ backend functions. Until enabled, use Library search, App Roadmap, and Copy AI Context.
          </p>
        </div>

        <p className="text-muted-foreground text-sm mb-6 leading-relaxed">
          In the meantime, you can manually query any training by copying its AI context and pasting it into ChatGPT or another AI tool.
        </p>

        <div className="flex flex-col gap-3">
          <Link to="/library">
            <Button variant="outline" className="w-full gap-2">
              <BookOpen className="w-4 h-4" />
              Browse Library &amp; Search All Trainings
            </Button>
          </Link>
          <Link to="/roadmap">
            <Button variant="outline" className="w-full gap-2">
              <Zap className="w-4 h-4" />
              View App Roadmap
            </Button>
          </Link>
          <div className="bg-muted/50 rounded-xl p-4 text-left">
            <div className="flex items-center gap-2 mb-1">
              <Copy className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-foreground">Copy AI Context</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Open any training in the Library and click "Copy AI Context" to get a full structured text block you can paste directly into ChatGPT.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}