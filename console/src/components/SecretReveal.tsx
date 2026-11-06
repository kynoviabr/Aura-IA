import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BrandButton } from '@/components/ui/brand-button';

/** Mostra chaves recém-criadas UMA vez, com botão de copiar. */
export function SecretReveal({ open, onClose, title, items }: { open: boolean; onClose: () => void; title: string; items: { label: string; value: string }[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (v: string) => { await navigator.clipboard.writeText(v); setCopied(v); setTimeout(() => setCopied(null), 1500); };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Copie agora e guarde nos segredos do produto (Supabase → Edge Functions → Secrets). Por segurança, não mostramos de novo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {items.map((i) => (
            <div key={i.label} className="space-y-1">
              <p className="label-stripe">{i.label}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-subtle p-2 text-xs">{i.value}</code>
                <button className="rounded-btn p-2 hover:bg-muted" onClick={() => copy(i.value)} aria-label={`Copiar ${i.label}`}>
                  {copied === i.value ? <Check className="h-4 w-4 text-[hsl(var(--success))]" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          ))}
          <BrandButton className="w-full" onClick={onClose}>Já copiei</BrandButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
