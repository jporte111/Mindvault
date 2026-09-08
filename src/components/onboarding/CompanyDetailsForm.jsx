import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Building2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// Step 1 of guided setup — the company details your team sees. Writes go
// through the guarded updateTenantProfile backend function, which verifies
// the caller's tenant scope server-side (the client never sends a tenant id
// for its own workspace).
export default function CompanyDetailsForm({ tenant, onSaved }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [brandColor, setBrandColor] = useState('#7C3AED');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tenant) {
      setName(tenant.name || '');
      setLogoUrl(tenant.logo_url || '');
      setBrandColor(tenant.brand_color || '#7C3AED');
    }
  }, [tenant]);

  const save = async () => {
    if (!name.trim()) {
      toast.error('Enter your company name');
      return;
    }
    setSaving(true);
    try {
      await base44.functions.invoke('updateTenantProfile', {
        action: 'update',
        fields: {
          name: name.trim(),
          logo_url: logoUrl.trim(),
          brand_color: brandColor,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['client-setup-tenant'] });
      toast.success('Your details are saved.');
      await onSaved?.();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Could not save your details');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Building2 className="w-4 h-4 text-primary" />
          Company details
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          This is how your company appears to your team inside MindVault.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="company-name" className="text-sm">Company name</Label>
          <Input
            id="company-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your company name"
            className="bg-background h-11"
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company-logo" className="text-sm">Logo link</Label>
          <Input
            id="company-logo"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://… (a link to your logo image)"
            className="bg-background h-11"
          />
          <p className="text-xs text-muted-foreground/70">
            Optional — paste a web link to your logo and we'll show it to your team.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company-color" className="text-sm">Brand color</Label>
          <div className="flex items-center gap-3">
            <input
              id="company-color"
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-11 w-16 rounded-md border border-input bg-transparent cursor-pointer"
              aria-label="Brand color"
            />
            <span className="text-xs text-muted-foreground">
              Used for small accents. You can change it anytime.
            </span>
          </div>
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary hover:bg-primary/90 gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save company details
        </Button>
      </CardContent>
    </Card>
  );
}