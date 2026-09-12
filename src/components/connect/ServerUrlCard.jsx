import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// The MindVault MCP server URL, resolved from the current origin, with a
// one-click copy so it can be pasted straight into an AI client.
export default function ServerUrlCard() {
  const url = new URL('/api/mcp', window.location.origin).toString();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      /* clipboard unavailable — the URL is still selectable as text */
    }
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <p className="text-sm font-medium text-foreground">MindVault server URL</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <code className="flex-1 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground font-mono break-all select-all">
            {url}
          </code>
          <Button onClick={copy} variant="outline" className="h-11 px-4 shrink-0 gap-2">
            {copied ? (
              <>
                <Check className="w-4 h-4" aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" aria-hidden="true" />
                Copy
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}