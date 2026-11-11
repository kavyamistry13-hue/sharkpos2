import { useRef, useState } from 'react';
import { Download, FileUp, Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, uploadCsv, downloadCsv } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { Button, Modal, Badge } from './ui';

const MAX_BYTES = 5 * 1024 * 1024;

/** Upload → validate (preview, nothing saved) → confirm. The server re-validates on confirm and imports everything or nothing. */
export function CsvImportModal({ onClose, onImported }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (file) => {
    if (!file) return;
    setErr(''); setPv(null);
    if (file.size > MAX_BYTES) return setErr('This file is larger than 5 MB. Split it into smaller files.');
    if (!/\.csv$/i.test(file.name) && !/text|csv|excel/.test(file.type)) return setErr('Choose a .csv file. In Excel use File → Save As → CSV.');
    const t = await file.text();
    setText(t); setName(file.name); setBusy(true);
    try { setPv(await uploadCsv('/products/import/preview', t)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const r = await uploadCsv('/products/import', text);
      toast.success(`${r.imported} product${r.imported === 1 ? '' : 's'} imported.`); onImported(r);
    } catch (e) {
      // the server found something new (e.g. a duplicate added a moment ago): show its row-level errors, import nothing
      if (e.details && e.details.errors) setPv({ ok: false, fileErrors: e.details.fileErrors || [], summary: e.details.summary, errors: e.details.errors, sample: [] });
      setErr(e.message); setBusy(false);
    }
  };
  const reset = () => { setText(''); setName(''); setPv(null); setErr(''); if (fileRef.current) fileRef.current.value = ''; };

  return (
    <Modal open onClose={onClose} title="Import products from CSV" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{pv && <Button variant="secondary" onClick={reset} disabled={busy}>Choose another file</Button>}<Button onClick={confirm} disabled={!pv || !pv.ok || busy} loading={busy && !!pv} data-testid="confirm-import">{pv && pv.summary ? `Import ${pv.summary.valid} product${pv.summary.valid === 1 ? '' : 's'}` : 'Import'}</Button></>}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">Columns: <span className="num">name, sku, barcode, category, unit, cost_price, selling_price, tax_rate, min_stock, max_stock</span> (optional: reorder_level, stock). Required: name, category, selling_price. Nothing is saved until you confirm, and a single error stops the whole import.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => downloadCsv('/products/import/template', 'sharkpos-products-template.csv').catch((e) => toast.error(e.message))}><Download className="size-4" aria-hidden="true" />Download template</Button>
          <Button onClick={() => fileRef.current && fileRef.current.click()} loading={busy && !pv}><FileUp className="size-4" aria-hidden="true" />{name ? 'Replace file' : 'Choose CSV file'}</Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" data-testid="csv-file" onChange={(e) => pick(e.target.files && e.target.files[0])} />
        </div>
        <p className="rounded-lg bg-canvas px-3 py-2 text-xs text-muted">Keep leading zeros in barcodes: format that column as <b>Text</b> before saving, otherwise Excel drops the zeros. Tax comes from the category; a tax_rate that disagrees with it is reported.</p>
        {name && <p className="text-xs text-muted">File: <span className="font-semibold text-text">{name}</span></p>}
        {err && !pv && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 font-semibold text-bad">{err}</p>}
        {pv && (
          <div aria-live="polite" className="space-y-3">
            {pv.fileErrors && pv.fileErrors.length > 0 && <ul role="alert" className="list-disc space-y-1 rounded-lg bg-bad-soft py-2 pl-7 pr-3 font-semibold text-bad">{pv.fileErrors.map((m, i) => <li key={i}>{m}</li>)}</ul>}
            {pv.summary && <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{pv.summary.total} rows</Badge><Badge tone="ok" dot>{pv.summary.valid} ready</Badge>{pv.summary.invalid > 0 && <Badge tone="bad" dot>{pv.summary.invalid} with errors</Badge>}</div>}
            {pv.ok && <p className="flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 font-semibold text-ok"><CheckCircle2 className="size-5" aria-hidden="true" />Looks good. Review the sample, then confirm.</p>}
            {pv.errors && pv.errors.length > 0 && (
              <div className="rounded-lg border border-bad/30">
                <p className="flex items-center gap-2 border-b border-bad/30 bg-bad-soft px-3 py-2 font-semibold text-bad"><AlertTriangle className="size-4" aria-hidden="true" />Fix these rows and upload again — nothing has been imported.</p>
                <ul className="max-h-64 divide-y divide-line-soft overflow-y-auto" data-testid="import-errors">
                  {pv.errors.map((e) => <li key={e.line} className="px-3 py-2"><span className="font-bold">Line {e.line}:</span> {e.errors.join(' ')}</li>)}
                </ul>
                {pv.errorsTruncated && <p className="border-t border-line px-3 py-2 text-xs text-muted">Showing the first 200 problem rows.</p>}
              </div>
            )}
            {pv.sample && pv.sample.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs"><thead className="bg-canvas text-muted"><tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Barcode</th><th className="px-3 py-2 text-right">Price</th></tr></thead>
                  <tbody>{pv.sample.map((r) => <tr key={r.line} className="border-t border-line-soft"><td className="px-3 py-1.5">{r.line}</td><td className="px-3 py-1.5 font-semibold">{r.name}</td><td className="px-3 py-1.5 num">{r.sku || 'auto'}</td><td className="px-3 py-1.5 num">{r.barcode || '—'}</td><td className="px-3 py-1.5 text-right num">₹{r.sellingPrice}</td></tr>)}</tbody></table>
                {pv.summary.valid > pv.sample.length && <p className="border-t border-line px-3 py-1.5 text-xs text-muted">…and {pv.summary.valid - pv.sample.length} more.</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

const KINDS = [
  ['products', 'Products', ['business_owner', 'manager']], ['inventory', 'Inventory & stock value', ['business_owner', 'manager']],
  ['purchases', 'Purchase orders', ['business_owner', 'manager']], ['suppliers', 'Suppliers', ['business_owner', 'manager']],
  ['sales', 'Sales', ['business_owner']], ['customers', 'Customers & Udhaar', ['business_owner']],
];

/** Small "Export" menu. Lists only what the signed-in role may download; the API enforces it again. */
export function ExportMenu({ kinds, label = 'Export CSV' }) {
  const { user } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const list = KINDS.filter(([k, , roles]) => roles.includes(user && user.role) && (!kinds || kinds.includes(k)));
  const go = async (k) => {
    setBusy(k);
    try { await downloadCsv(`/exports/${k}`, `sharkpos-${k}.csv`); toast.success('Download started.'); setOpen(false); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  if (!list.length) return null;
  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><Upload className="size-4" aria-hidden="true" />{label}</Button>
      {open && (
        <>
          <button className="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onClick={() => setOpen(false)} />
          <ul role="menu" className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-line bg-white p-1 shadow-lg">
            {list.map(([k, l]) => <li key={k} role="none"><button role="menuitem" disabled={!!busy} onClick={() => go(k)} className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-medium hover:bg-line-soft disabled:opacity-60">{l}{busy === k && <span className="text-xs text-muted">…</span>}</button></li>)}
          </ul>
        </>
      )}
    </div>
  );
}
export { api };
