import { Bot, Cable } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import ServerUrlCard from '@/components/connect/ServerUrlCard';

// In-app instructions for pointing an AI assistant (Claude, ChatGPT, Cursor,
// or any MCP-capable client) at this app's MCP server. Static content — the
// URL card resolves the server address from the current origin at runtime.
export default function Connect() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10 md:py-16">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
          <Bot className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-3xl md:text-4xl font-sora font-bold text-foreground">
          Connect an AI assistant
        </h1>
      </div>

      <div className="space-y-4 text-muted-foreground leading-relaxed mb-8">
        <p>
          You can let AI assistants like Claude, ChatGPT, and Cursor answer
          questions from your MindVault knowledge and work with your app data
          on your behalf. Copy the server URL below, then follow the steps for
          your assistant.
        </p>
      </div>

      <div className="mb-8">
        <ServerUrlCard />
      </div>

      <Tabs defaultValue="claude">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4 mb-6">
          <TabsTrigger value="claude" className="min-h-[44px]">Claude</TabsTrigger>
          <TabsTrigger value="chatgpt" className="min-h-[44px]">ChatGPT</TabsTrigger>
          <TabsTrigger value="cursor" className="min-h-[44px]">Cursor</TabsTrigger>
          <TabsTrigger value="custom" className="min-h-[44px]">Custom</TabsTrigger>
        </TabsList>

        <TabsContent value="claude" className="space-y-3">
          <h2 className="font-sora font-semibold text-foreground">Claude</h2>
          <ol className="space-y-2 text-sm text-muted-foreground leading-relaxed list-decimal list-inside">
            <li>Open Claude and click your profile picture (top right) → <strong>Settings</strong>.</li>
            <li>Go to <strong>Connectors</strong> and click <strong>Add custom connector</strong>.</li>
            <li>Give it a name (e.g. &ldquo;MindVault&rdquo;), paste the server URL above, and click <strong>Add</strong>.</li>
            <li>Finish the connection using step 1 under &ldquo;One last step&rdquo; below.</li>
          </ol>
        </TabsContent>

        <TabsContent value="chatgpt" className="space-y-3">
          <h2 className="font-sora font-semibold text-foreground">ChatGPT</h2>
          <ol className="space-y-2 text-sm text-muted-foreground leading-relaxed list-decimal list-inside">
            <li>Open ChatGPT and go to <strong>Apps</strong>.</li>
            <li>Enable <strong>Developer mode</strong>. ChatGPT will warn that developer apps are intended for development and testing — only continue if you accept that.</li>
            <li>Click <strong>Create app</strong>, name it, paste the server URL above, and click <strong>Create</strong>.</li>
            <li>Enable the app from the chat composer (the + menu) before prompting it.</li>
            <li>Finish the connection using step 1 under &ldquo;One last step&rdquo; below.</li>
          </ol>
        </TabsContent>

        <TabsContent value="cursor" className="space-y-3">
          <h2 className="font-sora font-semibold text-foreground">Cursor</h2>
          <ol className="space-y-2 text-sm text-muted-foreground leading-relaxed list-decimal list-inside">
            <li>Open <strong>Settings</strong> → <strong>Tools &amp; Integrations</strong>.</li>
            <li>Click <strong>New MCP Server</strong> — this opens Cursor&apos;s <code className="text-xs bg-muted px-1 py-0.5 rounded">mcp.json</code> file.</li>
            <li>
              Add an entry pointing at the server URL above, save the file, and
              toggle the server on:
              <pre className="mt-2 rounded-lg bg-muted p-3 text-xs font-mono text-muted-foreground overflow-x-auto select-all">
{`{
  "mcpServers": {
    "mindvault": {
      "url": "${new URL('/api/mcp', window.location.origin).toString()}"
    }
  }
}`}
              </pre>
            </li>
            <li>Finish the connection using step 1 under &ldquo;One last step&rdquo; below.</li>
          </ol>
        </TabsContent>

        <TabsContent value="custom" className="space-y-3">
          <h2 className="font-sora font-semibold text-foreground">Custom client</h2>
          <ol className="space-y-2 text-sm text-muted-foreground leading-relaxed list-decimal list-inside">
            <li>Copy the server URL above.</li>
            <li>In your AI client, add it as a <strong>streamable HTTP</strong> MCP server — a name and the URL are all most clients need.</li>
            <li>Reload the client, then finish the connection using step 1 under &ldquo;One last step&rdquo; below.</li>
          </ol>
        </TabsContent>
      </Tabs>

      <div className="mt-10 space-y-3">
        <h2 className="font-sora font-semibold text-foreground">One last step</h2>
        <ul className="space-y-2 text-sm text-muted-foreground leading-relaxed">
          <li className="flex gap-2">
            <Cable className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" aria-hidden="true" />
            <span>
              The first time each assistant connects, it opens the MindVault
              authorization page. <strong>Sign in with your own MindVault account
              and approve</strong> — the assistant then acts only as you, and only
              with the access your account already has.
            </span>
          </li>
          <li className="flex gap-2">
            <Bot className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" aria-hidden="true" />
            <span>
              Assistants cache the list of available tools, so if we ship
              changes to the app, refresh or reconnect the connector to pick
              them up.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}