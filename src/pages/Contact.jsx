import { useState } from 'react';
import { Mail, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';

export default function Contact() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!message.trim()) {
      toast.error('Please enter a message.');
      return;
    }
    setLoading(true);
    try {
      await base44.functions.invoke('submitContactForm', { name, email, message });
      toast.success('Thanks! Your message has been sent.');
      setName('');
      setEmail('');
      setMessage('');
    } catch (err) {
      toast.error('Could not send message: ' + (err?.message || 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-8 py-10 md:py-16">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
          <Mail className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-3xl md:text-4xl font-sora font-bold text-foreground">Contact Us</h1>
      </div>
      <p className="text-muted-foreground mb-8 leading-relaxed">
        Have a question, feature request, or need a hand with your training repository? Send us a note and we'll get back to you.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="h-11" />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">Email</label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="h-11" />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">Message</label>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="How can we help?" rows={5} />
        </div>
        <Button type="submit" disabled={loading} className="gap-2">
          {loading ? 'Sending...' : (<><Send className="w-4 h-4" /> Send Message</>)}
        </Button>
      </form>
    </div>
  );
}