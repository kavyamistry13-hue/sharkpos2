import { Printer } from 'lucide-react';
import { useAsync } from '../hooks/useAsync';
import { api } from '../services/api';
import { Badge, Button, Modal } from './ui';
import { dateTime, inr, cap } from '../utils/format';

export function InvoiceModal({ sale, onClose, footerExtra }) {
  const settings = useAsync(() => api.get('/settings'), []);
  const s = settings.data;
  return (
    <Modal open={!!sale} onClose={onClose} title={sale ? `Invoice ${sale.invoiceNo}` : ''}
      footer={<>{footerExtra}<Button variant="secondary" onClick={() => window.print()}><Printer className="size-4" aria-hidden="true" />Print</Button><Button onClick={onClose}>Done</Button></>}>
      {sale && (
        <div className="print-area mx-auto max-w-sm rounded-lg border border-line bg-white p-5 text-sm">
          <div className="text-center">
            <p className="text-lg font-extrabold">{s ? s.storeName : 'SHARKPOS AI'}</p>
            {s && <p className="text-xs text-muted">{s.storeAddress}{s.gstin ? ` · GSTIN ${s.gstin}` : ''}</p>}
          </div>
          <div className="my-3 flex justify-between border-y border-dashed border-line py-2 text-xs">
            <span><span className="text-muted">Invoice </span>{sale.invoiceNo}</span><span>{dateTime(sale.createdAt)}</span>
          </div>
          <p className="mb-2 text-xs text-muted">Cashier: {sale.employee}{sale.customer ? ` · Customer: ${sale.customer.name}` : ''}</p>
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Item</th><th className="pb-1 text-right font-medium">Qty</th><th className="pb-1 text-right font-medium">Amount</th></tr></thead>
            <tbody>{sale.items.map((i) => <tr key={i.productId}><td className="py-0.5 pr-2">{i.name}<span className="block text-[11px] text-muted num">{inr(i.unitPrice, 2)} each</span></td><td className="py-0.5 text-right num">{i.quantity}</td><td className="py-0.5 text-right num">{inr(i.total, 2)}</td></tr>)}</tbody>
          </table>
          <dl className="mt-3 space-y-1 border-t border-dashed border-line pt-2 num">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{inr(sale.subtotal, 2)}</dd></div>
            {sale.discount > 0 && <div className="flex justify-between"><dt className="text-muted">Discount{sale.discountApprovedBy ? ` (approved by ${sale.discountApprovedBy})` : ''}</dt><dd>−{inr(sale.discount, 2)}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd>{inr(sale.tax, 2)}</dd></div>
            <div className="flex justify-between border-t border-line pt-1.5 text-base font-extrabold"><dt>Total</dt><dd>{inr(sale.total, 2)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Paid by</dt><dd>{sale.paymentMethod.toUpperCase()}</dd></div>
          </dl>
          {sale.status !== 'completed' && <div className="mt-3 text-center"><Badge tone="warn">{cap(sale.status)}{sale.status === 'refunded' ? ` · ${inr(sale.refundAmount, 2)}` : ''}</Badge></div>}
          <p className="mt-4 text-center text-xs text-muted">{s ? s.invoiceFooter : ''}</p>
        </div>
      )}
    </Modal>
  );
}
