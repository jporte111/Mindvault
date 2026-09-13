import { Bot, Cable } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Step-by-step instructions for pointing an AI assistant (Claude, ChatGPT,
// Cursor, or any MCP-capable client) at this app's MCP server. Reused by
// the employee Connect AI page and the company Connections page.
export default function ConnectInstructions() {
  const serverUrl = new URL('/api/mcp', window.location.origin).toString();

  return (
    <>
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
          <div className="p-3 rounded-lg bg-muted text-sm text-muted-foreground">
            Custom MCP apps in ChatGPT require <strong>Developer Mode</strong>,
            which is only offered on paid plans (Plus, Pro, Business,
            Enterprise, or Edu) and only on the ChatGPT website — a free
            account shows just the built-in app/plugin directory. On a
            Business or Enterprise workspace, an admin can also turn Developer
            Mode off org-wide; in that case ask your workspace admin. If
            Developer Mode isn&apos;t available to you, use the Claude, Cursor,
            or Custom tabs instead — they connect to the same MindVault server
            with no plan requirements.
          </div>
          <ol className="space-y-2 text-sm text-muted-foreground leading-relaxed list-decimal list-inside">
            <li>Open ChatGPT (web) and go to <strong>Apps</strong>.</li>
            <li>Enable <strong>Developer mode</strong> in Settings (under Connectors &rarr; Advanced, or Security and login). ChatGPT will warn that developer apps are intended for development and testing — only continue if you accept that.</li>
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
      "url": "${serverUrl}"
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
    </>
  );
}