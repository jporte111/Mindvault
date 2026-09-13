import { Bot } from 'lucide-react';
import ServerUrlCard from '@/components/connect/ServerUrlCard';
import ConnectInstructions from '@/components/connect/ConnectInstructions';

// Employee-facing AI connection instructions. Company admins get the same
// content on their Connections page alongside Google Drive.
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

      <ConnectInstructions />
    </div>
  );
}